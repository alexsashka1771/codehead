from conftest import command_headers

from codehead.persistence.models import Artifact
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService


def completed_roles(client, database, project):
    response = client.post(
        f"/api/projects/{project['id']}/runs", json={"mode": "test"}, headers=command_headers()
    )
    assert response.status_code == 201
    run = response.json()
    worker = Worker(WorkerService(database), owner="api-worker")
    for _ in range(3):
        worker.run_once()
    return run, client.get(f"/api/runs/{run['id']}/snapshot").json()


def test_worker_read_apis_return_persisted_documents_trace_and_usage(client, database, project):
    run, snapshot = completed_roles(client, database, project)
    attempts = client.get(f"/api/runs/{run['id']}/agent-runs")
    assert attempts.status_code == 200
    assert len(attempts.json()) == 3
    trace = client.get(f"/api/agent-runs/{attempts.json()[0]['id']}/trace")
    assert trace.status_code == 200
    assert trace.json()["raw_response"]
    artifact_id = snapshot["artifacts"][0]["id"]
    assert client.get(f"/api/artifacts/{artifact_id}").status_code == 200
    assert client.get(f"/api/artifacts/{artifact_id}/content").json()["content"]
    usage = client.get(f"/api/runs/{run['id']}/usage").json()
    assert usage == snapshot["usage"]
    assert usage["source"] == "test"
    assert usage["request_count"] == 3


def test_decision_api_rejects_stale_and_unauthenticated_answers(client, database, project):
    run, snapshot = completed_roles(client, database, project)
    decision = snapshot["decisions"][0]
    endpoint = f"/api/decisions/{decision['id']}/resolve"
    assert (
        client.post(
            endpoint, json={"version": 99, "choice": "approve"}, headers=command_headers()
        ).status_code
        == 409
    )
    headers = {**command_headers(), "X-CodeHead-Token": "invalid-token"}
    assert (
        client.post(endpoint, json={"version": 1, "choice": "approve"}, headers=headers).status_code
        == 403
    )
    assert (
        client.post(
            endpoint, json={"version": 1, "choice": "approve"}, headers=command_headers()
        ).status_code
        == 200
    )
    assert client.get(f"/api/runs/{run['id']}/decisions").json()[0]["status"] == "resolved"


def test_artifact_api_verifies_immutable_content_hash(client, database, project):
    _, snapshot = completed_roles(client, database, project)
    artifact_id = snapshot["artifacts"][0]["id"]
    with database.sessions.begin() as session:
        session.get(Artifact, artifact_id).content_text += "corruption"
    assert client.get(f"/api/artifacts/{artifact_id}/content").status_code == 409


def test_regular_api_observes_lost_idle_worker_and_records_offline(client, database, project):
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from codehead.persistence.models import WorkerHeartbeat

    run, before = completed_roles(client, database, project)
    with database.sessions.begin() as session:
        for heartbeat in session.scalars(select(WorkerHeartbeat)):
            heartbeat.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    after = client.get(f"/api/runs/{run['id']}/snapshot").json()
    assert all(agent["lifecycle"] == "offline" for agent in after["agents"])
    assert after["last_event_seq"] > before["last_event_seq"]
    events = client.get(f"/api/runs/{run['id']}/events?after_seq={before['last_event_seq']}").json()
    assert events["events"][-1]["payload"]["action"] == "worker.disconnected"
