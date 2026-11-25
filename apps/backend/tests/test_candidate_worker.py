import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from inspect import signature
from pathlib import Path

import pytest

from codehead.clinic.files import ROLE_PATHS, text_hash, tree_hash
from codehead.clinic.profile import load_profile
from codehead.clinic.workspace import materialize
from codehead.contracts import CreateProject, DecisionResolution, RunCommand, RunLimits, StartRun
from codehead.errors import DomainError
from codehead.llm.provider import ArtifactDraft, ProviderFailure
from codehead.llm.test_provider import TestProvider
from codehead.persistence.models import AgentRun, Candidate, Run, Task, WorkerHeartbeat
from codehead.persistence.service import ProjectService
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService


class Clock:
    def __init__(self):
        self.value = datetime.now(UTC)

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)


def create_run(database, *, parallel=2, mode="test", legacy=False):
    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Candidate clinic", description="Synthetic clinic appointments."),
        "candidate-worker-project",
    )
    run = service.start_run(
        project.id,
        StartRun(
            workflow_version="clinic-v2", mode=mode, limits=RunLimits(max_parallel_tasks=parallel)
        ),
        "candidate-worker-run",
        "candidate-worker",
    )
    if legacy:
        with database.sessions.begin() as session:
            persisted = session.get(Run, run.id)
            persisted.workflow_version = "clinic-v1"
            persisted.profile_version = None
            persisted.profile_hash = None
            persisted.acceptance_suite_hash = None
        run = service.snapshot(run.id).run
    return service, run


def approve_architecture(service, run, worker):
    for _ in range(3):
        assert worker.run_once()
    before = service.snapshot(run.id)
    assert before.candidate is None
    assert len(before.agent_runs) == 3
    assert {artifact.artifact_type for artifact in before.artifacts} == {
        "requirements",
        "architecture",
        "api_contract",
        "decision",
    }
    decision = next(item for item in before.decisions if item.kind == "architecture_approval")
    service.resolve_decision(
        decision.id,
        DecisionResolution(version=decision.version, choice="approve"),
        "candidate-worker-approval",
        "candidate-worker",
    )


@pytest.mark.parametrize("mode", ["test", "live"])
def test_new_runs_pin_clinic_v2_profile_and_suite_before_worker(database, mode):
    service, run = create_run(database, mode=mode)
    profile = load_profile()
    assert run.workflow_version == "clinic-v2"
    assert (run.profile_version, run.profile_hash, run.acceptance_suite_hash) == (
        profile.id,
        profile.profile_hash,
        profile.suite_hash,
    )
    assert service.snapshot(run.id).candidate is None
    created = service.events(run.id).events[0]
    assert created.payload.run.profile_hash == profile.profile_hash
    assert created.payload.run.acceptance_suite_hash == profile.suite_hash
    assert run.template_hash == created.payload.run.template_hash == profile.template_hash
    if mode == "live":
        assert WorkerService(database).claim("unconfigured-live") is None
        snapshot = service.snapshot(run.id)
        assert "Live" in snapshot.run.blocked_reason
        assert snapshot.agent_runs == []
        assert snapshot.candidate is None


def test_saved_clinic_v1_retains_three_role_source_boundary(database):
    service, run = create_run(database, legacy=True)
    engine = WorkerService(database)
    approve_architecture(service, run, Worker(engine, owner="legacy-worker"))
    assert engine.claim("legacy-worker") is None
    snapshot = service.snapshot(run.id)
    assert snapshot.run.workflow_version == "clinic-v1"
    assert "Backend/Frontend" in snapshot.run.blocked_reason
    assert len(snapshot.agent_runs) == 3
    assert snapshot.candidate is None
    assert all(agent.lifecycle == "offline" for agent in snapshot.agents[3:])


