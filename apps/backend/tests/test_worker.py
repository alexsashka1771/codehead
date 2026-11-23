from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from conftest import command_headers
from sqlalchemy import select

from codehead.contracts import (
    CreateProject,
    DecisionResolution,
    RunCommand,
    RunLimits,
    Snapshot,
    StartRun,
)
from codehead.errors import DomainError
from codehead.llm.test_provider import TestProvider
from codehead.persistence.models import Task
from codehead.persistence.service import ProjectService


def test_explicit_test_mode_is_a_distinct_contract():
    assert StartRun(mode="test").mode == "test"
    assert StartRun().mode == "live"


def test_snapshot_contract_includes_worker_state():
    assert {"agent_runs", "decisions", "usage"} <= Snapshot.model_fields.keys()


def test_existing_saved_live_run_has_empty_worker_state(client, project):
    response = client.post(
        f"/api/projects/{project['id']}/runs", headers=command_headers(), json={}
    )
    assert response.status_code == 201, response.text
    snapshot = client.get(f"/api/runs/{response.json()['id']}/snapshot").json()
    assert snapshot["agent_runs"] == []
    assert snapshot["decisions"] == []
    assert snapshot["usage"]["cost_usd"] is None
    assert snapshot["usage"]["input_tokens"] is None


def test_task_has_monotonic_fencing_identity(database):
    from codehead.contracts import CreateProject

    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Worker test", description="Synthetic clinic workflow."), "worker-create"
    )
    run = service.start_run(project.id, StartRun(), "worker-start", "worker-test")
    task = service.snapshot(run.id).tasks[0]
    assert task.fencing_token == 0
    assert task.active_attempt_id is None


@pytest.fixture
def started(database):
    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Worker clinic", description="Doctors and synthetic appointments."),
        "create-worker",
    )
    run = service.start_run(project.id, StartRun(mode="test"), "start-worker", "worker-test")
    return service, run


class Clock:
    def __init__(self):
        self.value = datetime.now(UTC)

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)


def worker_service(database, **kwargs):
    from codehead.workflow.worker_service import WorkerService

    return WorkerService(database, **kwargs)


def test_only_one_of_two_workers_can_claim_ready_task(database, started):
    service, run = started
    workers = [worker_service(database), worker_service(database)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(worker.claim, f"owner-{index}") for index, worker in enumerate(workers)
        ]
        leases = [future.result() for future in futures]
    assert sum(lease is not None for lease in leases) == 1
    snapshot = service.snapshot(run.id)
    assert len(snapshot.agent_runs) == 1
    assert snapshot.agent_runs[0].status == "created"
    assert snapshot.tasks[0].status == "queued"
    assert snapshot.tasks[0].active_attempt_id == snapshot.agent_runs[0].id


def test_claim_begin_finish_publishes_real_role_and_input_versions(database, started):
    service, run = started
    worker = worker_service(database)
    lease = worker.claim("worker-one")
    assert lease is not None
    assert worker.begin(lease)
    assert service.snapshot(run.id).agents[0].lifecycle == "busy"
    worker.finish(lease, TestProvider().run(lease.request))
    snapshot = service.snapshot(run.id)
    assert snapshot.tasks[0].status == "succeeded"
    assert snapshot.agent_runs[0].status == "succeeded"
    assert snapshot.agents[0].lifecycle == "idle"
    assert snapshot.artifacts[0].provenance.origin == "test"
    assert snapshot.artifacts[0].provenance.producer_id == lease.attempt_id
    next_lease = worker.claim("worker-two")
    assert next_lease.request.role == "architect"
    assert next_lease.input_versions == {snapshot.artifacts[0].id: 1}
    assert snapshot.usage.request_count == 1
    assert snapshot.usage.cost_usd == 0


def test_expired_pre_dispatch_lease_is_recoverable_without_external_retry(database, started):
    service, run = started
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("first")
    clock.advance(11)
    assert worker.recover() == 1
    snapshot = service.snapshot(run.id)
    assert snapshot.agent_runs[0].status == "cancelled"
    assert snapshot.tasks[0].status == "queued"
    assert snapshot.usage.request_count == 0
    fresh = worker.claim("second")
    assert fresh.attempt_id != lease.attempt_id
    assert fresh.fencing_token > lease.fencing_token


