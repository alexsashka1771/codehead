"""Persist immutable QA cycle pins and trusted test injection state."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007_quality"
down_revision = "0006_tool_runs"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "runs", sa.Column("test_scenario", sa.String(32), nullable=False, server_default="standard")
    )
    op.add_column(
        "runs",
        sa.Column("injection_done", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    columns = [sa.Column("id", sa.String(36), primary_key=True)]
    for name, target in (
        ("run_id", "runs.id"),
        ("task_id", "tasks.id"),
        ("candidate_id", "candidates.id"),
        ("manifest_artifact_id", "artifacts.id"),
    ):
        columns.append(sa.Column(name, sa.String(36), sa.ForeignKey(target), nullable=False))
    for name in ("iteration", "revision"):
        columns.append(sa.Column(name, sa.Integer(), nullable=False))
    for name in (
        "tree_hash",
        "manifest_hash",
        "profile_hash",
        "acceptance_suite_hash",
        "template_hash",
    ):
        columns.append(sa.Column(name, sa.String(64), nullable=False))
    columns.extend(
        [
            sa.Column("profile_version", sa.String(40), nullable=False),
            sa.Column("status", sa.String(24), nullable=False),
        ]
    )
    for name in ("tool_run_ids", "tool_report_artifact_ids", "bug_artifact_ids"):
        columns.append(sa.Column(name, JSONB(), nullable=False))
    for name, target in (
        ("report_artifact_id", "artifacts.id"),
        ("repair_task_id", "tasks.id"),
        ("followup_task_id", "tasks.id"),
    ):
        columns.append(sa.Column(name, sa.String(36), sa.ForeignKey(target), nullable=True))
    columns.extend(
        [
            sa.Column("blocked_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        ]
    )
    op.create_table(
        "quality_cycles",
        *columns,
        sa.UniqueConstraint("run_id", "task_id", name="uq_quality_task"),
        sa.UniqueConstraint("run_id", "iteration", name="uq_quality_iteration"),
        sa.CheckConstraint(
            "iteration BETWEEN 0 AND 2 AND revision >= 1", name="ck_quality_versions"
        ),
        sa.CheckConstraint(
            "status IN ('created','testing','analyzing','passed','failed','blocked','cancelled')",
            name="ck_quality_status",
        ),
    )
    op.create_index("ix_quality_cycles_run_id", "quality_cycles", ["run_id"])
    op.add_column(
        "tool_runs",
        sa.Column("qa_cycle_id", sa.String(36), sa.ForeignKey("quality_cycles.id"), nullable=True),
    )
    op.create_index("ix_tool_runs_qa_cycle_id", "tool_runs", ["qa_cycle_id"])


def downgrade():
    op.drop_index("ix_tool_runs_qa_cycle_id", table_name="tool_runs")
    op.drop_column("tool_runs", "qa_cycle_id")
    op.drop_table("quality_cycles")
    op.drop_column("runs", "injection_done")
    op.drop_column("runs", "test_scenario")