def test_template_replacement_after_start_is_blocked_before_source_dispatch(database):
    service, run = create_run(database)
    engine = WorkerService(database)
    approve_architecture(service, run, Worker(engine, owner="template-original"))
    files = list(engine.profile.template_files)
    content = files[0].content + "\n# Changed trusted template\n"
    files[0] = replace(files[0], content=content, content_hash=text_hash(content))
    changed = replace(
        engine.profile,
        template_files=tuple(files),
        template_hash=tree_hash({file.relative_path: file.content_hash for file in files}),
    )
    from codehead.persistence.candidates import CandidateStore

    restarted = WorkerService(database)
    restarted.profile = changed
    restarted.candidates = CandidateStore(changed, clock=restarted.clock)
    assert restarted.claim("template-restarted") is None
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert len(snapshot.agent_runs) == 3
    assert snapshot.candidate is None


@pytest.mark.parametrize("parallel", [1, 2])
def test_source_leases_are_independent_and_respect_run_parallel_limit(database, parallel):
    service, run = create_run(database, parallel=parallel)
    engine = WorkerService(database)
    approve_architecture(service, run, Worker(engine, owner="document-worker"))
    first = engine.claim("source-backend")
    assert first is not None, "Clinic v2 must claim source generation after CTO approval"
    assert first.request.role == "backend"
    second = engine.claim("source-frontend")
    assert (second is not None) == (parallel == 2)
    initial = service.snapshot(run.id)
    assert initial.candidate.revision == 1
    assert initial.candidate.status == "assembling"
    for lease in (first, second):
        if lease is None:
            continue
        assert lease.request.max_output_tokens == 65536
        assert lease.provider.model == "clinic-fixture-v2"
        assert {item["artifact_type"] for item in lease.request.inputs} == {
            "requirements",
            "architecture",
            "api_contract",
            "decision",
        }
        assert {item["relative_path"] for item in lease.request.candidate_files} == ROLE_PATHS[
            lease.request.role
        ]
        assert all(item["base_hash"] is None for item in lease.request.candidate_files)
        assert engine.begin(lease)
        assert engine.heartbeat(lease) is None
    active = service.snapshot(run.id)
    for role in ("backend", "frontend"):
        agent = next(item for item in active.agents if item.role == role)
        assert agent.instructions_version == "worker-test-v2"
        assert agent.allowed_operations == ["read_inputs", "propose_files"]
        if role == "backend" or parallel == 2:
            assert (agent.lifecycle, agent.activity, agent.location) == (
                "busy",
                "coding",
                "development",
            )
    engine.finish(first, first.provider.run(first.request))
    if second is None:
        second = engine.claim("source-frontend")
        assert second is not None
        assert engine.begin(second)
    assert second.request.role == "frontend"
    assert second.input_versions == first.input_versions
    assert all(item["artifact_type"] != "source_code" for item in second.request.inputs)
    engine.finish(second, second.provider.run(second.request))
    snapshot = service.snapshot(run.id)
    assert len(snapshot.agent_runs) == 5
    assert all(item.status == "succeeded" for item in snapshot.tasks[:5])
    assert snapshot.candidate.revision == 3
    assert snapshot.candidate.status == "materializing"
    assert snapshot.run.status == "running"
    own_files = [item for item in snapshot.candidate.files if item.producer_role is not None]
    assert {item.relative_path for item in own_files} == ROLE_PATHS["backend"] | ROLE_PATHS[
        "frontend"
    ]
    assert all(item.origin == "test_injected" and item.source == "test" for item in own_files)
    assert all(item.input_versions == first.input_versions for item in own_files)
    assert service.events(run.id).events[-1].payload.candidate == snapshot.candidate


def test_source_rejects_stale_fence_without_applying_any_files(database):
    from codehead.errors import DomainError

    service, run = create_run(database)
    engine = WorkerService(database)
    approve_architecture(service, run, Worker(engine, owner="document-worker"))
    lease = engine.claim("source-worker")
    assert lease is not None
    engine.begin(lease)
    before = service.snapshot(run.id)
    with pytest.raises(DomainError, match="lease"):
        engine.finish(
            replace(lease, fencing_token=lease.fencing_token + 1),
            lease.provider.run(lease.request),
        )
    after = service.snapshot(run.id)
    assert after.candidate == before.candidate
    assert after.artifacts == before.artifacts