def test_expired_dispatched_lease_becomes_uncertain_and_is_not_reissued(database, started):
    service, run = started
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("lost")
    worker.begin(lease)
    clock.advance(11)
    assert worker.recover() == 1
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert snapshot.tasks[0].status == "blocked"
    assert snapshot.agent_runs[0].status == "uncertain"
    assert snapshot.usage.cost_usd is None
    assert snapshot.decisions[0].kind == "uncertain_outcome"
    assert worker.claim("another") is None
    with pytest.raises(DomainError):
        worker.finish(lease, TestProvider().run(lease.request))
    assert service.snapshot(run.id).artifacts == []


def test_stale_fencing_token_cannot_start_or_accept_result(database, started):
    service, run = started
    worker = worker_service(database)
    lease = worker.claim("worker-one")
    with pytest.raises(DomainError):
        worker.begin(replace(lease, fencing_token=lease.fencing_token + 1))
    worker.begin(lease)
    with pytest.raises(DomainError):
        worker.finish(
            replace(lease, attempt_id="foreign-attempt"), TestProvider().run(lease.request)
        )
    assert service.snapshot(run.id).artifacts == []


def test_input_revision_change_rejects_result(database, started):
    service, run = started
    worker = worker_service(database)
    lease = worker.claim("worker-one")
    worker.begin(lease)
    with database.sessions.begin() as session:
        task = session.get(Task, lease.task_id)
        task.input_versions = {"revised-input": 2}
    with pytest.raises(DomainError):
        worker.finish(lease, TestProvider().run(lease.request))
    assert service.snapshot(run.id).artifacts == []


@pytest.mark.parametrize("command", ["pause", "cancel"])
def test_control_during_dispatch_waits_for_known_completion(database, started, command):
    service, run = started
    worker = worker_service(database)
    lease = worker.claim("worker-one")
    worker.begin(lease)
    pending = service.run_command(run.id, RunCommand(command=command), "control-worker", "test")
    assert pending.status == "pausing"
    assert pending.cancel_requested == (command == "cancel")
    worker.finish(lease, TestProvider().run(lease.request))
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == ("cancelled" if command == "cancel" else "paused")
    assert snapshot.agent_runs[0].status == "succeeded"
    assert worker.claim("later") is None


def test_cancel_unknown_outcome_does_not_claim_confirmed_stoppage(database, started):
    service, run = started
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("lost")
    worker.begin(lease)
    clock.advance(11)
    worker.recover()
    response = service.run_command(run.id, RunCommand(command="cancel"), "cancel-unknown", "test")
    assert response.status == "blocked"
    assert response.cancel_requested
    assert service.snapshot(run.id).agent_runs[0].status == "uncertain"


def test_three_roles_require_versioned_human_approval_without_fourth_call(database, started):
    from codehead.workflow.worker import Worker

    service, run = started
    worker = Worker(worker_service(database), owner="worker-one")
    for _ in range(3):
        assert worker.run_once()
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert snapshot.tasks[2].status == "waiting_for_decision"
    assert len(snapshot.agent_runs) == 3
    assert {artifact.artifact_type for artifact in snapshot.artifacts} == {
        "requirements",
        "architecture",
        "api_contract",
        "decision",
    }
    decision = snapshot.decisions[0]
    with pytest.raises(DomainError):
        service.resolve_decision(
            decision.id, DecisionResolution(version=99, choice="approve"), "stale-choice", "test"
        )
    resolution = DecisionResolution(version=decision.version, choice="approve")
    first = service.resolve_decision(decision.id, resolution, "valid-choice", "test")
    repeated = service.resolve_decision(decision.id, resolution, "valid-choice", "test")
    assert first == repeated
    worker.run_once()
    final = service.snapshot(run.id)
    assert final.tasks[2].status == "succeeded"
    assert len(final.agent_runs) == 3
    assert final.run.status == "blocked"
    assert final.tasks[3].status == "blocked"


def test_request_limit_blocks_next_role_without_placeholder_success(database):
    from codehead.workflow.worker import Worker

    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Budget", description="Synthetic clinic budget."), "create-budget"
    )
    run = service.start_run(
        project.id, StartRun(mode="test", limits=RunLimits(max_llm_calls=1)), "start-budget", "test"
    )
    worker = Worker(worker_service(database), owner="budget-worker")
    worker.run_once()
    worker.run_once()
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert len(snapshot.agent_runs) == 1
    assert snapshot.tasks[1].status == "blocked"


