import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from codehead.clinic.files import tree_hash
from codehead.contracts import CreateProject, DecisionResolution, RunCommand, RunLimits, StartRun
from codehead.errors import DomainError
from codehead.llm.provider import ArtifactDraft, ProviderFailure
from codehead.llm.test_provider import TestProvider
from codehead.persistence.models import Artifact, QualityCycle, WorkerHeartbeat
from codehead.persistence.service import ProjectService, payload_hash
from codehead.runner.execution import ExecutionResult, RunnerRequest
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService


class KnownRunner:
    def __init__(self, failed_cycles=0):
        self.failed_cycles = failed_cycles
        self.http_calls = 0

    def execute(self, request, **_):
        failed = False
        if request.operation_id == "test_backend":
            self.http_calls += 1
            failed = self.http_calls <= self.failed_cycles
        return ExecutionResult(
            status="failed" if failed else "succeeded",
            exit_code=1 if failed else 0,
            stdout="2 failed: concurrent duplicate returned two 201" if failed else "checks passed",
            error_code="tool_failed" if failed else None,
            report={
                "status": "failed" if failed else "passed",
                "exit_code": 1 if failed else 0,
                "profile_hash": request.candidate.profile_hash,
                "profile_hash_after": request.candidate.profile_hash,
                "suite_hash": request.candidate.acceptance_suite_hash,
                "suite_hash_after": request.candidate.acceptance_suite_hash,
                "candidate_hash": tree_hash(
                    {file.relative_path: file.content_hash for file in request.candidate.files}
                    | {".codehead/manifest.json": request.candidate.manifest_hash}
                ),
                "candidate_hash_after": tree_hash(
                    {file.relative_path: file.content_hash for file in request.candidate.files}
                    | {".codehead/manifest.json": request.candidate.manifest_hash}
                ),
                "isolation_level": "process_only",
            }
            if request.operation_id == "test_backend"
            else None,
        )


def setup_run(
    database,
    tmp_path,
    scenario="standard",
    failed=0,
    repairs=2,
    llm_calls=64,
    *,
    workflow_version="clinic-v3",
):
    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Quality clinic", description="Synthetic clinic appointments."),
        "qa-project",
    )
    run = service.start_run(
        project.id,
        StartRun(
            mode="test",
            workflow_version=workflow_version,
            test_scenario=scenario,
            limits=RunLimits(max_repair_iterations=repairs, max_llm_calls=llm_calls),
        ),
        "qa-start",
        "qa-test",
    )
    engine = WorkerService(database, workspace_root=tmp_path, tool_runner=KnownRunner(failed))
    return service, run, engine, Worker(engine, owner="qa-worker")


def drain(service, run, worker):
    for _ in range(80):
        if not worker.run_once():
            snapshot = service.snapshot(run.id)
            decision = next(
                (
                    d
                    for d in snapshot.decisions
                    if d.status == "open" and d.kind == "architecture_approval"
                ),
                None,
            )
            if decision:
                service.resolve_decision(
                    decision.id,
                    DecisionResolution(version=decision.version, choice="approve"),
                    "qa-approve",
                    "qa-test",
                )
                continue
            return snapshot
    pytest.fail("QA workflow did not settle")