def source_ready(database, **kwargs):
    service, run = create_run(database)
    engine = WorkerService(database, **kwargs)
    approve_architecture(service, run, Worker(engine, owner="document-worker"))
    lease = engine.claim("source-worker")
    assert lease is not None
    assert engine.begin(lease)
    return service, run, engine, lease


def test_file_conflict_is_atomic_and_retry_requeues_only_source_task(database):
    service, run, engine, lease = source_ready(database)
    original = lease.provider.run(lease.request)
    before = service.snapshot(run.id)
    conflicting = replace(
        original,
        files=(original.files[0].model_copy(update={"base_hash": "a" * 64}), *original.files[1:]),
    )
    engine.finish(lease, conflicting)
    conflict = service.snapshot(run.id)
    assert conflict.artifacts == before.artifacts
    assert conflict.candidate.revision == before.candidate.revision
    assert conflict.candidate.files == before.candidate.files
    assert conflict.candidate.status == "conflict"
    assert conflict.tasks[3].status == "waiting_for_decision"
    failed = next(item for item in conflict.agent_runs if item.id == lease.attempt_id)
    assert failed.status == "failed"
    assert failed.finished_at is not None
    assert failed.error_code == "file_version_conflict"
    assert failed.stop_reason == "stop"
    assert (failed.cost_usd, failed.input_tokens, failed.output_tokens) == (0, 0, 0)
    assert service.attempt_trace(failed.id).raw_response
    decision = next(item for item in conflict.decisions if item.status == "open")
    assert decision.kind == "file_conflict"
    assert decision.choices == ["retry_files", "reject"]
    assert before.candidate.manifest_artifact_id in decision.artifact_ids
    assert service.events(run.id).events[-1].payload.candidate == conflict.candidate
    peer_before = conflict.tasks[4]
    service.resolve_decision(
        decision.id,
        DecisionResolution(version=1, choice="retry_files"),
        "retry-source-files",
        "candidate-worker",
    )
    assert service.snapshot(run.id).tasks[4] == peer_before
    fresh = engine.claim("retry-source-worker")
    assert fresh.request.role == "backend"
    assert fresh.attempt_id != lease.attempt_id
    assert fresh.fencing_token > lease.fencing_token
    engine.begin(fresh)
    engine.finish(fresh, fresh.provider.run(fresh.request))
    after = service.snapshot(run.id)
    retry = next(item for item in after.agent_runs if item.id == fresh.attempt_id)
    assert retry.retry_of_attempt_id == failed.id
    assert retry.decision_id == decision.id
    assert next(item for item in after.agent_runs if item.id == failed.id) == failed
    assert after.tasks[2].status == "succeeded"
    assert after.tasks[3].status == "succeeded"
    assert len([item for item in after.agent_runs if item.task_id == after.tasks[2].id]) == 1


def test_file_retry_pins_only_current_own_source_bases(database):
    service, run, engine, lease = source_ready(database)
    original = lease.provider.run(lease.request)
    with database.sessions.begin() as session:
        persisted = service._run(session, run.id, for_update=True)
        task = session.get(Task, lease.task_id)
        attempt = session.get(AgentRun, lease.attempt_id)
        engine.candidates.apply(
            session, persisted, task, attempt, original.files, input_versions=lease.input_versions
        )
        service._emit_workflow(session, persisted, "candidate.base_updated")
    current = service.snapshot(run.id).candidate
    engine.finish(lease, original)
    conflict = service.snapshot(run.id)
    decision = next(item for item in conflict.decisions if item.kind == "file_conflict")
    own = [file for file in current.files if file.relative_path in ROLE_PATHS["backend"]]
    assert {file.artifact_id for file in own} <= set(decision.artifact_ids)
    service.resolve_decision(
        decision.id,
        DecisionResolution(version=1, choice="retry_files"),
        "retry-current-files",
        "candidate-worker",
    )
    fresh = engine.claim("fresh-current-files")
    sources = [item for item in fresh.request.inputs if item["artifact_type"] == "source_code"]
    assert {item["id"] for item in sources} == {file.artifact_id for file in own}
    assert {item["relative_path"] for item in sources} == ROLE_PATHS["backend"]
    assert fresh.input_versions == lease.input_versions | {
        file.artifact_id: file.version for file in own
    }
    for base in fresh.request.candidate_files:
        file = next(item for item in own if item.relative_path == base["relative_path"])
        assert (base["base_hash"], base["artifact_id"], base["version"]) == (
            file.content_hash,
            file.artifact_id,
            file.version,
        )
    engine.begin(fresh)
    engine.finish(fresh, fresh.provider.run(fresh.request))
    latest = service.snapshot(run.id).candidate
    for file in latest.files:
        if file.relative_path in ROLE_PATHS["backend"]:
            parent = next(item for item in own if item.relative_path == file.relative_path)
            assert file.parent_artifact_id == parent.artifact_id
            assert file.parent_hash == parent.content_hash
            assert file.version == parent.version + 1