def test_worker_provider_executes_outside_run_transaction(database, started):
    from codehead.persistence.models import Run
    from codehead.workflow.worker import Worker

    service, run = started

    class InspectingProvider(TestProvider):
        def run(self, request):
            with database.sessions.begin() as session:
                assert session.scalar(
                    select(Run).where(Run.id == run.id).with_for_update(nowait=True)
                )
            return super().run(request)

    assert Worker(
        worker_service(database), owner="outside-transaction", provider=InspectingProvider()
    ).run_once()
    assert service.snapshot(run.id).tasks[0].status == "succeeded"


def test_immutable_content_preserves_hash_and_trailing_newline(database, started):
    import hashlib

    from codehead.workflow.worker import Worker

    service, run = started
    Worker(worker_service(database), owner="content-worker").run_once()
    artifact = service.snapshot(run.id).artifacts[0]
    content = service.artifact_content(artifact.id)
    assert content.content.endswith("\n")
    assert content.content_hash == hashlib.sha256(content.content.encode("utf-8")).hexdigest()
    assert content.byte_size == len(content.content.encode("utf-8"))


def test_content_contract_preserves_significant_whitespace():
    from codehead.contracts import ArtifactContent

    content = "  preserved text\n"
    document = ArtifactContent(
        artifact_id="document",
        content_hash="hash",
        media_type="text/plain",
        byte_size=len(content),
        content=content,
    )
    assert document.content == content


def test_cto_approval_preserves_requested_pause(database, started):
    service, run = started
    worker = worker_service(database)
    for _ in range(2):
        lease = worker.claim("pause-cto")
        worker.begin(lease)
        worker.finish(lease, TestProvider().run(lease.request))
    lease = worker.claim("pause-cto")
    worker.begin(lease)
    service.run_command(run.id, RunCommand(command="pause"), "pause-cto-command", "test")
    worker.finish(lease, TestProvider().run(lease.request))
    decision = service.snapshot(run.id).decisions[0]
    service.resolve_decision(
        decision.id, DecisionResolution(version=1, choice="approve"), "approve-paused", "test"
    )
    assert service.snapshot(run.id).run.status == "paused"
    assert worker.claim("no-new-work") is None


def test_unconfigured_live_never_uses_test_provider_or_fake_activity(database):
    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Live", description="A saved live request without a provider."),
        "create-live",
    )
    run = service.start_run(project.id, StartRun(), "start-live", "test")
    assert worker_service(database).claim("live-worker", TestProvider()) is None
    snapshot = service.snapshot(run.id)
    assert snapshot.run.mode == "live"
    assert snapshot.run.status == "blocked"
    assert snapshot.agent_runs == []
    assert snapshot.usage.cost_usd is None
    assert snapshot.agents[0].lifecycle == "offline"
    assert snapshot.agents[0].activity is None


def test_known_provider_failure_completes_requested_cancellation(database, started):
    from codehead.llm.provider import ProviderFailure

    service, run = started
    worker = worker_service(database)
    lease = worker.claim("failure-worker")
    worker.begin(lease)
    service.run_command(run.id, RunCommand(command="cancel"), "cancel-failure", "test")
    worker.fail(lease, ProviderFailure("known_failure", "Known completed failure", dispatched=True))
    assert service.snapshot(run.id).run.status == "cancelled"


def test_confirmed_pre_dispatch_failure_is_not_counted_as_sent_request(database, started):
    from codehead.llm.provider import ProviderFailure

    service, run = started
    worker = worker_service(database)
    lease = worker.claim("no-dispatch")
    worker.begin(lease)
    worker.fail(
        lease, ProviderFailure("pre_dispatch", "Confirmed before dispatch", dispatched=False)
    )
    assert service.snapshot(run.id).usage.request_count == 0


def make_uncertain(database, started, *, paused=False):
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("lost-for-review")
    worker.begin(lease)
    if paused:
        started[0].run_command(
            started[1].id, RunCommand(command="pause"), "pause-before-loss", "test"
        )
    clock.advance(11)
    worker.recover()
    return worker, lease


