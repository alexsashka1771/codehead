from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from conftest import command_headers
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from codehead.contracts import StartRun
from codehead.main import create_app
from codehead.persistence.models import CommandReceipt, Event, Run
from codehead.persistence.service import payload_hash

pytestmark = pytest.mark.integration


def start(client, project, key=None, **payload):
    return client.post(
        f"/api/projects/{project['id']}/runs",
        headers=command_headers(key),
        json={"mode": "live", **payload},
    )


def command(client, run_id, value, key=None):
    return client.post(
        f"/api/runs/{run_id}/commands", headers=command_headers(key), json={"command": value}
    )


def test_start_is_persisted_and_idempotent(client, database, project):
    key = str(uuid4())
    first = start(client, project, key)
    repeated = start(client, project, key)
    assert first.status_code == repeated.status_code == 201
    assert first.json() == repeated.json()
    run = first.json()
    snapshot = client.get(f"/api/runs/{run['id']}/snapshot").json()
    assert snapshot["run"]["status"] == "created"
    assert snapshot["last_event_seq"] == snapshot["run"]["last_event_seq"] == 8
    assert len(snapshot["tasks"]) == len(snapshot["agents"]) == 7
    assert all(agent["lifecycle"] == "offline" for agent in snapshot["agents"])
    with database.read() as session:
        assert session.scalar(select(func.count()).select_from(Run)) == 1
        assert session.scalar(select(func.count()).select_from(Event)) == 8


def test_same_key_with_changed_payload_is_a_conflict(client, project):
    key = str(uuid4())
    assert start(client, project, key).status_code == 201
    response = start(client, project, key, limits={"max_llm_calls": 12})
    assert response.status_code == 409
    assert response.json()["code"] == "conflict"


@pytest.mark.parametrize("version", ["clinic-v1", "clinic-v2", "clinic-v3"])
def test_implicit_start_replays_a_historical_default_receipt(client, database, project, version):
    key = str(uuid4())
    saved = start(client, project, key, workflow_version="clinic-v3").json()
    saved["workflow_version"] = version
    with database.sessions.begin() as session:
        run = session.get(Run, saved["id"])
        run.workflow_version = version
        receipt = session.get(CommandReceipt, (f"start:{project['id']}", key))
        receipt.response = saved
        receipt.params_hash = payload_hash(StartRun(workflow_version="clinic-v3"))

    replay = start(client, project, key)
    assert replay.status_code == 201
    assert replay.json() == saved
    assert start(client, project, key, workflow_version="clinic-v4").status_code == 409
    if version != "clinic-v1":
        assert start(client, project, key, workflow_version=version).json() == saved
    assert start(client, project, key, limits={"max_llm_calls": 8}).status_code == 409


@pytest.mark.parametrize("version,other", [("clinic-v2", "clinic-v4"), ("clinic-v4", "clinic-v3")])
def test_explicit_start_version_is_bound_to_one_run(client, project, version, other):
    key = str(uuid4())
    created = start(client, project, key, workflow_version=version)
    assert created.status_code == 201
    assert created.json()["workflow_version"] == version
    assert start(client, project, key, workflow_version=version).json() == created.json()
    assert start(client, project, key).json() == created.json()
    assert start(client, project, key, workflow_version=other).status_code == 409


def test_legacy_snapshot_and_workflow_event_default_to_empty_delivery_state(
    client, database, project
):
    run = start(client, project, workflow_version="clinic-v3", mode="test").json()
    service = client.app.state.service
    with database.sessions.begin() as session:
        row = service._run(session, run["id"], for_update=True)
        saved = service._emit_workflow(session, row, "worker.connected")
        event = session.get(Event, saved.event_id)
        event.payload = {
            name: value
            for name, value in event.payload.items()
            if name not in {"delivery", "preview_sessions"}
        }

    snapshot = client.get(f"/api/runs/{run['id']}/snapshot").json()
    event = client.get(f"/api/runs/{run['id']}/events?after_seq={saved.seq - 1}").json()["events"][
        0
    ]
    for state in (snapshot, event["payload"]):
        assert state["delivery"] is None
        assert state["preview_sessions"] == []


def test_concurrent_start_creates_one_run(client, project, database):
    key = str(uuid4())
    with ThreadPoolExecutor(max_workers=6) as executor:
        responses = list(executor.map(lambda _: start(client, project, key), range(6)))
    assert [response.status_code for response in responses] == [201] * 6
    assert len({response.json()["id"] for response in responses}) == 1
    with database.read() as session:
        assert session.scalar(select(func.count()).select_from(Run)) == 1
        assert session.scalar(select(func.count()).select_from(Event)) == 8