def test_rejected_file_conflict_has_a_source_specific_reason(database):
    service, run, engine, lease = source_ready(database)
    result = lease.provider.run(lease.request)
    engine.finish(
        lease,
        replace(
            result,
            files=tuple(file.model_copy(update={"base_hash": "b" * 64}) for file in result.files),
        ),
    )
    decision = next(item for item in service.snapshot(run.id).decisions if item.status == "open")
    service.resolve_decision(
        decision.id,
        DecisionResolution(version=1, choice="reject"),
        "reject-conflict",
        "candidate-worker",
    )
    snapshot = service.snapshot(run.id)
    assert snapshot.tasks[3].status == "blocked"
    assert "файл" in snapshot.tasks[3].blocked_reason.lower()
    assert "архитектуру" not in snapshot.run.blocked_reason.lower()
    assert snapshot.tasks[2].status == "succeeded"


def test_source_normalizes_once_and_redacts_content_and_raw_trace(database):
    canary = "source-canary-527674"
    service, run, engine, lease = source_ready(database, secrets=(canary,))
    result = lease.provider.run(lease.request)
    first = result.files[0]
    raw_content = "\ufeff\ufeff" + first.content.replace("\n", "\r\n") + f"# {canary}\r\n"
    result = replace(
        result,
        files=(first.model_copy(update={"content": raw_content}), *result.files[1:]),
        raw_response=f"provider output\r\n{canary}",
    )
    engine.finish(lease, result)
    candidate = service.snapshot(run.id).candidate
    file = next(item for item in candidate.files if item.relative_path == first.relative_path)
    content = service.artifact_content(file.artifact_id).content
    assert content.startswith("\ufeff") and not content.startswith("\ufeff\ufeff")
    assert "\r" not in content
    assert canary not in content
    assert "[REDACTED:secret]" in content
    assert service.attempt_trace(lease.attempt_id).raw_response == (
        "provider output\r\n[REDACTED:secret]"
    )


@pytest.mark.parametrize("bad", ["incomplete", "missing", "documents", "usage", "raw_limit"])
def test_invalid_source_result_is_known_failure_without_partial_files(database, bad):
    service, run, engine, lease = source_ready(database)
    result = lease.provider.run(lease.request)
    changes = {
        "incomplete": {"stop_reason": "length"},
        "missing": {"files": result.files[:2]},
        "documents": {"artifacts": (ArtifactDraft("decision", "unexpected"),)},
        "usage": {"output_tokens": 1},
        "raw_limit": {"raw_response": "x" * 262145},
    }
    before = service.snapshot(run.id)
    with pytest.raises(ProviderFailure) as raised:
        engine.finish(lease, replace(result, **changes[bad]))
    engine.fail(lease, raised.value)
    after = service.snapshot(run.id)
    assert after.artifacts == before.artifacts
    assert after.candidate.files == before.candidate.files
    assert after.tasks[3].status == "failed"
    assert after.agent_runs[-1].status == "failed"
    assert service.attempt_trace(lease.attempt_id).stop_reason == changes[bad].get(
        "stop_reason", result.stop_reason
    )


@pytest.mark.parametrize("maximum", [1, 2])
def test_insufficient_source_batch_limit_blocks_before_provider_dispatch(database, maximum):
    service, run = create_run(database)
    engine = WorkerService(database)
    approve_architecture(service, run, Worker(engine, owner="limited-source"))
    with database.sessions.begin() as session:
        persisted = session.get(Run, run.id)
        persisted.limits = dict(persisted.limits, max_files_per_proposal=maximum)
    assert engine.claim("limited-source") is None
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert "3" in snapshot.run.blocked_reason
    assert len(snapshot.agent_runs) == 3