def test_risk_retry_retains_confirmation_path_without_rewriting_succeeded_task(database, started):
    service, run = started
    worker, old = make_uncertain(database, started)
    decision = service.snapshot(run.id).decisions[0]
    service.resolve_decision(
        decision.id,
        DecisionResolution(
            version=1, choice="retry_with_risk", comment="Explicit duplicate risk accepted."
        ),
        "retry-risk",
        "test",
    )
    fresh = worker.claim("retry-worker")
    worker.begin(fresh)
    worker.finish(fresh, TestProvider().run(fresh.request))
    successful_task = service.snapshot(run.id).tasks[0]
    service.run_command(run.id, RunCommand(command="cancel"), "cancel-after-retry", "test")
    waiting = service.snapshot(run.id)
    followup = next(
        (
            item
            for item in waiting.decisions
            if item.status == "open" and item.attempt_id == old.attempt_id
        ),
        None,
    )
    assert followup is not None
    assert not followup.blocking
    assert followup.choices == ["confirm_failed"]
    service.resolve_decision(
        followup.id,
        DecisionResolution(
            version=1, choice="confirm_failed", comment="Confirmed failure from provider report."
        ),
        "confirm-old",
        "test",
    )
    final = service.snapshot(run.id)
    assert final.run.status == "cancelled"
    assert final.tasks[0] == successful_task
    assert final.agent_runs[0].status == "failed"


def test_risk_grant_never_reports_paused_while_old_outcome_unknown(database, started):
    service, run = started
    make_uncertain(database, started, paused=True)
    decision = service.snapshot(run.id).decisions[0]
    service.resolve_decision(
        decision.id,
        DecisionResolution(
            version=1, choice="retry_with_risk", comment="Duplicate risk accepted after review."
        ),
        "risk-paused",
        "test",
    )
    snapshot = service.snapshot(run.id)
    assert snapshot.run.pause_requested
    assert snapshot.run.status == "blocked"
    assert snapshot.agent_runs[0].status == "uncertain"


def test_approval_between_accept_and_claim_cannot_repeat_cto(database, started):
    from codehead.workflow.worker import Worker

    service, run = started
    normal = Worker(worker_service(database), owner="normal-worker")
    for _ in range(3):
        normal.run_once()
    base = type(worker_service(database))

    class ApprovingBetweenTransactions(base):
        def accept_decisions(self):
            accepted = super().accept_decisions()
            decision = service.snapshot(run.id).decisions[0]
            if decision.status == "open":
                service.resolve_decision(
                    decision.id,
                    DecisionResolution(version=1, choice="approve"),
                    "between-transactions",
                    "test",
                )
            return accepted

    Worker(ApprovingBetweenTransactions(database), owner="race-worker").run_once()
    assert len(service.snapshot(run.id).agent_runs) == 3


def test_deadline_is_rechecked_immediately_before_dispatch(database, started):
    from codehead.persistence.models import Run

    service, run = started
    with database.sessions.begin() as session:
        session.get(Run, run.id).limits = {**run.limits.model_dump(), "max_duration_seconds": 60}
    clock = Clock()
    clock.value = run.created_at + timedelta(seconds=59)
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("deadline-worker")
    clock.advance(2)
    assert not worker.begin(lease)
    assert service.snapshot(run.id).run.status == "blocked"
    assert service.snapshot(run.id).usage.request_count == 0


def test_idle_heartbeat_expiry_records_offline_lifecycle(database, started):
    service, run = started
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("idle-worker")
    worker.begin(lease)
    worker.finish(lease, TestProvider().run(lease.request))
    cursor = service.snapshot(run.id).last_event_seq
    clock.advance(11)
    worker.recover()
    snapshot = service.snapshot(run.id)
    assert all(agent.lifecycle == "offline" for agent in snapshot.agents)
    assert snapshot.last_event_seq > cursor


def test_late_provider_failure_after_recovery_does_not_crash_worker(database, started):
    from codehead.llm.provider import ProviderFailure
    from codehead.workflow.worker import Worker

    service, run = started
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)

    class LostProvider(TestProvider):
        def run(self, request):
            clock.advance(11)
            worker.recover()
            raise ProviderFailure(
                "late_failure", "Late unknown outcome", dispatched=True, uncertain=True
            )

    assert Worker(worker, owner="late-worker", provider=LostProvider()).run_once()
    assert service.snapshot(run.id).agent_runs[0].status == "uncertain"


def test_reconnected_worker_marks_paused_roles_idle_without_dispatch(database, started):
    service, run = started
    clock = Clock()
    worker = worker_service(database, clock=clock, lease_seconds=10)
    lease = worker.claim("original-worker")
    worker.begin(lease)
    worker.finish(lease, TestProvider().run(lease.request))
    service.run_command(run.id, RunCommand(command="pause"), "pause-idle-worker", "test")
    clock.advance(11)
    worker.recover()
    assert service.snapshot(run.id).agents[0].lifecycle == "offline"
    worker.register("reconnected-worker")
    snapshot = service.snapshot(run.id)
    assert all(agent.lifecycle == "idle" for agent in snapshot.agents[:3])
    assert snapshot.run.status == "paused"
    assert len(snapshot.agent_runs) == 1


