from uuid import uuid4

import pytest
from conftest import command_headers
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from codehead.main import create_app
from codehead.settings import Settings


def test_health_reports_unconfigured_database_without_faking_readiness():
    with TestClient(
        create_app(settings=Settings(database_url="", allowed_hosts=("testserver",)))
    ) as api:
        response = api.get("/health")
        assert response.json()["database"] == "unconfigured"
        assert api.get("/api/projects").status_code == 503
        capabilities = api.get("/api/capabilities").json()["capabilities"]
        assert next(c for c in capabilities if c["id"] == "worker")["status"] == "disabled"
        assert next(c for c in capabilities if c["id"] == "test_execution")["status"] == "disabled"


def test_foreign_webpage_cannot_issue_commands(client):
    headers = {**command_headers(), "Origin": "https://untrusted.example"}
    response = client.post("/api/projects", headers=headers, json={})
    assert response.status_code == 403
    assert response.json()["code"] == "origin_forbidden"


def test_command_header_is_required(client):
    response = client.post("/api/projects", json={})
    assert response.status_code == 403
    assert response.json()["code"] == "command_forbidden"


def test_errors_do_not_echo_input_or_internal_tracebacks(client):
    response = client.post(
        "/api/projects", headers=command_headers(), json={"name": "secret-sentinel"}
    )
    assert response.status_code == 422
    assert "secret-sentinel" not in response.text
    assert "Traceback" not in response.text
    assert response.json()["correlation_id"] == response.headers["X-Correlation-ID"]


def test_host_header_is_checked(client):
    response = client.get("/health", headers={"Host": "rebind.example"})
    assert response.status_code == 403


def test_foreign_origin_cannot_connect_to_websocket(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/api/runs/{uuid4()}/stream",
            headers={
                "Origin": "https://untrusted.example",
            },
        ):
            pass


@pytest.mark.parametrize("field", ["name", "description"])
def test_postgres_unrepresentable_text_is_rejected_before_storage(client, field):
    payload = {"name": "Clinic", "description": "Synthetic clinic application"}
    payload[field] += "\x00private-sentinel"
    with TestClient(client.app, raise_server_exceptions=False, headers=client.headers) as api:
        response = api.post("/api/projects", headers=command_headers(), json=payload)
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert "private-sentinel" not in response.text


def test_websocket_validation_error_does_not_echo_input(client):
    with pytest.raises(WebSocketDisconnect) as caught:
        with client.websocket_connect(f"/api/runs/{uuid4()}/stream?after_seq=private-sentinel"):
            pass
    assert caught.value.code == 1008
    assert caught.value.reason == "validation_error"


def test_invalid_resource_id_is_a_structured_error(client):
    with TestClient(client.app, raise_server_exceptions=False, headers=client.headers) as api:
        response = api.get("/api/runs/invalid%00id/snapshot")
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


def test_unexpected_failure_returns_a_safe_problem(client, monkeypatch):
    def fail_read():
        raise RuntimeError("private-sentinel")

    monkeypatch.setattr(client.app.state.service, "list_projects", fail_read)
    with TestClient(client.app, raise_server_exceptions=False, headers=client.headers) as api:
        response = api.get("/api/projects")
    assert response.status_code == 500
    assert response.headers["content-type"] == "application/json"
    assert response.json()["code"] == "internal_error"
    assert "private-sentinel" not in response.text


def test_commands_require_the_session_token(client):
    response = client.post(
        "/api/projects",
        headers={**command_headers(), "X-CodeHead-Token": ""},
        json={"name": "Clinic", "description": "Synthetic clinic application"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "invalid_command_token"


def test_wrong_session_token_is_rejected(client):
    response = client.post(
        "/api/projects",
        headers={**command_headers(), "X-CodeHead-Token": "incorrect-test-value"},
        json={"name": "Clinic", "description": "Synthetic clinic application"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "invalid_command_token"


def test_session_bootstrap_is_not_cacheable_or_exposed_cross_origin(client):
    response = client.get("/api/session")
    assert response.status_code == 200
    assert len(response.json()["command_token"]) >= 32
    assert response.headers["cache-control"] == "no-store"
    assert (
        client.get("/api/session", headers={"Origin": "http://127.0.0.1:9000"}).status_code == 403
    )
    assert client.get("/api/session", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