@pytest.mark.parametrize("command", ["pause", "cancel"])
def test_control_releases_both_created_source_operations_without_dispatch(database, command):
    service, run = create_run(database)
    engine = WorkerService(database)
    approve_architecture(service, run, Worker(engine, owner="document-worker"))
    leases = [engine.claim("created-one"), engine.claim("created-two")]
    assert all(lease is not None for lease in leases)
    service.run_command(run.id, RunCommand(command=command), "control-created", "candidate-worker")
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == ("paused" if command == "pause" else "cancelled")
    assert all(item.status == "cancelled" for item in snapshot.agent_runs[-2:])
    assert all(item.active_attempt_id is None for item in snapshot.tasks[3:5])
    assert snapshot.usage.request_count == 3
    for lease in leases:
        with pytest.raises(DomainError):
            engine.begin(lease)


@pytest.mark.parametrize("command", ["pause", "cancel"])
@pytest.mark.parametrize("uncertain", [False, True])
def test_source_failure_and_peer_finish_preserve_unknown_control_outcomes(
    database, command, uncertain
):
    service, run, engine, first = source_ready(database)
    second = engine.claim("peer-worker")
    engine.begin(second)
    service.run_command(run.id, RunCommand(command=command), "control-running", "candidate-worker")
    engine.fail(
        first,
        ProviderFailure(
            "source_failed", "Source outcome unavailable.", dispatched=True, uncertain=uncertain
        ),
    )
    interim = service.snapshot(run.id)
    assert interim.run.status not in {"paused", "cancelled"}
    assert (
        next(item for item in interim.agent_runs if item.id == second.attempt_id).status
        == "running"
    )
    engine.finish(second, second.provider.run(second.request))
    final = service.snapshot(run.id)
    if uncertain:
        assert final.run.status == "blocked"
        assert final.agent_runs[3].status == "uncertain"
    elif command == "cancel":
        assert final.run.status == "cancelled"
    else:
        assert final.run.status == "blocked"


def source_complete(database, workspace_root, **kwargs):
    service, run, engine, first = source_ready(database, **kwargs)
    engine.workspace_root = workspace_root
    engine.materializer = materialize
    second = engine.claim("peer-worker")
    assert second is not None
    assert engine.begin(second)
    engine.finish(first, first.provider.run(first.request))
    engine.finish(second, second.provider.run(second.request))
    return service, run, engine


def claim_publication(engine, owner):
    assert hasattr(engine, "claim_publication"), "Fenced candidate publication is missing"
    return engine.claim_publication(owner)


def test_publication_dependency_injection_is_supported(database, tmp_path):
    assert {"workspace_root", "materializer"} <= signature(WorkerService).parameters.keys()
    engine = WorkerService(database, workspace_root=tmp_path, materializer=materialize)
    assert engine.workspace_root == tmp_path
    assert engine.materializer is materialize


def test_qa_waits_for_publication_and_materializer_runs_outside_transaction(database, tmp_path):
    service, run, engine = source_complete(database, tmp_path)
    committed = service.snapshot(run.id).candidate
    assert engine.claim("premature-qa") is None
    assert service.snapshot(run.id).run.status == "running"
    assert service.snapshot(run.id).candidate == committed
    observed = []

    def observing_materializer(root, candidate, contents, manifest_content):
        with database.sessions.begin() as session:
            service._run(session, run.id, for_update=True)
        persisted = service.snapshot(run.id).candidate
        assert persisted.revision == candidate.revision == 3
        assert persisted.manifest_artifact_id == committed.manifest_artifact_id
        assert persisted.status == "materializing"
        observed.append(candidate.id)
        return materialize(root, candidate, contents, manifest_content)

    engine.materializer = observing_materializer
    assert hasattr(engine, "claim_publication"), "Worker must publish the committed candidate"
    assert Worker(engine, owner="publisher").run_once()
    snapshot = service.snapshot(run.id)
    assert observed == [committed.id]
    assert snapshot.candidate.status == "ready"
    assert snapshot.candidate.revision == 3
    assert snapshot.candidate.workspace_path == str(tmp_path / committed.id / "v3")
    assert snapshot.run.status == "blocked"
    assert all(item in snapshot.run.blocked_reason for item in ("QA", "DevOps", "preview"))
    assert len(snapshot.agent_runs) == 5
    assert snapshot.tasks[5].status == "blocked"
    assert service.events(run.id).events[-1].payload.candidate == snapshot.candidate
    for file in committed.files:
        assert (Path(snapshot.candidate.workspace_path) / file.relative_path).exists()
    assert (Path(snapshot.candidate.workspace_path) / ".codehead/manifest.json").exists()


