"""Pin the external profile and store immutable candidate manifest descriptors."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004_candidate"
down_revision = "0003_worker"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("profile_version", sa.String(40), nullable=True))
    op.add_column("runs", sa.Column("profile_hash", sa.String(64), nullable=True))
    op.add_column("runs", sa.Column("acceptance_suite_hash", sa.String(64), nullable=True))
    op.create_table(
        "candidates",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False, index=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("profile_version", sa.String(40), nullable=False),
        sa.Column("profile_hash", sa.String(64), nullable=False),
        sa.Column("acceptance_suite_hash", sa.String(64), nullable=False),
        sa.Column("template_hash", sa.String(64), nullable=False),
        sa.Column("tree_hash", sa.String(64), nullable=False),
        sa.Column(
            "manifest_artifact_id", sa.String(36), sa.ForeignKey("artifacts.id"), nullable=False
        ),
        sa.Column("files", JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_path", sa.Text(), nullable=True),
        sa.Column("blocked_reason", sa.Text(), nullable=True),
        sa.Column("publication_owner", sa.String(100), nullable=True),
        sa.Column("publication_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "publication_fence", sa.BigInteger(), nullable=False, server_default=sa.text("0")
        ),
        sa.UniqueConstraint("run_id", name="uq_candidate_run"),
        sa.CheckConstraint(
            "revision >= 1 AND publication_fence >= 0", name="ck_candidate_versions"
        ),
        sa.CheckConstraint(
            "status IN ('assembling','materializing','ready','conflict','blocked')",
            name="ck_candidate_status",
        ),
    )


def downgrade() -> None:
    raise NotImplementedError("Candidate history requires an explicitly reviewed downgrade.")
