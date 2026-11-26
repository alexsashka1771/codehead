from datetime import UTC, datetime, timedelta
from uuid import uuid4

from conftest import command_headers
from test_candidate_persistence import apply
from test_candidate_persistence import prepared as prepared

from codehead.contracts import FileProposal
from codehead.persistence.models import WorkerHeartbeat
from codehead.workflow.worker_service import WorkerService


def test_candidate_descriptor_is_the_same_version_as_snapshot(client, prepared):
    _, service, _, run = prepared
    response = client.get(f"/api/runs/{run.id}/candidate")
    assert response.status_code == 200
    assert response.json() == service.snapshot(run.id).model_dump(mode="json")["candidate"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "content_text" not in response.text


def test_artifact_list_is_scoped_to_the_requested_run(client, prepared, project):
    _, service, _, run = prepared
    response = client.get(f"/api/runs/{run.id}/artifacts")
    assert response.status_code == 200
    assert response.json() == service.snapshot(run.id).model_dump(mode="json")["artifacts"]
    cancelled = client.post(
        f"/api/runs/{run.id}/commands", json={"command": "cancel"}, headers=command_headers()
    )
    assert cancelled.status_code == 200
    other = client.post(
        f"/api/projects/{project['id']}/runs", json={"mode": "test"}, headers=command_headers()
    )
    assert other.status_code == 201
    other_id = other.json()["id"]
    assert client.get(f"/api/runs/{other_id}/artifacts").json() == []
    assert client.get(f"/api/runs/{other_id}/candidate").json() is None


def test_candidate_read_apis_reject_an_unknown_run(client):
    unknown = str(uuid4())
    for suffix in ("artifacts", "candidate"):
        response = client.get(f"/api/runs/{unknown}/{suffix}")
        assert response.status_code == 404
        assert response.json()["code"] == "not_found"


def test_source_content_is_returned_as_json_data_with_nosniff(client, prepared):
    content = "<script>window.candidateExecuted = true;</script>\n"
    snapshot = apply(
        prepared,
        "frontend",
        [
            FileProposal(
                relative_path="frontend/src/App.tsx", content=content, media_type="text/tsx"
            )
        ],
    )
    source = next(
        artifact
        for artifact in snapshot.artifacts
        if artifact.relative_path == "frontend/src/App.tsx"
    )
    response = client.get(f"/api/artifacts/{source.id}/content")
    assert response.status_code == 200
    assert response.json()["content"] == content
    assert response.json()["content_hash"] == source.content_hash
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["x-content-type-options"] == "nosniff"


def test_capabilities_advertise_engineer_files_qa_and_preview_for_the_v4_worker(client, database):
    WorkerService(database).register("candidate-api-capabilities")
    response = client.get("/api/capabilities")
    assert response.status_code == 200
    capabilities = {item["id"]: item for item in response.json()["capabilities"]}
    assert capabilities.get("candidate_files") is not None
    assert capabilities["candidate_files"]["status"] == "available"
    assert "Backend" in capabilities["candidate_files"]["reason"]
    assert "Frontend" in capabilities["candidate_files"]["reason"]
    assert capabilities["qa_execution"]["status"] == "available"
    assert capabilities["delivery"]["status"] == capabilities["preview"]["status"] == "available"
    assert client.get("/health").json()["stage"] == "worker"


def test_legacy_worker_heartbeat_does_not_enable_engineer_file_generation(client, database):
    stamp = datetime.now(UTC)
    with database.sessions.begin() as session:
        session.add(
            WorkerHeartbeat(
                owner="legacy-api-capabilities",
                supported_roles=["product_manager", "architect", "cto"],
                updated_at=stamp,
                expires_at=stamp + timedelta(seconds=30),
            )
        )
    capabilities = {
        item["id"]: item for item in client.get("/api/capabilities").json()["capabilities"]
    }
    assert capabilities["worker"]["status"] == "available"
    assert capabilities.get("candidate_files") is not None
    assert capabilities["candidate_files"]["status"] == "disabled"
    assert capabilities["delivery"]["status"] == capabilities["preview"]["status"] == "disabled"


def test_source_only_heartbeat_does_not_enable_the_initial_role_chain(client, database):
    stamp = datetime.now(UTC)
    with database.sessions.begin() as session:
        session.add(
            WorkerHeartbeat(
                owner="source-only-api",
                supported_roles=["backend", "frontend"],
                updated_at=stamp,
                expires_at=stamp + timedelta(seconds=30),
            )
        )
    capabilities = {
        item["id"]: item for item in client.get("/api/capabilities").json()["capabilities"]
    }
    assert capabilities["worker"]["status"] == "available"
    assert capabilities["first_roles"]["status"] == "disabled"
    assert capabilities["test_execution"]["status"] == "disabled"
