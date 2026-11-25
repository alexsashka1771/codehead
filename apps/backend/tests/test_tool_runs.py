from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from conftest import command_headers
from test_candidate_worker import approve_architecture, create_run

from codehead import contracts
from codehead.contracts import RunCommand
from codehead.errors import DomainError
from codehead.persistence.models import Run, WorkerHeartbeat
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService


def ready_run(database, tmp_path, **kwargs):
    service, run = create_run(database)
    engine = WorkerService(database, workspace_root=tmp_path, **kwargs)
    worker = Worker(engine, owner="tools-worker")
    approve_architecture(service, run, worker)
    for _ in range(3):
        assert worker.run_once()
    assert service.snapshot(run.id).candidate.status == "ready"
    return service, run, engine


def command(service, run, **changes):
    candidate = service.snapshot(run.id).candidate
    values = dict(
        operation_id="validate_backend",
        workspace_id=candidate.id,
        snapshot_version=candidate.revision,
    )
    values.update(changes)
    return contracts.ToolCommand(**values)


def test_queue_is_idempotent_immutable_and_visible_in_snapshot_and_event(database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    assert hasattr(service, "queue_tool"), "Manual trusted checks need a persisted tool queue"
    request = command(service, run)
    before = service.snapshot(run.id)
    queued = service.queue_tool(run.id, request, "manual-tool-command", "tools")
    assert queued.status == "created"
    assert queued.snapshot_version == before.candidate.revision
    assert queued.tree_hash == before.candidate.tree_hash
    assert queued.profile_hash == before.run.profile_hash
    assert queued.stdout == queued.stderr == ""
    assert queued.commands == [] and queued.report is None
    assert service.queue_tool(run.id, request, "manual-tool-command", "tools") == queued
    with pytest.raises(DomainError) as conflict:
        service.queue_tool(
            run.id, command(service, run, timeout_seconds=17), "manual-tool-command", "tools"
        )
    assert conflict.value.code == "conflict"
    with pytest.raises(DomainError) as duplicate:
        service.queue_tool(run.id, request, "another-tool-command", "tools")
    assert duplicate.value.code == "conflict"
    after = service.snapshot(run.id)
    assert after.tool_runs == [queued]
    assert len(after.agent_runs) == len(before.agent_runs)
    assert after.usage == before.usage
    event = service.events(run.id, before.last_event_seq).events[-1]
    assert event.payload.tool_runs == [queued]
    assert event.task_id is None
    lease = engine.claim_tool("tools-worker")
    assert engine.begin_tool(lease)
    assert service.queue_tool(run.id, request, "manual-tool-command", "tools") == queued


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"workspace_id": str(uuid4())}, "conflict"),
        ({"snapshot_version": 999}, "conflict"),
        ({"required_isolation": "container"}, "runner_unavailable"),
        ({"required_isolation": "remote"}, "runner_unavailable"),
    ],
)
def test_queue_rejects_stale_or_unsupported_checks(database, tmp_path, changes, code):
    service, run, _ = ready_run(database, tmp_path)
    assert hasattr(service, "queue_tool"), "Tool queue is missing"
    with pytest.raises(DomainError) as failure:
        service.queue_tool(run.id, command(service, run, **changes), "rejected-command", "tools")
    assert failure.value.code == code
    assert service.tool_runs(run.id) == []


def test_pause_cancels_queued_without_dispatch(database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    assert hasattr(service, "queue_tool"), "Tool queue is missing"
    tool = service.queue_tool(run.id, command(service, run), "paused-tool-command", "tools")
    lease = engine.claim_tool("tools-worker")
    service.run_command(run.id, RunCommand(command="pause"), "pause-tools-command", "tools")
    assert engine.begin_tool(lease) is False
    saved = service.tool_runs(run.id)[0]
    assert saved.id == tool.id and saved.status == "cancelled"
    assert saved.started_at is None


def test_api_queue_requires_command_security_and_never_executes_runner(client, database, tmp_path):
    service, run, engine = ready_run(database, tmp_path)
    body = command(service, run).model_dump()
    endpoint = f"/api/runs/{run.id}/tools/commands"
    assert client.post(endpoint, json=body).status_code == 403
    assert (
        client.post(
            endpoint, headers={**command_headers(), "Origin": "http://127.0.0.1:9999"}, json=body
        ).status_code
        == 403
    )
    queued = client.post(endpoint, headers=command_headers("api-tool-command"), json=body)
    assert queued.status_code == 202, queued.text
    assert queued.json()["status"] == "created"
    assert queued.json()["started_at"] is None
    assert (
        client.post(endpoint, headers=command_headers("api-tool-command"), json=body).json()
        == queued.json()
    )
    listed = client.get(f"/api/runs/{run.id}/tools").json()
    assert len(listed) == 1
    differences = {
        key: (value, listed[0].get(key))
        for key, value in queued.json().items()
        if value != listed[0].get(key)
    }
    assert differences == {}
    assert client.get(f"/api/runs/{run.id}/snapshot").json()["tool_runs"] == [queued.json()]
    for change in (
        {"operation_id": "smoke_test"},
        {"command": "whoami"},
        {"timeout_seconds": 181},
        {"output_limit_bytes": 0},
        {"workspace_id": "bad-id"},
    ):
        rejected = client.post(endpoint, headers=command_headers(), json={**body, **change})
        assert rejected.status_code == 422


def test_concurrent_same_key_reuses_operation_and_different_keys_reserve_once(database, tmp_path):
    service, run, _ = ready_run(database, tmp_path)
    request = command(service, run)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(service.queue_tool, run.id, request, "same-tool-command", "tools")
            for _ in range(2)
        ]
        queued = [future.result(timeout=5) for future in futures]
    assert queued[0] == queued[1]

    def submit(key):
        try:
            return service.queue_tool(
                run.id, command(service, run, operation_id="test_backend"), key, "tools"
            )
        except DomainError as failure:
            return failure.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(submit, key) for key in ("first-other-tool", "second-other-tool")]
        results = [future.result(timeout=5) for future in futures]
    assert results.count("conflict") == 1
    assert len(service.tool_runs(run.id)) == 2


