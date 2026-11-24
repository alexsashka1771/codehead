"""Persist fenced manual Runner operations and worker tool capabilities."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0006_tool_runs"
down_revision = "0005_run_template_pin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tool_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False, index=True),
        sa.Column("operation_id", sa.String(40), nullable=False),
        sa.Column("workspace_id", sa.String(36), sa.ForeignKey("candidates.id"), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), nullable=False),
        sa.Column("required_isolation", sa.String(20), nullable=False),
        sa.Column("isolation_level", sa.String(20), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("tree_hash", sa.String(64), nullable=False),
        sa.Column(
            "manifest_artifact_id", sa.String(36), sa.ForeignKey("artifacts.id"), nullable=False
        ),
        sa.Column("manifest_hash", sa.String(64), nullable=False),
        sa.Column("profile_version", sa.String(40), nullable=False),
        sa.Column("profile_hash", sa.String(64), nullable=False),
        sa.Column("acceptance_suite_hash", sa.String(64), nullable=False),
        sa.Column("template_hash", sa.String(64), nullable=False),
        sa.Column("timeout_seconds", sa.Integer(), nullable=False),
        sa.Column("output_limit_bytes", sa.Integer(), nullable=False),
        sa.Column("commands", JSONB(), nullable=False),
        sa.Column("stdout", sa.Text(), nullable=False),
        sa.Column("stderr", sa.Text(), nullable=False),
        sa.Column("report", JSONB(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("process_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fencing_token", sa.BigInteger(), nullable=False),
        sa.Column("lease_owner", sa.String(100), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('created','running','succeeded','failed',"
            "'timed_out','cancelled','uncertain')",
            name="ck_tool_status",
        ),
        sa.CheckConstraint(
            "operation_id IN ('validate_backend','test_backend','build_frontend')",
            name="ck_tool_operation",
        ),
        sa.CheckConstraint(
            "required_isolation = 'process_only' AND isolation_level = 'process_only'",
            name="ck_tool_isolation",
        ),
        sa.CheckConstraint(
            "snapshot_version >= 1 AND fencing_token >= 0 "
            "AND timeout_seconds BETWEEN 1 AND 180 AND output_limit_bytes BETWEEN 1024 AND 262144",
            name="ck_tool_limits",
        ),
    )
    op.create_index("ix_tool_queue", "tool_runs", ["status", "created_at"])
    op.create_index(
        "uq_tool_pending",
        "tool_runs",
        ["workspace_id", "operation_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('created','running','uncertain')"),
    )
    op.add_column(
        "worker_heartbeats",
        sa.Column(
            "supported_tools", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
    )
    op.alter_column("decisions", "task_id", existing_type=sa.String(36), nullable=True)
    op.add_column("decisions", sa.Column("tool_run_id", sa.String(36), nullable=True))
    op.create_foreign_key("fk_decision_tool_run", "decisions", "tool_runs", ["tool_run_id"], ["id"])
    op.create_index("ix_decisions_tool_run_id", "decisions", ["tool_run_id"])


def downgrade() -> None:
    op.drop_index("ix_decisions_tool_run_id", table_name="decisions")
    op.drop_constraint("fk_decision_tool_run", "decisions", type_="foreignkey")
    op.drop_column("decisions", "tool_run_id")
    op.alter_column("decisions", "task_id", existing_type=sa.String(36), nullable=False)
    op.drop_column("worker_heartbeats", "supported_tools")
    op.drop_table("tool_runs")
