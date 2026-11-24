"""Relational state. Public responses are defined separately in contracts.py."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text)
    profile: Mapped[str] = mapped_column(String(40))
    requirements_version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint("last_event_seq >= 0", name="ck_run_seq"),
        CheckConstraint(
            "status IN ('created','running','pausing','paused','blocked',"
            "'succeeded','failed','cancelled')",
            name="ck_run_status",
        ),
        Index(
            "uq_single_active_run",
            text("(1)"),
            unique=True,
            postgresql_where=text("status IN ('created','running','pausing','paused','blocked')"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    mode: Mapped[str] = mapped_column(String(20))
    workflow_version: Mapped[str] = mapped_column(String(40))
    requirements_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24))
    limits: Mapped[dict] = mapped_column(JSONB)
    last_event_seq: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    cancel_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    pause_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    profile_version: Mapped[str | None] = mapped_column(String(40))
    profile_hash: Mapped[str | None] = mapped_column(String(64))
    acceptance_suite_hash: Mapped[str | None] = mapped_column(String(64))
    template_hash: Mapped[str | None] = mapped_column(String(64))


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint(
            "iteration >= 0 AND attempt >= 0 AND record_version >= 1", name="ck_task_versions"
        ),
        Index("ix_tasks_queue", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    task_type: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(32))
    dependencies: Mapped[list] = mapped_column(JSONB)
    input_versions: Mapped[dict] = mapped_column(JSONB)
    iteration: Mapped[int] = mapped_column(Integer)
    attempt: Mapped[int] = mapped_column(Integer)
    record_version: Mapped[int] = mapped_column(Integer)
    lease_owner: Mapped[str | None] = mapped_column(String(100))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    fencing_token: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    active_attempt_id: Mapped[str | None] = mapped_column(String(36))
    blocked_reason: Mapped[str | None] = mapped_column(Text)


class Agent(Base):
    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("run_id", "role", name="uq_agent_run_role"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    instructions_version: Mapped[str] = mapped_column(String(40))
    appearance_id: Mapped[str] = mapped_column(String(60))
    lifecycle: Mapped[str] = mapped_column(String(24))
    activity: Mapped[str | None] = mapped_column(String(24))
    location: Mapped[str] = mapped_column(String(24))
    current_task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), index=True)
    allowed_operations: Mapped[list] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), index=True)
    artifact_type: Mapped[str] = mapped_column(String(50))
    version: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    relative_path: Mapped[str] = mapped_column(Text)
    author_role: Mapped[str | None] = mapped_column(String(32))
    input_versions: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    provenance: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    media_type: Mapped[str | None] = mapped_column(String(120))
    byte_size: Mapped[int | None] = mapped_column(Integer)
    content_text: Mapped[str | None] = mapped_column(Text)


class Candidate(Base):
    __tablename__ = "candidates"
    __table_args__ = (
        UniqueConstraint("run_id", name="uq_candidate_run"),
        CheckConstraint("revision >= 1 AND publication_fence >= 0", name="ck_candidate_versions"),
        CheckConstraint(
            "status IN ('assembling','materializing','ready','conflict','blocked')",
            name="ck_candidate_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24))
    profile_version: Mapped[str] = mapped_column(String(40))
    profile_hash: Mapped[str] = mapped_column(String(64))
    acceptance_suite_hash: Mapped[str] = mapped_column(String(64))
    template_hash: Mapped[str] = mapped_column(String(64))
    tree_hash: Mapped[str] = mapped_column(String(64))
    manifest_artifact_id: Mapped[str] = mapped_column(ForeignKey("artifacts.id"))
    files: Mapped[list] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    workspace_path: Mapped[str | None] = mapped_column(Text)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    publication_owner: Mapped[str | None] = mapped_column(String(100))
    publication_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    publication_fence: Mapped[int] = mapped_column(BigInteger, default=0)


class AgentRun(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        UniqueConstraint("task_id", "number", name="uq_agent_attempt_number"),
        CheckConstraint("number >= 1 AND fencing_token >= 1", name="ck_agent_attempt_versions"),
        CheckConstraint(
            "status IN ('created','running','succeeded','failed','cancelled','uncertain')",
            name="ck_agent_attempt_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    number: Mapped[int] = mapped_column(Integer)
    fencing_token: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(24))
    provider: Mapped[str] = mapped_column(String(80))
    model: Mapped[str | None] = mapped_column(String(120))
    input_versions: Mapped[dict] = mapped_column(JSONB)
    parameters: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_request_id: Mapped[str | None] = mapped_column(String(200))
    stop_reason: Mapped[str | None] = mapped_column(String(100))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    latency_ms: Mapped[float | None] = mapped_column(Float)
    error_code: Mapped[str | None] = mapped_column(String(100))
    error_message: Mapped[str | None] = mapped_column(Text)
    retry_of_attempt_id: Mapped[str | None] = mapped_column(String(36))
    decision_id: Mapped[str | None] = mapped_column(String(36))
    redacted_prompt: Mapped[str | None] = mapped_column(Text)
    redacted_response: Mapped[str | None] = mapped_column(Text)
    redaction_version: Mapped[str] = mapped_column(String(60), default="redaction-v1")

    @property
    def trace_available(self) -> bool:
        return self.redacted_prompt is not None or self.redacted_response is not None


class Decision(Base):
    __tablename__ = "decisions"
    __table_args__ = (
        CheckConstraint("version >= 1 AND status IN ('open','resolved')", name="ck_decision_state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), index=True)
    attempt_id: Mapped[str | None] = mapped_column(ForeignKey("agent_runs.id"))
    tool_run_id: Mapped[str | None] = mapped_column(ForeignKey("tool_runs.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(24))
    version: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(250))
    summary: Mapped[str] = mapped_column(Text)
    choices: Mapped[list] = mapped_column(JSONB)
    artifact_ids: Mapped[list] = mapped_column(JSONB)
    choice: Mapped[str | None] = mapped_column(String(60))
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    blocking: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"

    owner: Mapped[str] = mapped_column(String(100), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    supported_roles: Mapped[list] = mapped_column(JSONB)
    supported_tools: Mapped[list] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )


class ToolRun(Base):
    __tablename__ = "tool_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('created','running','succeeded','failed',"
            "'timed_out','cancelled','uncertain')",
            name="ck_tool_status",
        ),
        CheckConstraint(
            "operation_id IN ('validate_backend','test_backend','build_frontend')",
            name="ck_tool_operation",
        ),
        CheckConstraint(
            "required_isolation = 'process_only' AND isolation_level = 'process_only'",
            name="ck_tool_isolation",
        ),
        CheckConstraint(
            "snapshot_version >= 1 AND fencing_token >= 0 "
            "AND timeout_seconds BETWEEN 1 AND 180 AND output_limit_bytes BETWEEN 1024 AND 262144",
            name="ck_tool_limits",
        ),
        Index("ix_tool_queue", "status", "created_at"),
        Index(
            "uq_tool_pending",
            "workspace_id",
            "operation_id",
            unique=True,
            postgresql_where=text("status IN ('created','running','uncertain')"),
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    operation_id: Mapped[str] = mapped_column(String(40))
    workspace_id: Mapped[str] = mapped_column(ForeignKey("candidates.id"))
    snapshot_version: Mapped[int] = mapped_column(Integer)
    required_isolation: Mapped[str] = mapped_column(String(20))
    isolation_level: Mapped[str] = mapped_column(String(20), default="process_only")
    status: Mapped[str] = mapped_column(String(24))
    tree_hash: Mapped[str] = mapped_column(String(64))
    manifest_artifact_id: Mapped[str] = mapped_column(ForeignKey("artifacts.id"))
    manifest_hash: Mapped[str] = mapped_column(String(64))
    profile_version: Mapped[str] = mapped_column(String(40))
    profile_hash: Mapped[str] = mapped_column(String(64))
    acceptance_suite_hash: Mapped[str] = mapped_column(String(64))
    template_hash: Mapped[str] = mapped_column(String(64))
    timeout_seconds: Mapped[int] = mapped_column(Integer)
    output_limit_bytes: Mapped[int] = mapped_column(Integer)
    commands: Mapped[list] = mapped_column(JSONB, default=list)
    stdout: Mapped[str] = mapped_column(Text, default="")
    stderr: Mapped[str] = mapped_column(Text, default="")
    report: Mapped[dict | None] = mapped_column(JSONB)
    exit_code: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(100))
    error_message: Mapped[str | None] = mapped_column(Text)
    process_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fencing_token: Mapped[int] = mapped_column(BigInteger, default=0)
    lease_owner: Mapped[str | None] = mapped_column(String(100))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("run_id", "seq", name="uq_event_run_seq"),
        CheckConstraint("seq > 0 AND schema_version = 1", name="ck_event_version"),
    )

    event_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    schema_version: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(60))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    seq: Mapped[int] = mapped_column(BigInteger)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actor_id: Mapped[str | None] = mapped_column(String(100))
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), index=True)
    correlation_id: Mapped[str] = mapped_column(String(100))
    causation_id: Mapped[str | None] = mapped_column(String(36))
    payload: Mapped[dict] = mapped_column(JSONB)


class CommandReceipt(Base):
    __tablename__ = "command_receipts"

    scope: Mapped[str] = mapped_column(String(100), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    params_hash: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
