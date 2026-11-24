import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from test_candidate_worker import Clock
from test_tool_runs import command, ready_run

from codehead.contracts import DecisionResolution, RunCommand
from codehead.errors import DomainError
from codehead.persistence.models import Artifact, Candidate, Run, ToolRun
from codehead.workflow.worker import Worker


def result(**changes):
    values = dict(
        status="succeeded",
        commands=[["python", "-m", "compileall"]],
        stdout="checked",
        stderr="",
        exit_code=0,
        error_code=None,
        error_message=None,
        report={"passed": True},
        process_id=123,
    )
    values.update(changes)
    return SimpleNamespace(**values)


class ControlledRunner:
    def __init__(self, execute=None):
        self.requests = []
        self.callback = execute

    def execute(self, request, *, should_stop):
        self.requests.append(request)
        return self.callback(request, should_stop) if self.callback else result()


def test_worker_dispatches_tool_without_llm_and_persists_known_result(database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    runner = ControlledRunner()
    engine.tool_runner = runner
    before = service.snapshot(run.id)
    queued = service.queue_tool(run.id, command(service, run), "worker-tool-command", "tools")
    assert Worker(engine, owner="executor").run_once(), "Worker must consume queued tools"
    assert len(runner.requests) == 1
    request = runner.requests[0]
    assert request.tool_run_id == queued.id
    assert request.candidate.tree_hash == queued.tree_hash
    after = service.snapshot(run.id)
    tool = after.tool_runs[0]
    assert tool.status == "succeeded"
    assert tool.stdout == "checked" and tool.exit_code == 0
    assert tool.commands == [["python", "-m", "compileall"]]
    assert tool.report == {"passed": True} and tool.process_id == 123
    assert after.agent_runs == before.agent_runs and after.usage == before.usage
    assert (
        service.queue_tool(run.id, command(service, run), "worker-tool-command", "tools") == queued
    )


@pytest.mark.parametrize("control", ["pause", "cancel"])
def test_running_tool_honors_control_and_only_finishes_after_process_stops(
    database, tmp_path, control
):
    service, run, engine = ready_run(database, tmp_path)
    entered, released = threading.Event(), threading.Event()

    def execute(request, should_stop):
        entered.set()
        assert released.wait(5)
        assert should_stop()
        return result(status="cancelled", stdout="stopped", exit_code=None)

    engine.tool_runner = ControlledRunner(execute)
    service.queue_tool(run.id, command(service, run), "controlled-tool-command", "tools")
    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(Worker(engine, owner="executor").run_once)
        assert entered.wait(5), "Queued Runner process was not dispatched"
        changed = service.run_command(
            run.id, RunCommand(command=control), "stop-tool-command", "tools"
        )
        assert changed.status != "cancelled"
        released.set()
        assert running.result(timeout=5)
    assert service.tool_runs(run.id)[0].status == "cancelled"
    if control == "cancel":
        assert service.snapshot(run.id).run.status == "cancelled"
    else:
        resumed = service.run_command(
            run.id, RunCommand(command="resume"), "resume-tool-command", "tools"
        )
        assert not resumed.pause_requested
        service.queue_tool(run.id, command(service, run), "after-pause-tool-command", "tools")


def test_expiry_after_dispatch_is_uncertain_and_fenced_until_matching_confirmation(
    database, tmp_path
):
    clock = Clock()
    service, run, engine = ready_run(database, tmp_path, clock=clock, lease_seconds=3)
    service.queue_tool(run.id, command(service, run), "expiry-tool-command", "tools")
    lease = engine.claim_tool("lost-worker")
    assert engine.begin_tool(lease)
    clock.advance(4)
    assert engine.recover() >= 1
    after = service.snapshot(run.id)
    tool = after.tool_runs[0]
    assert tool.status == "uncertain" and tool.finished_at is None
    assert after.run.status == "blocked"
    decision = next(item for item in after.decisions if item.kind == "tool_uncertain_outcome")
    assert decision.tool_run_id == tool.id and decision.task_id is None
    assert decision.choices == ["confirm_failed"]
    assert engine.claim_tool("new-worker") is None
    with pytest.raises(DomainError) as late:
        engine.finish_tool(lease, result())
    assert late.value.code == "stale_tool"
    service.run_command(run.id, RunCommand(command="cancel"), "cancel-uncertain-tool", "tools")
    assert service.snapshot(run.id).run.status == "blocked"
    with pytest.raises(DomainError) as short:
        service.resolve_decision(
            decision.id,
            DecisionResolution(version=decision.version, choice="confirm_failed", comment="no"),
            "confirm-tool-short",
            "tools",
        )
    assert short.value.status == 422
    resolved = service.resolve_decision(
        decision.id,
        DecisionResolution(
            version=decision.version,
            choice="confirm_failed",
            comment="Confirmed that the owned process tree has stopped.",
        ),
        "confirm-tool-command",
        "tools",
    )
    assert resolved.status == "cancelled"
    assert service.tool_runs(run.id)[0].status == "failed"


def test_claim_verifies_source_artifact_content_and_prevents_process_dispatch(database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    service.queue_tool(run.id, command(service, run), "corrupted-tool-command", "tools")
    candidate = service.snapshot(run.id).candidate
    with database.sessions.begin() as session:
        artifact = session.get(Artifact, candidate.files[0].artifact_id)
        artifact.content_text += "changed"
    assert engine.claim_tool("executor") is None
    tool = service.tool_runs(run.id)[0]
    assert tool.status == "failed" and tool.error_code == "input_version_conflict"
    assert tool.started_at is None


def test_lease_before_dispatch_expiry_cancels_without_uncertain_decision(database, tmp_path):
    clock = Clock()
    service, run, engine = ready_run(database, tmp_path, clock=clock, lease_seconds=3)
    service.queue_tool(run.id, command(service, run), "predispatch-expiry-tool", "tools")
    lease = engine.claim_tool("executor")
    clock.advance(4)
    assert engine.recover() >= 1
    assert service.tool_runs(run.id)[0].status == "cancelled"
    assert not any(item.kind == "tool_uncertain_outcome" for item in service.decisions(run.id))
    with pytest.raises(DomainError):
        engine.begin_tool(lease)


def test_parallel_limit_counts_reserved_and_running_tools(database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    with database.sessions.begin() as session:
        stored = session.get(Run, run.id)
        stored.limits = {**stored.limits, "max_parallel_tasks": 1}
    for index, operation in enumerate(("validate_backend", "test_backend")):
        service.queue_tool(
            run.id, command(service, run, operation_id=operation), f"parallel-tool-{index}", "tools"
        )
    first = engine.claim_tool("first-worker")
    assert first is not None
    assert engine.claim_tool("second-worker") is None
    assert engine.begin_tool(first)
    assert engine.claim_tool("second-worker") is None
    engine.finish_tool(first, result())
    assert engine.claim_tool("second-worker") is not None


@pytest.mark.parametrize(
    "field",
    [
        "revision",
        "tree_hash",
        "profile_hash",
        "acceptance_suite_hash",
        "manifest_artifact_id",
        "files",
        "workspace_path",
    ],
)
def test_late_result_cannot_commit_when_candidate_pins_change(database, tmp_path, field):
    service, run, engine = ready_run(database, tmp_path)
    service.queue_tool(run.id, command(service, run), "late-pins-command", "tools")
    lease = engine.claim_tool("executor")
    assert engine.begin_tool(lease)
    with database.sessions.begin() as session:
        stored = session.get(Candidate, lease.candidate.id)
        if field == "revision":
            stored.revision += 1
        elif field == "manifest_artifact_id":
            stored.manifest_artifact_id = lease.candidate.files[0].artifact_id
        elif field == "files":
            stored.files = [{**file, "origin": "human"} for file in stored.files]
        elif field == "workspace_path":
            stored.workspace_path += "-changed"
        else:
            setattr(stored, field, "f" * 64)
    with pytest.raises(DomainError) as late:
        engine.finish_tool(lease, result())
    assert late.value.code == "stale_tool"
    assert service.tool_runs(run.id)[0].status == "running"


def test_runner_exception_after_dispatch_marks_uncertain_without_fake_failed_report(
    database, tmp_path
):
    service, run, engine = ready_run(database, tmp_path)

    def execute(request, should_stop):
        failure = RuntimeError("unknown external process outcome")
        failure.process_id = 1234
        failure.commands = [["python", "-m", "py_compile"]]
        raise failure

    engine.tool_runner = ControlledRunner(execute)
    service.queue_tool(run.id, command(service, run), "unexpected-tool-command", "tools")
    assert Worker(engine, owner="executor").run_once()
    saved = service.tool_runs(run.id)[0]
    assert saved.status == "uncertain" and saved.report is None
    assert saved.error_code == "runner_unknown_outcome"
    assert saved.process_id == 1234
    assert saved.commands == [["python", "-m", "py_compile"]]
    assert any(item.tool_run_id == saved.id for item in service.decisions(run.id))


def test_timeout_is_distinct_terminal_result_and_releases_operation_reservation(database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    service.queue_tool(run.id, command(service, run), "timed-out-tool-command", "tools")
    lease = engine.claim_tool("executor")
    assert engine.begin_tool(lease)
    timed_out = engine.finish_tool(
        lease,
        result(
            status="timed_out",
            exit_code=None,
            error_code="tool_timeout",
            error_message="Owned process tree stopped after timeout.",
        ),
    )
    assert timed_out.status == "timed_out"
    assert timed_out.finished_at is not None
    assert timed_out.lease_owner is None and timed_out.lease_expires_at is None
    assert service.snapshot(run.id).tool_runs[0].status == "timed_out"
    event = service.events(run.id).events[-1]
    assert event.payload.action == "tool.timed_out"
    assert event.payload.tool_runs[0].status == "timed_out"
    assert (
        service.queue_tool(run.id, command(service, run), "retry-timed-out-tool", "tools").status
        == "created"
    )


@pytest.mark.parametrize("artifact_kind", ["source", "manifest"])
def test_finish_rejects_immutable_content_tamper_even_when_hash_metadata_is_unchanged(
    database, tmp_path, artifact_kind
):
    service, run, engine = ready_run(database, tmp_path)
    service.queue_tool(run.id, command(service, run), "tampered-content-command", "tools")
    lease = engine.claim_tool("executor")
    assert engine.begin_tool(lease)
    before = service.snapshot(run.id)
    artifact_id = (
        lease.candidate.manifest_artifact_id
        if artifact_kind == "manifest"
        else lease.candidate.files[0].artifact_id
    )
    with database.sessions.begin() as session:
        artifact = session.get(Artifact, artifact_id)
        original_hash, original_size = artifact.content_hash, artifact.byte_size
        artifact.content_text += "corrupted content"
        assert artifact.content_hash == original_hash and artifact.byte_size == original_size
    with pytest.raises(DomainError) as stale:
        engine.finish_tool(lease, result())
    assert stale.value.code == "stale_tool"
    saved = service.tool_runs(run.id)[0]
    assert saved.status == "running" and saved.finished_at is None
    assert saved.commands == [] and saved.stdout == "" and saved.report is None
    assert service.snapshot(run.id).last_event_seq == before.last_event_seq


@pytest.mark.parametrize(
    "field,value",
    [
        ("operation_id", "test_backend"),
        ("required_isolation", "remote"),
        ("timeout_seconds", 17),
        ("output_limit_bytes", 2048),
    ],
)
def test_finish_rejects_changed_tool_command_parameters(database, tmp_path, field, value):
    service, run, engine = ready_run(database, tmp_path)
    service.queue_tool(run.id, command(service, run), "changed-parameters-command", "tools")
    lease = engine.claim_tool("executor")
    assert engine.begin_tool(lease)
    with database.sessions.begin() as session:
        if field == "required_isolation":
            # Deliberately bypass the independent DB guard only in this fixture's isolated schema.
            session.execute(text("ALTER TABLE tool_runs DROP CONSTRAINT ck_tool_isolation"))
        setattr(session.get(ToolRun, lease.tool.id), field, value)
    with pytest.raises(DomainError) as stale:
        engine.finish_tool(lease, result())
    assert stale.value.code == "stale_tool"
    saved = service.tool_runs(run.id)[0]
    assert saved.status == "running" and saved.report is None and saved.finished_at is None