def test_expired_publication_is_fenced_and_recovered_idempotently(database, tmp_path):
    clock = Clock()
    service, run, engine = source_complete(database, tmp_path, clock=clock, lease_seconds=10)
    old = claim_publication(engine, "lost-publisher")
    assert old is not None
    assert claim_publication(engine, "second-publisher") is None
    engine.heartbeat_publication(old)
    path = materialize(engine.workspace_root, old.candidate, old.contents, old.manifest_content)
    clock.advance(11)
    assert not engine.finish_publication(old, path)
    assert service.snapshot(run.id).candidate.status == "materializing"
    assert engine.recover() >= 1
    fresh = claim_publication(engine, "recovered-publisher")
    assert fresh is not None
    assert fresh.fence > old.fence
    assert not engine.finish_publication(old, path)
    replayed = materialize(
        engine.workspace_root, fresh.candidate, fresh.contents, fresh.manifest_content
    )
    assert replayed == path
    assert engine.finish_publication(fresh, replayed)
    assert service.snapshot(run.id).candidate.status == "ready"


@pytest.mark.parametrize("command", ["pause", "cancel"])
def test_control_invalidates_publication_and_cannot_publish_stale_ready(
    database, tmp_path, command
):
    service, run, engine = source_complete(database, tmp_path)
    lease = claim_publication(engine, "controlled-publisher")
    path = materialize(
        engine.workspace_root, lease.candidate, lease.contents, lease.manifest_content
    )
    service.run_command(
        run.id, RunCommand(command=command), "publication-control", "candidate-worker"
    )
    assert not engine.finish_publication(lease, path)
    snapshot = service.snapshot(run.id)
    assert snapshot.candidate.status != "ready"
    assert snapshot.run.status == ("paused" if command == "pause" else "cancelled")
    with database.read() as session:
        candidate = session.get(Candidate, snapshot.candidate.id)
        assert candidate.publication_owner is None
        assert candidate.publication_expires_at is None
    assert path.exists()
    if command == "pause":
        service.run_command(
            run.id, RunCommand(command="resume"), "publication-resume", "candidate-worker"
        )
        assert Worker(engine, owner="resumed-publisher").run_once()
        assert service.snapshot(run.id).candidate.status == "ready"


def test_publication_recovery_preserves_edited_workspace_and_blocks(database, tmp_path):
    clock = Clock()
    service, run, engine = source_complete(database, tmp_path, clock=clock, lease_seconds=10)
    lease = claim_publication(engine, "interrupted-publisher")
    path = materialize(
        engine.workspace_root, lease.candidate, lease.contents, lease.manifest_content
    )
    changed = path / "backend/clinic_api.py"
    changed.write_text("# Retain the author's edit\n", encoding="utf-8")
    clock.advance(11)
    engine.recover()
    assert Worker(engine, owner="workspace-recovery").run_once()
    snapshot = service.snapshot(run.id)
    assert changed.read_text(encoding="utf-8") == "# Retain the author's edit\n"
    assert snapshot.candidate.status == "blocked"
    assert snapshot.candidate.blocked_reason
    assert "workspace" in snapshot.candidate.blocked_reason
    assert snapshot.candidate.workspace_path is None
    assert snapshot.run.status == "blocked"


