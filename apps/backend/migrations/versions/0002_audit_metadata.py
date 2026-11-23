"""Persist agent permissions and artifact provenance without losing existing history."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_audit_metadata"
down_revision = "09370918c79e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "allowed_operations",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "artifacts",
        sa.Column(
            "provenance", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
    )


def downgrade() -> None:
    op.drop_column("artifacts", "provenance")
    op.drop_column("agents", "allowed_operations")
