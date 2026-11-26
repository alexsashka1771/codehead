"""Persist package publication, preview sessions and internal Runner operations."""

import sqlalchemy as sa
from alembic import op

revision = "0008_delivery"
down_revision = "0007_quality"
branch_labels = None
depends_on = None


def upgrade():
    delivery_pins = [
        sa.Column(name, sa.String(36), sa.ForeignKey(target), nullable=False)
        for name, target in (
            ("run_id", "runs.id"),
            ("task_id", "tasks.id"),
            ("candidate_id", "candidates.id"),
            ("manifest_artifact_id", "artifacts.id"),
            ("qa_cycle_id", "quality_cycles.id"),
            ("qa_report_artifact_id", "artifacts.id"),
            ("build_tool_run_id", "tool_runs.id"),
        )
    ]
    delivery_hashes = [
        sa.Column(name, sa.String(64), nullable=False)
        for name in (
            "tree_hash",
            "manifest_hash",
            "profile_hash",
            "acceptance_suite_hash",
            "template_hash",
            "qa_report_hash",
            "build_report_hash",
        )
    ]
    package_hashes = [
        sa.Column(name, sa.String(64))
        for name in ("package_manifest_hash", "package_tree_hash", "package_archive_hash")
    ]
    package_sizes = [
        sa.Column(name, sa.Integer())
        for name in (
            "package_manifest_byte_size",
            "package_archive_byte_size",
            "package_payload_byte_size",
            "package_file_count",
        )
    ]
    delivery_artifacts = [
        sa.Column(name, sa.String(36), sa.ForeignKey("artifacts.id"))
        for name in (
            "smoke_report_artifact_id",
            "deployment_package_artifact_id",
            "runbook_artifact_id",
        )
    ]
    op.create_table(
        "deliveries",
        sa.Column("id", sa.String(36), primary_key=True),
        *delivery_pins,
        *delivery_hashes,
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("profile_version", sa.String(40), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("package_generation", sa.BigInteger(), server_default="0", nullable=False),
        *package_hashes,
        *package_sizes,
        sa.Column(
            "smoke_tool_run_id",
            sa.String(36),
            sa.ForeignKey("tool_runs.id", deferrable=True, initially="DEFERRED"),
        ),
        *delivery_artifacts,
        sa.Column("publication_owner", sa.String(100)),
        sa.Column("publication_expires_at", sa.DateTime(timezone=True)),
        sa.Column("publication_fence", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("blocked_reason", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("run_id", name="uq_delivery_run"),
        sa.UniqueConstraint("id", "run_id", name="uq_delivery_id_run"),
        sa.UniqueConstraint(
            "id", "run_id", "package_generation", "package_tree_hash", name="uq_delivery_package"
        ),
        sa.CheckConstraint(
            "status IN ('created','publishing','smoking','analyzing','ready',"
            "'failed','blocked','cancelled')",
            name="ck_delivery_status",
        ),
        sa.CheckConstraint(
            "revision >= 1 AND publication_fence >= 0 AND package_generation >= 0",
            name="ck_delivery_versions",
        ),
        sa.CheckConstraint(
            "(publication_owner IS NULL) = (publication_expires_at IS NULL) AND "
            "(publication_owner IS NULL OR (status = 'publishing' AND package_generation > 0))",
            name="ck_delivery_lease",
        ),
        sa.CheckConstraint(
            "(num_nonnulls(package_manifest_hash, package_manifest_byte_size, package_tree_hash, "
            "package_archive_hash, package_archive_byte_size, package_payload_byte_size, "
            "package_file_count) = 0 AND status NOT IN ('smoking','analyzing','ready')) OR "
            "(num_nonnulls(package_manifest_hash, package_manifest_byte_size, package_tree_hash, "
            "package_archive_hash, package_archive_byte_size, package_payload_byte_size, "
            "package_file_count) = 7 AND package_generation > 0 AND package_manifest_byte_size > 0 "
            "AND package_archive_byte_size > 0 AND package_payload_byte_size > 0 "
            "AND package_file_count > 0)",
            name="ck_delivery_package",
        ),
        sa.CheckConstraint(
            "status <> 'ready' OR (smoke_tool_run_id IS NOT NULL AND "
            "smoke_report_artifact_id IS NOT NULL AND deployment_package_artifact_id IS NOT NULL "
            "AND runbook_artifact_id IS NOT NULL AND finished_at IS NOT NULL)",
            name="ck_delivery_ready",
        ),
    )
    op.create_table(
        "preview_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("package_id", sa.String(36), nullable=False),
        sa.Column("package_generation", sa.BigInteger(), nullable=False),
        sa.Column("package_tree_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("fencing_token", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("worker_boot_id", sa.String(100)),
        sa.Column("backend_pid", sa.Integer()),
        sa.Column("bridge_pid", sa.Integer()),
        sa.Column("origin", sa.String(28)),
        sa.Column("health_checked_at", sa.DateTime(timezone=True)),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column(
            "start_tool_run_id",
            sa.String(36),
            sa.ForeignKey("tool_runs.id", deferrable=True, initially="DEFERRED"),
        ),
        sa.Column(
            "stop_tool_run_id",
            sa.String(36),
            sa.ForeignKey("tool_runs.id", deferrable=True, initially="DEFERRED"),
        ),
        sa.Column("error_code", sa.String(100)),
        sa.Column("error_message", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ready_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("id", "package_id", "run_id", name="uq_preview_session_scope"),
        sa.UniqueConstraint("run_id", "version", name="uq_preview_version"),
        sa.ForeignKeyConstraint(
            ("package_id", "run_id", "package_generation", "package_tree_hash"),
            (
                "deliveries.id",
                "deliveries.run_id",
                "deliveries.package_generation",
                "deliveries.package_tree_hash",
            ),
            name="fk_preview_package",
        ),
        sa.CheckConstraint(
            "status IN ('created','starting','ready','stopping','stopped','failed','uncertain')",
            name="ck_preview_status",
        ),
        sa.CheckConstraint(
            "version >= 1 AND package_generation >= 1 AND fencing_token >= 0 "
            "AND (backend_pid IS NULL OR backend_pid > 0) "
            "AND (bridge_pid IS NULL OR bridge_pid > 0)",
            name="ck_preview_versions",
        ),
        sa.CheckConstraint(
            "CASE WHEN origin IS NULL THEN true "
            "WHEN origin ~ '^http://127[.]0[.]0[.]1:[1-9][0-9]{0,4}$' "
            "THEN split_part(origin, ':', 3)::integer <= 65535 ELSE false END",
            name="ck_preview_origin",
        ),
        sa.CheckConstraint(
            "status <> 'ready' OR (origin IS NOT NULL AND worker_boot_id IS NOT NULL "
            "AND backend_pid IS NOT NULL AND bridge_pid IS NOT NULL AND ready_at IS NOT NULL "
            "AND health_checked_at IS NOT NULL AND lease_expires_at IS NOT NULL "
            "AND start_tool_run_id IS NOT NULL)",
            name="ck_preview_ready",
        ),
    )
    op.create_index(
        "uq_preview_active",
        "preview_sessions",
        ["run_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('created','starting','ready','stopping','uncertain')"),
    )

    op.add_column("tool_runs", sa.Column("delivery_id", sa.String(36)))
    op.add_column("tool_runs", sa.Column("preview_session_id", sa.String(36)))
    op.create_index("ix_tool_runs_delivery_id", "tool_runs", ["delivery_id"])
    op.create_index("ix_tool_runs_preview_session_id", "tool_runs", ["preview_session_id"])
    op.create_foreign_key(
        "fk_tool_delivery",
        "tool_runs",
        "deliveries",
        ["delivery_id", "run_id"],
        ["id", "run_id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_foreign_key(
        "fk_tool_preview_session",
        "tool_runs",
        "preview_sessions",
        ["preview_session_id", "delivery_id", "run_id"],
        ["id", "package_id", "run_id"],
        deferrable=True,
        initially="DEFERRED",
    )
    op.drop_constraint("ck_tool_operation", "tool_runs", type_="check")
    op.create_check_constraint(
        "ck_tool_operation",
        "tool_runs",
        "operation_id IN ('validate_backend','test_backend','build_frontend',"
        "'smoke_test','start_preview','stop_preview')",
    )
    op.create_check_constraint(
        "ck_tool_delivery_scope",
        "tool_runs",
        "(operation_id IN ('validate_backend','test_backend','build_frontend') "
        "AND delivery_id IS NULL AND preview_session_id IS NULL) OR "
        "(operation_id = 'smoke_test' AND delivery_id IS NOT NULL "
        "AND preview_session_id IS NULL AND qa_cycle_id IS NULL) OR "
        "(operation_id IN ('start_preview','stop_preview') AND delivery_id IS NOT NULL "
        "AND preview_session_id IS NOT NULL AND qa_cycle_id IS NULL)",
    )


def downgrade():
    op.drop_constraint("ck_tool_operation", "tool_runs", type_="check")
    op.create_check_constraint(
        "ck_tool_operation",
        "tool_runs",
        "operation_id IN ('validate_backend','test_backend','build_frontend')",
    )
    op.drop_constraint("ck_tool_delivery_scope", "tool_runs", type_="check")
    op.drop_constraint("fk_tool_preview_session", "tool_runs", type_="foreignkey")
    op.drop_constraint("fk_tool_delivery", "tool_runs", type_="foreignkey")
    op.drop_index("ix_tool_runs_preview_session_id", table_name="tool_runs")
    op.drop_index("ix_tool_runs_delivery_id", table_name="tool_runs")
    op.drop_column("tool_runs", "preview_session_id")
    op.drop_column("tool_runs", "delivery_id")
    op.drop_table("preview_sessions")
    op.drop_table("deliveries")