def test_new_candidate_revision_cannot_be_published_by_old_revision_lease(database, tmp_path):
    clock = Clock()
    service, run, engine = source_complete(database, tmp_path, clock=clock, lease_seconds=10)
    old = claim_publication(engine, "old-revision-publisher")
    path = materialize(engine.workspace_root, old.candidate, old.contents, old.manifest_content)
    with database.sessions.begin() as session:
        persisted = service._run(session, run.id, for_update=True)
        task = next(item for item in service._tasks(session, run.id) if item.role == "backend")
        attempt = next(
            item for item in service._attempts(session, run.id) if item.task_id == task.id
        )
        own = [file for file in old.candidate.files if file.relative_path in ROLE_PATHS["backend"]]
        from codehead.contracts import FileProposal

        engine.candidates.apply(
            session,
            persisted,
            task,
            attempt,
            tuple(
                FileProposal(
                    relative_path=file.relative_path,
                    base_hash=file.content_hash,
                    media_type=file.media_type,
                    content=old.contents[file.relative_path] + "\n",
                )
                for file in own
            ),
            input_versions=attempt.input_versions,
        )
        engine._candidate_progress(session, persisted)
        service._emit_workflow(session, persisted, "candidate.revision_updated")
    assert not engine.finish_publication(old, path)
    assert service.snapshot(run.id).candidate.revision == 4
    assert service.snapshot(run.id).candidate.status == "materializing"
    clock.advance(11)
    engine.recover()
    fresh = claim_publication(engine, "new-revision-publisher")
    assert fresh.revision == 4
    assert fresh.manifest_artifact_id != old.manifest_artifact_id
    fresh_path = materialize(
        engine.workspace_root, fresh.candidate, fresh.contents, fresh.manifest_content
    )
    assert fresh_path != path
    assert engine.finish_publication(fresh, fresh_path)


def test_worker_pool_executes_two_real_provider_calls_concurrently(database):
    from codehead.workflow import worker as worker_module

    assert hasattr(worker_module, "WorkerPool"), "The CLI requires two independent worker slots"
    service, run = create_run(database)
    engine = WorkerService(database, lease_seconds=1)
    approve_architecture(service, run, Worker(engine, owner="document-worker"))
    barrier = threading.Barrier(2)
    calls = []
    completed = []
    lock = threading.Lock()
    stopped = threading.Event()

    class OverlappingProvider(TestProvider):
        def __init__(self):
            super().__init__(with_files=True)

        def run(self, request):
            assert request.role in {"backend", "frontend"}
            with lock:
                calls.append(request.role)
            barrier.wait(timeout=5)
            result = super().run(request)
            with lock:
                completed.append(request.role)
                if len(completed) == 2:
                    stopped.set()
            return result

    with worker_module.WorkerPool(engine, owner="two-slot", provider=OverlappingProvider()) as pool:
        pool.run(stopped, poll_seconds=0.01)
    snapshot = service.snapshot(run.id)
    assert sorted(calls) == ["backend", "frontend"]
    assert len(snapshot.agent_runs) == 5
    assert all(item.status == "succeeded" for item in snapshot.tasks[:5])
    assert snapshot.candidate.status == "materializing"


def test_worker_capabilities_require_the_union_of_live_declared_roles(database):
    assert "required_roles" in signature(ProjectService.worker_connected).parameters
    service = ProjectService(database)
    engine = WorkerService(database)
    engine.register("declared-worker")
    assert service.worker_connected(required_roles=("backend", "frontend"))
    with database.sessions.begin() as session:
        session.get(WorkerHeartbeat, "declared-worker").supported_roles = [
            "product_manager",
            "architect",
            "cto",
        ]
    assert service.worker_connected()
    assert not service.worker_connected(required_roles=("backend", "frontend"))
    engine.register("declared-worker")
    assert service.worker_connected(required_roles=("backend", "frontend"))


