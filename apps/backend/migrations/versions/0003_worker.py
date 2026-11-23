"""Add durable worker attempts, decisions and immutable small document content."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003_worker"
down_revision = "0002_audit_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column(
            "cancel_requested", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
    )
    op.add_column(
        "runs",
        sa.Column("pause_requested", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "tasks",
        sa.Column("fencing_token", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column("tasks", sa.Column("active_attempt_id", sa.String(36), nullable=True))
    op.add_column("tasks", sa.Column("blocked_reason", sa.Text(), nullable=True))
    op.add_column("artifacts", sa.Column("media_type", sa.String(120), nullable=True))
    op.add_column("artifacts", sa.Column("byte_size", sa.Integer(), nullable=True))
    op.add_column("artifacts", sa.Column("content_text", sa.Text(), nullable=True))
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False, index=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id"), nullable=False, index=True),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("fencing_token", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("provider", sa.String(80), nullable=False),
        sa.Column("model", sa.String(120), nullable=True),
        sa.Column("input_versions", JSONB(), nullable=False),
        sa.Column("parameters", JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_request_id", sa.String(200), nullable=True),
        sa.Column("stop_reason", sa.String(100), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Numeric(18, 8), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("error_code", sa.String(100), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("retry_of_attempt_id", sa.String(36), nullable=True),
        sa.Column("decision_id", sa.String(36), nullable=True),
        sa.Column("redacted_prompt", sa.Text(), nullable=True),
        sa.Column("redacted_response", sa.Text(), nullable=True),
        sa.Column("redaction_version", sa.String(60), nullable=False),
        sa.UniqueConstraint("task_id", "number", name="uq_agent_attempt_number"),
        sa.CheckConstraint("number >= 1 AND fencing_token >= 1", name="ck_agent_attempt_versions"),
        sa.CheckConstraint(
            "status IN ('created','running','succeeded','failed','cancelled','uncertain')",
            name="ck_agent_attempt_status",
        ),
    )
    op.create_table(
        "decisions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False, index=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id"), nullable=False, index=True),
        sa.Column("attempt_id", sa.String(36), sa.ForeignKey("agent_runs.id"), nullable=True),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(250), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("choices", JSONB(), nullable=False),
        sa.Column("artifact_ids", JSONB(), nullable=False),
        sa.Column("choice", sa.String(60), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("blocking", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.CheckConstraint(
            "version >= 1 AND status IN ('open','resolved')", name="ck_decision_state"
        ),
    )
    op.create_table(
        "worker_heartbeats",
        sa.Column("owner", sa.String(100), primary_key=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("supported_roles", JSONB(), nullable=False),
    )


def downgrade() -> None:
    raise RuntimeError("Worker history requires an explicit data-preserving migration.")