def test_different_start_keys_cannot_create_two_active_runs(client, project):
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: start(client, project), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]


def test_commands_preserve_history_and_are_idempotent(client, project):
    run = start(client, project).json()
    key = str(uuid4())
    paused = command(client, run["id"], "pause", key)
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"
    assert command(client, run["id"], "pause", key).json() == paused.json()
    assert command(client, run["id"], "resume").json()["status"] == "created"
    assert command(client, run["id"], "cancel").json()["status"] == "cancelled"
    snapshot = client.get(f"/api/runs/{run['id']}/snapshot").json()
    assert snapshot["last_event_seq"] == 11
    assert all(task["status"] == "cancelled" for task in snapshot["tasks"])
    assert command(client, run["id"], "resume").status_code == 409
    assert start(client, project).status_code == 201


def test_events_have_stable_pagination_and_match_snapshot(client, project):
    run = start(client, project).json()
    first = client.get(f"/api/runs/{run['id']}/events?after_seq=0&limit=3").json()
    assert [event["seq"] for event in first["events"]] == [1, 2, 3]
    assert first["has_more"] is True
    rest = client.get(f"/api/runs/{run['id']}/events?after_seq=3&limit=100").json()
    assert [event["seq"] for event in rest["events"]] == [4, 5, 6, 7, 8]
    assert rest["has_more"] is False
    assert rest["next_after_seq"] == rest["last_event_seq"] == 8
    assert first["events"][0]["event_type"] == "run.created"
    assert first["events"][1]["causation_id"] == first["events"][0]["event_id"]


def test_new_application_instance_restores_persisted_state(client, project, database):
    run = start(client, project).json()
    path = f"/api/runs/{run['id']}/snapshot"
    expected = client.get(path).json()
    with TestClient(create_app(settings=client.app.state.settings, database=database)) as other:
        assert other.get(path).json() == expected


def test_snapshot_is_consistent_when_cancel_commits_between_reads(client, project, monkeypatch):
    run = start(client, project).json()
    service = client.app.state.service
    original_project = service._project

    def cancel_after_run_read(session, project_id):
        with ThreadPoolExecutor(max_workers=1) as executor:
            response = executor.submit(command, client, run["id"], "cancel").result(timeout=5)
        assert response.status_code == 200
        return original_project(session, project_id)

    with monkeypatch.context() as patch:
        patch.setattr(service, "_project", cancel_after_run_read)
        snapshot = client.get(f"/api/runs/{run['id']}/snapshot").json()

    assert snapshot["run"]["status"] == "created"
    assert snapshot["last_event_seq"] == snapshot["run"]["last_event_seq"] == 8
    assert all(task["status"] == "queued" for task in snapshot["tasks"])
    after = client.get(f"/api/runs/{run['id']}/snapshot").json()
    assert after["run"]["status"] == "cancelled"
    assert after["last_event_seq"] == 9
    assert all(task["status"] == "cancelled" for task in after["tasks"])


def test_event_failure_rolls_back_run_tasks_and_receipt(client, project, database, monkeypatch):
    service = client.app.state.service

    def fail_event(*args, **kwargs):
        raise RuntimeError("Injected event storage failure")

    monkeypatch.setattr(service, "_record_event", fail_event)
    with pytest.raises(RuntimeError, match="Injected event"):
        start(client, project)
    with database.read() as session:
        assert session.scalar(select(func.count()).select_from(Run)) == 0
        assert session.scalar(select(func.count()).select_from(Event)) == 0
        assert (
            session.scalar(
                select(func.count())
                .select_from(CommandReceipt)
                .where(CommandReceipt.scope.like("start:%"))
            )
            == 0
        )


def test_websocket_backfills_only_committed_events(client, project):
    run = start(client, project).json()
    with client.websocket_connect(
        f"/api/runs/{run['id']}/stream?after_seq=7",
        headers={
            "Origin": "http://127.0.0.1:5180",
        },
    ) as websocket:
        assert websocket.receive_json()["seq"] == 8
        assert command(client, run["id"], "pause").status_code == 200
        event = websocket.receive_json()
        assert event["seq"] == 9
        assert event["event_type"] == "run.paused"
        assert event["payload"]["run"]["status"] == "paused"