def test_start_default_v4_and_old_default_digest():
    command = StartRun(mode="test")
    assert command.workflow_version == "clinic-v4"
    assert command.test_scenario == "standard"
    import hashlib

    original = command.model_dump(mode="json")
    original.pop("workflow_version")
    original.pop("test_scenario")
    for name in ("max_file_bytes", "max_files_per_proposal", "max_proposal_bytes"):
        original["limits"].pop(name)
    assert (
        payload_hash(command)
        == hashlib.sha256(
            json.dumps(original, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )


@pytest.mark.parametrize(
    "mode,version", [("live", "clinic-v3"), ("live", "clinic-v4"), ("test", "clinic-v2")]
)
def test_nonstandard_scenario_rejected(mode, version):
    with pytest.raises(ValueError):
        StartRun(mode=mode, workflow_version=version, test_scenario="repair_success")


@pytest.mark.parametrize("version", ["clinic-v3", "clinic-v4"])
@pytest.mark.parametrize("scenario", ["repair_success", "repair_blocked"])
def test_test_qa_versions_accept_repair_scenarios(version, scenario):
    assert StartRun(
        mode="test", workflow_version=version, test_scenario=scenario
    ).test_scenario == (scenario)


@pytest.mark.parametrize("scenario,failed,revision", [("standard", 0, 3), ("repair_success", 1, 5)])
def test_clinic_v4_uses_pinned_qa_tools_and_repair(database, tmp_path, scenario, failed, revision):
    service, run, _, worker = setup_run(
        database, tmp_path, scenario, failed, workflow_version="clinic-v4"
    )
    snapshot = drain(service, run, worker)
    assert snapshot.candidate.revision == revision
    assert len(snapshot.quality_cycles) == failed + 1
    assert [cycle.status for cycle in snapshot.quality_cycles] == ["failed"] * failed + ["passed"]
    assert len([tool for tool in snapshot.tool_runs if tool.qa_cycle_id]) == 3 * (failed + 1)


@pytest.mark.parametrize(
    "scenario,failed,calls,cycles,status",
    [
        ("standard", 0, 6, 1, "passed"),
        ("repair_success", 1, 8, 2, "passed"),
        ("repair_blocked", 3, 10, 3, "failed"),
    ],
)
def test_quality_cycles_and_immutable_repair_history(
    database, tmp_path, scenario, failed, calls, cycles, status
):
    service, run, engine, worker = setup_run(database, tmp_path, scenario, failed)
    final = drain(service, run, worker)
    assert run.workflow_version == "clinic-v3"
    assert final.run.status == "blocked"
    assert len(final.agent_runs) == calls
    assert len(final.quality_cycles) == cycles
    assert final.quality_cycles[-1].status == status
    assert len(final.tool_runs) == 3 * cycles
    assert all(
        task.status == "succeeded"
        for task in final.tasks
        if task.role in {"backend", "frontend", "qa"}
    )
    assert sum(task.role == "backend" for task in final.tasks) == cycles
    assert len([a for a in final.artifacts if a.artifact_type == "test_report"]) == cycles
    assert len([a for a in final.artifacts if a.artifact_type == "bug"]) == failed
    assert final.run.injection_done == (scenario != "standard")
    assert (
        final.candidate.revision == 3
        if scenario == "standard"
        else final.candidate.revision == 4 + cycles - 1
    )
    for cycle in final.quality_cycles:
        tools = [tool for tool in final.tool_runs if tool.id in cycle.tool_run_ids]
        assert len(tools) == 3
        assert {tool.operation_id for tool in tools} == {
            "validate_backend",
            "test_backend",
            "build_frontend",
        }
        assert all(
            tool.qa_cycle_id == cycle.id and tool.tree_hash == cycle.tree_hash for tool in tools
        )
        assert len(cycle.tool_report_artifact_ids) == 3
    assert (
        service.events(run.id, after_seq=max(0, final.last_event_seq - 1))
        .events[-1]
        .payload.quality_cycles
        == final.quality_cycles
    )


@pytest.mark.parametrize("repairs", [0, 1])
def test_repair_limit_is_enforced(database, tmp_path, repairs):
    service, run, _, worker = setup_run(database, tmp_path, "repair_blocked", 3, repairs)
    final = drain(service, run, worker)
    assert len(final.quality_cycles) == repairs + 1
    assert len(final.agent_runs) == 6 + 2 * repairs
    assert "repair" in final.run.blocked_reason.lower()


def ready_analysis(database, tmp_path, scenario="standard"):
    service, run, engine, worker = setup_run(database, tmp_path, scenario)
    for _ in range(30):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles and snapshot.quality_cycles[-1].status == "analyzing":
            return service, run, engine
        decision = next(
            (
                d
                for d in snapshot.decisions
                if d.kind == "architecture_approval" and d.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    pytest.fail("QA analysis did not become ready")


@pytest.mark.parametrize("mutation", ["status", "hash", "tool", "task", "extra", "duplicate"])
def test_qa_forged_report_is_refused_before_saving(database, tmp_path, mutation):
    service, run, engine = ready_analysis(database, tmp_path)
    lease = engine.claim("malicious-qa")
    assert lease.request.role == "qa"
    assert engine.begin(lease)
    result = lease.provider.run(lease.request)
    report = json.loads(result.artifacts[0].content)
    if mutation == "status":
        report["status"] = "failed"
    elif mutation == "hash":
        report["tree_hash"] = "0" * 64
    elif mutation == "tool":
        report["tool_run_ids"][0] = "foreign"
    elif mutation == "task":
        report["task_id"] = "foreign"
    elif mutation == "extra":
        report["task_status"] = "succeeded"
    content = json.dumps(report)
    if mutation == "duplicate":
        content = content[:-1] + ', "status": "failed", "status": "passed"}'
    forged = replace(result, artifacts=(ArtifactDraft("test_report", content, "application/json"),))
    with pytest.raises(ProviderFailure):
        engine.finish(lease, forged)
    assert not [a for a in service.snapshot(run.id).artifacts if a.artifact_type == "test_report"]


def test_modified_tool_report_input_blocks_qa_dispatch(database, tmp_path):
    service, run, engine = ready_analysis(database, tmp_path)
    snapshot = service.snapshot(run.id)
    with engine.database.sessions.begin() as session:
        artifact = session.get(Artifact, snapshot.quality_cycles[0].tool_report_artifact_ids[0])
        artifact.content_text += "mutated"
    assert engine.claim("input-mutation") is None
    assert service.snapshot(run.id).run.status == "blocked"


def test_unknown_tool_immediately_blocks_cycle_without_bug(database, tmp_path):
    service, run, engine, worker = setup_run(database, tmp_path)
    for _ in range(20):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles:
            break
        decision = next(
            (
                d
                for d in snapshot.decisions
                if d.kind == "architecture_approval" and d.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    lease = engine.claim_tool("lost-runner")
    assert engine.begin_tool(lease)
    engine.abandon_tool(lease)
    final = service.snapshot(run.id)
    assert final.quality_cycles[0].status == "blocked"
    assert not [
        artifact for artifact in final.artifacts if artifact.artifact_type in {"bug", "test_report"}
    ]


def test_qa_analysis_call_budget_blocks_quality_cycle(database, tmp_path):
    service, run, _, worker = setup_run(database, tmp_path, llm_calls=5)
    final = drain(service, run, worker)
    assert len(final.agent_runs) == 5
    assert len(final.tool_runs) == 3
    assert final.run.status == "blocked"
    assert final.quality_cycles[0].status == "blocked"
    assert "лимит" in final.quality_cycles[0].blocked_reason.lower()
    assert len(final.tasks) == 7


def test_pause_during_pending_tools_preserves_cycle_and_resumes(database, tmp_path):
    service, run, engine, worker = setup_run(database, tmp_path)
    for _ in range(20):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles:
            break
        decision = next(
            (
                d
                for d in snapshot.decisions
                if d.kind == "architecture_approval" and d.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    ids = snapshot.quality_cycles[0].tool_run_ids
    paused = service.run_command(run.id, RunCommand(command="pause"), "qa-pause", "qa-test")
    assert paused.status == "paused"
    assert engine.claim_tool("paused-runner") is None
    service.run_command(run.id, RunCommand(command="resume"), "qa-resume", "qa-test")
    final = drain(service, run, worker)
    assert final.quality_cycles[0].tool_run_ids == ids
    assert final.quality_cycles[0].status == "passed"


def test_cancel_during_analysis_marks_cycle_cancelled(database, tmp_path):
    service, run, engine = ready_analysis(database, tmp_path)
    cancelled = service.run_command(run.id, RunCommand(command="cancel"), "qa-cancel", "qa-test")
    assert cancelled.status == "cancelled"
    snapshot = service.snapshot(run.id)
    assert snapshot.quality_cycles[0].status == "cancelled"
    assert engine.claim("cancelled-qa") is None


def test_refused_quality_response_keeps_raw_trace(database, tmp_path):
    service, run, engine = ready_analysis(database, tmp_path)

    class ForgedProvider(TestProvider):
        def run(self, request):
            result = super().run(request)
            report = json.loads(result.artifacts[0].content)
            report["tree_hash"] = "0" * 64
            content = json.dumps(report)
            return replace(
                result,
                artifacts=(ArtifactDraft("test_report", content, "application/json"),),
                raw_response=content,
            )

    assert Worker(engine, owner="forged-qa", provider=ForgedProvider(with_files=True)).run_once()
    final = service.snapshot(run.id)
    attempt = final.agent_runs[-1]
    assert attempt.status == "failed"
    trace = service.attempt_trace(attempt.id)
    assert trace.raw_response is not None
    assert json.loads(trace.raw_response)["tree_hash"] == "0" * 64
    assert trace.parameters["instructions_version"] == "worker-test-qa-v1"


def test_repair_keeps_original_task_history_and_frontend_bases(database, tmp_path):
    service, run, engine, worker = setup_run(database, tmp_path, "repair_success", 1)
    initial_tasks = None
    initial_frontend = None
    for _ in range(30):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles and snapshot.quality_cycles[0].status == "failed":
            initial_tasks = {
                task.id: task
                for task in snapshot.tasks
                if task.iteration == 0 and task.role != "devops"
            }
            initial_frontend = [
                file
                for file in snapshot.candidate.files
                if file.relative_path.startswith("frontend/")
            ]
            break
        decision = next(
            (
                item
                for item in snapshot.decisions
                if item.kind == "architecture_approval" and item.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    assert initial_tasks is not None
    lease = engine.claim("repair-bases")
    assert lease.request.role == "backend"
    assert lease.request.repair_context == {"test_scenario": "repair_success", "iteration": 1}
    assert all(base["base_hash"] for base in lease.request.candidate_files)
    assert {item["artifact_type"] for item in lease.request.inputs}.issuperset(
        {"bug", "test_report", "source_code"}
    )
    assert engine.begin(lease)
    engine.finish(lease, lease.provider.run(lease.request))
    final = drain(service, run, worker)
    assert {task.id: task for task in final.tasks if task.id in initial_tasks} == initial_tasks
    assert [
        file for file in final.candidate.files if file.relative_path.startswith("frontend/")
    ] == initial_frontend
    report = json.loads(
        service.artifact_content(final.quality_cycles[-1].report_artifact_id).content
    )
    assert report["resolves_bug_ids"] == final.quality_cycles[0].bug_artifact_ids


def test_source_mutation_before_tool_dispatch_blocks_quality_cycle(database, tmp_path):
    service, run, engine, worker = setup_run(database, tmp_path)
    for _ in range(20):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles:
            break
        decision = next(
            (
                item
                for item in snapshot.decisions
                if item.kind == "architecture_approval" and item.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    with database.sessions.begin() as session:
        artifact = session.get(Artifact, snapshot.candidate.files[0].artifact_id)
        artifact.content_text += "changed"
    assert engine.claim_tool("changed-candidate") is None
    final = service.snapshot(run.id)
    assert final.run.status == "blocked"
    assert final.quality_cycles[0].status == "blocked"


def test_qa_capability_requires_one_complete_worker(client, database):
    stamp = datetime.now(UTC)
    with database.sessions.begin() as session:
        for index, roles in enumerate(
            [["product_manager", "architect", "cto"], ["backend", "frontend", "qa"]]
        ):
            session.add(
                WorkerHeartbeat(
                    owner=f"partial-qa-{index}",
                    supported_roles=roles,
                    supported_tools=["validate_backend", "test_backend", "build_frontend"],
                    updated_at=stamp,
                    expires_at=stamp + timedelta(seconds=60),
                )
            )
    capabilities = {
        item["id"]: item for item in client.get("/api/capabilities").json()["capabilities"]
    }
    assert capabilities["qa_execution"]["status"] == "disabled"


def test_build_does_not_claim_ui_or_preview_requirements_passed(database, tmp_path):
    service, run, engine = ready_analysis(database, tmp_path)
    lease = engine.claim("honest-qa")
    result = lease.provider.run(lease.request)
    report = json.loads(result.artifacts[0].content)
    states = {check["requirement_id"]: check["status"] for check in report["requirements"]}
    assert states["REQ-006"] == "not_verified"
    assert states["REQ-008"] == "not_verified"


def test_preclaimed_tool_cannot_restart_blocked_cycle(database, tmp_path):
    service, run, engine, worker = setup_run(database, tmp_path)
    for _ in range(20):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles:
            break
        decision = next(
            (
                item
                for item in snapshot.decisions
                if item.kind == "architecture_approval" and item.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    first = engine.claim_tool("first-tool")
    second = engine.claim_tool("second-tool")
    assert engine.begin_tool(first)
    engine.finish_tool(
        first,
        ExecutionResult(
            status="failed",
            exit_code=1,
            error_code="runner_io_error",
            error_message="Technical failure",
        ),
    )
    assert not engine.begin_tool(second)
    final = service.snapshot(run.id)
    assert final.quality_cycles[0].status == "blocked"
    assert next(task for task in final.tasks if task.role == "qa").status == "blocked"
    assert next(agent for agent in final.agents if agent.role == "qa").lifecycle == "blocked"


def test_expired_dispatched_qa_blocks_cycle_and_rejects_late_result(database, tmp_path):
    service, run, engine = ready_analysis(database, tmp_path)
    stamp = datetime.now(UTC)
    engine.clock = lambda: stamp
    lease = engine.claim("expired-qa")
    assert engine.begin(lease)
    result = lease.provider.run(lease.request)
    stamp += timedelta(seconds=31)
    assert engine.recover() == 1
    final = service.snapshot(run.id)
    assert final.quality_cycles[0].status == "blocked"
    assert final.agent_runs[-1].status == "uncertain"
    with pytest.raises(DomainError):
        engine.finish(lease, result)
    assert not [
        artifact
        for artifact in service.snapshot(run.id).artifacts
        if artifact.artifact_type == "test_report"
    ]


def test_qa_cannot_resolve_a_non_bug_artifact_from_prior_cycle(database, tmp_path):
    service, run, engine, worker = setup_run(database, tmp_path, "repair_success", 1)
    for _ in range(40):
        snapshot = service.snapshot(run.id)
        if len(snapshot.quality_cycles) == 2 and snapshot.quality_cycles[-1].status == "analyzing":
            break
        decision = next(
            (
                item
                for item in snapshot.decisions
                if item.kind == "architecture_approval" and item.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    with database.sessions.begin() as session:
        cycle = session.get(QualityCycle, snapshot.quality_cycles[0].id)
        cycle.bug_artifact_ids = [snapshot.candidate.files[0].artifact_id]
    assert engine.claim("foreign-bug-chain") is None
    assert service.snapshot(run.id).quality_cycles[-1].status == "blocked"


def test_standard_http_failure_can_repair_without_test_injection(database, tmp_path):
    service, run, _, worker = setup_run(database, tmp_path, "standard", 1)
    final = drain(service, run, worker)
    assert [cycle.status for cycle in final.quality_cycles] == ["failed", "passed"]
    assert len(final.agent_runs) == 8
    assert final.candidate.revision == 4
    assert not final.run.injection_done


@pytest.mark.parametrize("stage", ["claim", "begin", "running"])
def test_automatic_quality_tool_obeys_run_deadline(database, tmp_path, stage):
    service, run, engine, worker = setup_run(database, tmp_path)
    for _ in range(30):
        snapshot = service.snapshot(run.id)
        if snapshot.quality_cycles:
            break
        decision = next(
            (
                item
                for item in snapshot.decisions
                if item.kind == "architecture_approval" and item.status == "open"
            ),
            None,
        )
        if decision:
            service.resolve_decision(
                decision.id,
                DecisionResolution(version=decision.version, choice="approve"),
                "qa-approve",
                "qa-test",
            )
        else:
            assert worker.run_once()
    stamp = run.created_at + timedelta(seconds=run.limits.max_duration_seconds - 2)
    engine.clock = lambda: stamp
    if stage == "claim":
        stamp += timedelta(seconds=3)
        assert engine.claim_tool("expired-run") is None
    else:
        lease = engine.claim_tool("deadline-run")
        assert lease.tool.timeout_seconds <= 2
        if stage == "begin":
            stamp += timedelta(seconds=3)
            assert not engine.begin_tool(lease)
        else:
            assert engine.begin_tool(lease)
            stamp += timedelta(seconds=3)
            assert engine.tool_should_stop(lease)
            result = engine.tool_runner.execute(
                RunnerRequest(
                    lease.tool.id,
                    lease.tool.operation_id,
                    lease.candidate,
                    lease.contents,
                    lease.manifest_content,
                )
            )
            engine.finish_tool(lease, result)
            assert (
                next(
                    tool for tool in service.snapshot(run.id).tool_runs if tool.id == lease.tool.id
                ).status
                == "succeeded"
            )
    final = service.snapshot(run.id)
    assert final.run.status == "blocked"
    assert final.quality_cycles[0].status == "blocked"
    assert "лимит" in final.run.blocked_reason.lower()
    assert not [
        artifact for artifact in final.artifacts if artifact.artifact_type in {"bug", "test_report"}
    ]