@pytest.mark.parametrize("field", ["profile_hash", "acceptance_suite_hash", "template_hash"])
def test_queue_rejects_changed_run_pins(database, tmp_path, field):
    service, run, _ = ready_run(database, tmp_path)
    request = command(service, run)
    with database.sessions.begin() as session:
        setattr(session.get(Run, run.id), field, "f" * 64)
    with pytest.raises(DomainError) as failure:
        service.queue_tool(run.id, request, "stale-pins-command", "tools")
    assert failure.value.code == "conflict"


@pytest.mark.parametrize("state", ["cancelled", "succeeded", "live"])
def test_queue_rejects_terminal_or_live_run(database, tmp_path, state):
    service, run, _ = ready_run(database, tmp_path)
    request = command(service, run)
    with database.sessions.begin() as session:
        stored = session.get(Run, run.id)
        if state == "live":
            stored.mode = "live"
        else:
            stored.status = state
    with pytest.raises(DomainError) as failure:
        service.queue_tool(run.id, request, "terminal-tool-command", "tools")
    assert failure.value.code == "conflict"


def test_capability_requires_all_registered_tools_and_unions_worker_support(client, database):
    from datetime import timedelta

    from codehead.persistence.service import ProjectService, now

    service = ProjectService(database)

    def capability():
        return next(
            item
            for item in client.get("/api/capabilities").json()["capabilities"]
            if item["id"] == "runner"
        )

    assert capability()["status"] == "disabled"
    with database.sessions.begin() as session:
        session.add(
            WorkerHeartbeat(
                owner="partial-one",
                supported_roles=[],
                supported_tools=["validate_backend", "test_backend"],
                updated_at=now(),
                expires_at=now() + timedelta(seconds=60),
            )
        )
    assert capability()["status"] == "disabled"
    assert not service.worker_connected(required_tools=("build_frontend",))
    with database.sessions.begin() as session:
        session.add(
            WorkerHeartbeat(
                owner="partial-two",
                supported_roles=[],
                supported_tools=["build_frontend"],
                updated_at=now(),
                expires_at=now() + timedelta(seconds=60),
            )
        )
    assert capability()["status"] == "available"
    assert "process_only" in capability()["reason"]
    assert "preview" in capability()["reason"].lower()


def test_queue_rejects_run_without_candidate(database):
    service, run = create_run(database)
    request = contracts.ToolCommand(
        operation_id="validate_backend", workspace_id=str(uuid4()), snapshot_version=1
    )
    with pytest.raises(DomainError) as failure:
        service.queue_tool(run.id, request, "no-candidate-command", "tools")
    assert failure.value.code == "conflict"
    assert service.tool_runs(run.id) == []


def test_manual_output_preserves_whitespace_and_redacts_provided_secrets(database, tmp_path):
    from test_tool_worker import result

    service, run, engine = ready_run(database, tmp_path, secrets=("test-private-value",))
    service.queue_tool(run.id, command(service, run), "output-tool-command", "tools")
    lease = engine.claim_tool("executor")
    assert engine.begin_tool(lease)
    engine.finish_tool(lease, result(stdout="  checked test-private-value\n", stderr=" error\n"))
    tool = service.tool_runs(run.id)[0]
    assert tool.stdout == "  checked [REDACTED:secret]\n"
    assert tool.stderr == " error\n"
