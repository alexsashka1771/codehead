"""Pin the technical template when a new run is created."""

import sqlalchemy as sa
from alembic import op

revision = "0005_run_template_pin"
down_revision = "0004_candidate"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("template_hash", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "template_hash")