def test_recovery_fences_both_dispatched_source_outcomes_and_blocks_candidate(database):
    clock = Clock()
    service, run, engine, first = source_ready(database, clock=clock, lease_seconds=10)
    second = engine.claim("lost-peer")
    engine.begin(second)
    before = service.snapshot(run.id)
    clock.advance(11)
    assert engine.recover() == 2
    snapshot = service.snapshot(run.id)
    assert snapshot.candidate.status == "blocked"
    assert snapshot.candidate.blocked_reason
    assert snapshot.artifacts == before.artifacts
    assert all(
        item.status == "uncertain"
        for item in snapshot.agent_runs
        if item.id in {first.attempt_id, second.attempt_id}
    )
    assert len([item for item in snapshot.decisions if item.kind == "uncertain_outcome"]) == 2
    assert engine.claim("replacement") is None
    for lease in (first, second):
        with pytest.raises(DomainError):
            engine.finish(lease, lease.provider.run(lease.request))
    service.run_command(
        run.id, RunCommand(command="cancel"), "cancel-lost-sources", "candidate-worker"
    )
    decisions = [item for item in service.snapshot(run.id).decisions if item.status == "open"]
    for index, decision in enumerate(decisions):
        service.resolve_decision(
            decision.id,
            DecisionResolution(
                version=1,
                choice="confirm_failed",
                comment="Confirmed failure from the source provider.",
            ),
            f"confirm-source-{index}",
            "candidate-worker",
        )
        assert service.snapshot(run.id).run.status == (
            "cancelled" if index == len(decisions) - 1 else "blocked"
        )


@pytest.mark.parametrize("uncertain", [False, True])
def test_pool_stop_waits_for_both_known_outcomes_and_renews_both_leases(database, uncertain):
    from codehead.workflow.worker import WorkerPool

    service, run = create_run(database)
    stopped = threading.Event()
    entered = threading.Event()
    renewed = threading.Event()
    known = {role: threading.Event() for role in ("backend", "frontend")}
    released = {role: threading.Event() for role in ("backend", "frontend")}
    roles_entered, roles_renewed = set(), set()
    lock = threading.Lock()

    class ObservingEngine(WorkerService):
        def heartbeat(self, lease):
            super().heartbeat(lease)
            with lock:
                roles_renewed.add(lease.request.role)
                if roles_renewed == {"backend", "frontend"}:
                    renewed.set()

        def finish(self, lease, result):
            super().finish(lease, result)
            if lease.request.role in known:
                known[lease.request.role].set()

        def fail(self, lease, failure):
            super().fail(lease, failure)
            if lease.request.role in known:
                known[lease.request.role].set()

    class HeldProvider(TestProvider):
        def __init__(self):
            super().__init__(with_files=True)

        def run(self, request):
            with lock:
                roles_entered.add(request.role)
                if roles_entered == {"backend", "frontend"}:
                    entered.set()
            if not released[request.role].wait(5):
                raise ProviderFailure(
                    "gate_timeout", "Test gate timed out.", dispatched=True, uncertain=True
                )
            if request.role == "backend" and uncertain:
                raise ProviderFailure(
                    "lost_source", "Source outcome is unknown.", dispatched=True, uncertain=True
                )
            return super().run(request)

    engine = ObservingEngine(database, lease_seconds=1)
    approve_architecture(service, run, Worker(engine, owner="document-worker"))
    with WorkerPool(engine, owner="graceful-slots", provider=HeldProvider()) as pool:
        with ThreadPoolExecutor(max_workers=1) as runner:
            future = runner.submit(pool.run, stopped, poll_seconds=0.01)
            try:
                assert entered.wait(3)
                assert renewed.wait(3)
                assert all(
                    item.status == "running" for item in service.snapshot(run.id).agent_runs[-2:]
                )
                stopped.set()
                released["backend"].set()
                assert known["backend"].wait(3)
                assert not future.done()
                assert service.snapshot(run.id).run.status not in {
                    "paused",
                    "cancelled",
                    "succeeded",
                }
                released["frontend"].set()
                future.result(timeout=5)
            finally:
                stopped.set()
                for gate in released.values():
                    gate.set()
    snapshot = service.snapshot(run.id)
    assert len(snapshot.agent_runs) == 5
    assert known["frontend"].is_set()
    assert snapshot.candidate.status == ("blocked" if uncertain else "materializing")
    assert snapshot.agent_runs[3].status == ("uncertain" if uncertain else "succeeded")
    assert snapshot.agent_runs[4].status == "succeeded"
