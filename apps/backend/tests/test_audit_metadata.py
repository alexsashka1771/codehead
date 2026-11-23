from uuid import uuid4

from conftest import command_headers
from sqlalchemy import select

from codehead.persistence.models import Artifact, CommandReceipt
from codehead.persistence.service import now


def create_run(client, project):
    response = client.post(
        f"/api/projects/{project['id']}/runs", headers=command_headers(), json={}
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_offline_agents_have_no_executable_operations(client, project):
    run_id = create_run(client, project)
    snapshot = client.get(f"/api/runs/{run_id}/snapshot").json()
    assert all(agent["allowed_operations"] == [] for agent in snapshot["agents"])


def test_artifact_provenance_survives_persistence(client, project, database):
    run_id = create_run(client, project)
    artifact_id = str(uuid4())
    provenance = {"origin": "user", "producer_id": "local_user", "parent_artifact_id": None}
    with database.sessions.begin() as session:
        session.add(
            Artifact(
                id=artifact_id,
                run_id=run_id,
                task_id=None,
                artifact_type="requirements",
                version=1,
                content_hash="a" * 64,
                relative_path="requirements/v1.txt",
                author_role=None,
                input_versions={},
                created_at=now(),
                provenance=provenance,
            )
        )
    snapshot = client.get(f"/api/runs/{run_id}/snapshot").json()
    assert snapshot["artifacts"][0]["provenance"] == provenance


def test_command_receipt_has_a_validated_response(client, project, database):
    from codehead.contracts import CommandReceiptView

    with database.read() as session:
        stored = session.scalars(select(CommandReceipt)).one()
        receipt = CommandReceiptView.model_validate(stored)
    assert receipt.response.id == project["id"]
    assert len(receipt.params_hash) == 64