def grant_risk(service, run):
    decision = next(
        item
        for item in service.snapshot(run.id).decisions
        if item.status == "open" and item.blocking
    )
    service.resolve_decision(
        decision.id,
        DecisionResolution(
            version=decision.version,
            choice="retry_with_risk",
            comment="Duplicate risk explicitly accepted.",
        ),
        "grant-related-risk",
        "test",
    )
    return next(
        item
        for item in service.snapshot(run.id).decisions
        if item.status == "open" and not item.blocking
    )


def test_pause_after_risk_grant_stays_blocked_until_old_outcome_known(database, started):
    service, run = started
    make_uncertain(database, started)
    grant_risk(service, run)
    service.run_command(run.id, RunCommand(command="pause"), "pause-after-risk", "test")
    assert service.snapshot(run.id).run.status == "blocked"


def test_old_confirmation_does_not_report_paused_while_fresh_retry_running(database, started):
    service, run = started
    worker, _ = make_uncertain(database, started)
    confirmation = grant_risk(service, run)
    fresh = worker.claim("fresh-running")
    worker.begin(fresh)
    service.run_command(run.id, RunCommand(command="pause"), "pause-new-running", "test")
    service.resolve_decision(
        confirmation.id,
        DecisionResolution(
            version=1, choice="confirm_failed", comment="Old operation failed per verified report."
        ),
        "confirm-old-running",
        "test",
    )
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "pausing"
    assert snapshot.tasks[0].status == "running"
    worker.finish(fresh, TestProvider().run(fresh.request))
    assert service.snapshot(run.id).run.status == "paused"


def test_optional_confirmation_preserves_real_next_stage_blocker(database, started):
    from codehead.workflow.worker import Worker

    service, run = started
    worker, _ = make_uncertain(database, started)
    confirmation = grant_risk(service, run)
    driver = Worker(worker, owner="stage-blocker")
    for _ in range(3):
        driver.run_once()
    approval = next(
        item for item in service.snapshot(run.id).decisions if item.kind == "architecture_approval"
    )
    service.resolve_decision(
        approval.id, DecisionResolution(version=1, choice="approve"), "approve-after-risk", "test"
    )
    driver.run_once()
    reason = service.snapshot(run.id).run.blocked_reason
    assert "Backend/Frontend" in reason
    service.resolve_decision(
        confirmation.id,
        DecisionResolution(
            version=1, choice="confirm_failed", comment="Previous request confirmed failed."
        ),
        "confirm-after-stage",
        "test",
    )
    assert service.snapshot(run.id).run.blocked_reason == reason


def test_normal_worker_records_actual_instruction_version_and_operations(database, started):
    from codehead.workflow.worker import Worker

    service, run = started
    Worker(worker_service(database), owner="instruction-metadata").run_once()
    snapshot = service.snapshot(run.id)
    for agent in snapshot.agents[:3]:
        assert agent.instructions_version == "worker-test-v1"
        assert {"read_inputs", "propose_artifacts"} <= set(agent.allowed_operations)
    assert snapshot.agent_runs[0].parameters["instructions_version"] == "worker-test-v1"


def test_worker_state_command_preserves_http_correlation(database, started):
    from codehead.workflow.worker import Worker

    service, run = started
    Worker(worker_service(database), owner="correlation-worker").run_once()
    service.run_command(
        run.id, RunCommand(command="pause"), "pause-correlation", "http-pause-correlation"
    )
    assert service.events(run.id).events[-1].correlation_id == "http-pause-correlation"


def test_decision_resolution_preserves_http_correlation(database, started):
    from codehead.workflow.worker import Worker

    service, run = started
    worker = Worker(worker_service(database), owner="decision-correlation-worker")
    for _ in range(3):
        worker.run_once()
    decision = service.snapshot(run.id).decisions[0]
    service.resolve_decision(
        decision.id,
        DecisionResolution(version=1, choice="approve"),
        "resolve-correlation",
        "http-decision-correlation",
    )
    assert service.events(run.id).events[-1].correlation_id == "http-decision-correlation"
