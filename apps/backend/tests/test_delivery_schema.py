from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError
from test_quality_workflow import drain, setup_run

from codehead.persistence import models

pytestmark = pytest.mark.integration


def test_migration_persists_delivery_and_preview_constraints(database):
    with database.engine.connect() as connection:
        schema = inspect(connection)
        assert {"deliveries", "preview_sessions"} <= set(schema.get_table_names())
        assert {"publication_owner", "publication_expires_at", "publication_fence"} <= {
            item["name"] for item in schema.get_columns("deliveries")
        }
        assert {"health_checked_at", "lease_expires_at", "fencing_token", "worker_boot_id"} <= {
            item["name"] for item in schema.get_columns("preview_sessions")
        }
        assert "uq_delivery_run" in {
            item["name"] for item in schema.get_unique_constraints("deliveries")
        }
        assert "uq_preview_active" in {
            item["name"] for item in schema.get_indexes("preview_sessions")
        }
        assert "ck_tool_delivery_scope" in {
            item["name"] for item in schema.get_check_constraints("tool_runs")
        }


@pytest.fixture
def published(database, tmp_path):
    service, run, _, worker = setup_run(database, tmp_path)
    snapshot = drain(service, run, worker)
    (cycle,) = snapshot.quality_cycles
    build = next(tool for tool in snapshot.tool_runs if tool.operation_id == "build_frontend")
    qa_report = next(item for item in snapshot.artifacts if item.id == cycle.report_artifact_id)
    assert hasattr(models, "Delivery")
    pins = {
        name: getattr(cycle, name)
        for name in (
            "run_id",
            "candidate_id",
            "revision",
            "tree_hash",
            "manifest_artifact_id",
            "manifest_hash",
            "profile_version",
            "profile_hash",
            "acceptance_suite_hash",
            "template_hash",
        )
    }
    stamp = datetime.now(UTC)
    pins.update(
        task_id=next(item.id for item in snapshot.tasks if item.role == "devops"),
        qa_cycle_id=cycle.id,
        qa_report_artifact_id=qa_report.id,
        qa_report_hash=qa_report.content_hash,
        build_tool_run_id=build.id,
        build_report_hash="a" * 64,
        status="smoking",
        created_at=stamp,
        updated_at=stamp,
        package_generation=1,
        package_manifest_hash="b" * 64,
        package_manifest_byte_size=30,
        package_tree_hash="c" * 64,
        package_archive_hash="d" * 64,
        package_archive_byte_size=1000,
        package_payload_byte_size=400,
        package_file_count=2,
    )
    with database.sessions.begin() as session:
        row = service._run(session, run.id, for_update=True)
        row.workflow_version = "clinic-v4"
        delivery = models.Delivery(id=str(uuid4()), **pins)
        session.add(delivery)

    return service, run, delivery, pins


def test_delivery_and_preview_projection_share_the_workflow_event(database, published):
    service, run, delivery, _ = published
    stamp = datetime.now(UTC)
    with database.sessions.begin() as session:
        row = service._run(session, run.id, for_update=True)
        preview = models.PreviewSession(
            id=str(uuid4()),
            run_id=run.id,
            package_id=delivery.id,
            package_generation=1,
            package_tree_hash=delivery.package_tree_hash,
            status="created",
            version=1,
            created_at=stamp,
            updated_at=stamp,
        )
        session.add(preview)
        event = service._emit_workflow(session, row, "preview.created")

    snapshot = service.snapshot(run.id)
    assert snapshot.delivery.id == delivery.id
    assert snapshot.delivery == event.payload.delivery
    assert snapshot.preview_sessions == event.payload.preview_sessions
    assert snapshot.preview_sessions[0].id == preview.id
    assert not {"origin", "lease_expires_at", "backend_pid", "bridge_pid"}.intersection(
        snapshot.preview_sessions[0].model_dump()
    )


def test_database_enforces_one_delivery_per_run(database, published):
    _, _, _, pins = published
    with (
        pytest.raises(IntegrityError, match="uq_delivery_run"),
        database.sessions.begin() as session,
    ):
        session.add(models.Delivery(id=str(uuid4()), **pins))


def test_database_keeps_uncertain_preview_active(database, published):
    _, run, delivery, _ = published
    stamp = datetime.now(UTC)
    values = dict(
        run_id=run.id,
        package_id=delivery.id,
        package_generation=1,
        package_tree_hash=delivery.package_tree_hash,
        created_at=stamp,
        updated_at=stamp,
    )
    with database.sessions.begin() as session:
        session.add(models.PreviewSession(id=str(uuid4()), status="uncertain", version=1, **values))
    with (
        pytest.raises(IntegrityError, match="uq_preview_active"),
        database.sessions.begin() as session,
    ):
        session.add(models.PreviewSession(id=str(uuid4()), status="created", version=2, **values))


def test_database_rejects_preview_for_a_different_package_generation(database, published):
    _, run, delivery, _ = published
    stamp = datetime.now(UTC)
    with (
        pytest.raises(IntegrityError, match="fk_preview_package"),
        database.sessions.begin() as session,
    ):
        session.add(
            models.PreviewSession(
                id=str(uuid4()),
                run_id=run.id,
                package_id=delivery.id,
                package_generation=2,
                package_tree_hash=delivery.package_tree_hash,
                status="created",
                version=1,
                created_at=stamp,
                updated_at=stamp,
            )
        )
