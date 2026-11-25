"""Versioned public contracts. Exported to JSON Schema and TypeScript."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True, str_strip_whitespace=True)


class RunStatus(StrEnum):
    CREATED = "created"
    RUNNING = "running"
    PAUSING = "pausing"
    PAUSED = "paused"
    BLOCKED = "blocked"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_FOR_DECISION = "waiting_for_decision"
    BLOCKED = "blocked"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Role(StrEnum):
    PRODUCT_MANAGER = "product_manager"
    ARCHITECT = "architect"
    CTO = "cto"
    BACKEND = "backend"
    FRONTEND = "frontend"
    QA = "qa"
    DEVOPS = "devops"


class Location(StrEnum):
    PRODUCT = "product"
    ARCHITECTURE = "architecture"
    DEVELOPMENT = "development"
    QA = "qa"
    SECURITY = "security"
    DEVOPS = "devops"
    PRODUCTION = "production"
    RESEARCH = "research"
    MEETING = "meeting"
    CORE = "core"


class RunLimits(Contract):
    max_parallel_tasks: int = Field(default=2, ge=1, le=2)
    max_repair_iterations: int = Field(default=2, ge=0, le=2)
    max_llm_calls: int = Field(default=64, ge=1, le=128)
    max_tokens: int | None = Field(default=None, ge=1, le=1_000_000)
    max_cost_usd: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    max_duration_seconds: int = Field(default=1800, ge=60, le=14400)
    max_file_bytes: int = Field(default=65536, ge=1024, le=65536)
    max_files_per_proposal: int = Field(default=4, ge=1, le=4)
    max_proposal_bytes: int = Field(default=262144, ge=1024, le=262144)


class FileProposal(Contract):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False, frozen=True)
    relative_path: str = Field(min_length=1, max_length=240)
    base_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    media_type: str = "text/plain"
    content: str


class CreateProject(Contract):
    name: str = Field(min_length=1, max_length=120, pattern=r"^[^\x00]*$")
    description: str = Field(min_length=10, max_length=8000, pattern=r"^[^\x00]*$")
    profile: Literal["clinic_demo"] = "clinic_demo"


class ProjectView(CreateProject):
    id: str
    requirements_version: int = Field(ge=1)
    created_at: datetime


class StartRun(Contract):
    mode: Literal["live", "test"] = "live"
    limits: RunLimits = Field(default_factory=RunLimits)
    workflow_version: Literal["clinic-v2", "clinic-v3"] = "clinic-v3"
    test_scenario: Literal["standard", "repair_success", "repair_blocked"] = "standard"

    @model_validator(mode="after")
    def scenario_scope(self):
        if self.test_scenario != "standard" and (
            self.mode != "test" or self.workflow_version != "clinic-v3"
        ):
            raise ValueError("Repair scenarios require test clinic-v3")
        return self


class RunView(Contract):
    id: str
    project_id: str
    mode: Literal["live", "test"]
    workflow_version: str
    requirements_version: int
    status: RunStatus
    limits: RunLimits
    last_event_seq: int = Field(ge=0)
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    blocked_reason: str | None
    cancel_requested: bool = False
    pause_requested: bool = False
    profile_version: str | None = None
    profile_hash: str | None = None
    acceptance_suite_hash: str | None = None
    template_hash: str | None = None
    test_scenario: Literal["standard", "repair_success", "repair_blocked"] = "standard"
    injection_done: bool = False


class TaskView(Contract):
    id: str
    run_id: str
    role: Role
    task_type: str
    status: TaskStatus
    dependencies: list[str]
    input_versions: dict[str, int]
    iteration: int = Field(ge=0)
    attempt: int = Field(ge=0)
    record_version: int = Field(ge=1)
    lease_owner: str | None
    lease_expires_at: datetime | None
    created_at: datetime

    fencing_token: int = Field(default=0, ge=0)
    active_attempt_id: str | None = None
    blocked_reason: str | None = None


class AgentView(Contract):
    id: str
    run_id: str
    role: Role
    instructions_version: str
    appearance_id: str
    lifecycle: Literal["idle", "busy", "blocked", "offline", "failed"]
    activity: (
        Literal[
            "planning",
            "analyzing",
            "coding",
            "testing",
            "reviewing",
            "building",
            "meeting",
            "waiting",
        ]
        | None
    )
    location: Location
    current_task_id: str | None
    allowed_operations: list[str] = Field(default_factory=list)


class ArtifactProvenance(Contract):
    origin: Literal["user", "template", "llm", "tool", "test", "unclassified"] = "unclassified"
    producer_id: str | None = None
    parent_artifact_id: str | None = None


class ArtifactView(Contract):
    id: str
    run_id: str
    task_id: str | None
    artifact_type: str
    version: int = Field(ge=1)
    content_hash: str
    relative_path: str
    author_role: Role | None
    input_versions: dict[str, int]
    created_at: datetime
    provenance: ArtifactProvenance = Field(default_factory=ArtifactProvenance)
    media_type: str | None = None
    byte_size: int | None = Field(default=None, ge=0)


class CandidateFileView(Contract):
    relative_path: str
    artifact_id: str
    version: int = Field(ge=1)
    content_hash: str
    media_type: str
    byte_size: int = Field(ge=0)
    origin: Literal["template", "generated", "human", "test_injected"]
    source: Literal["template", "live", "human", "test"]
    producer_id: str | None = None
    producer_role: Role | None = None
    parent_artifact_id: str | None = None
    parent_hash: str | None = None
    input_versions: dict[str, int] = Field(default_factory=dict)
    normalization_version: Literal["utf8-lf-v1"] = "utf8-lf-v1"


class CandidateView(Contract):
    id: str
    run_id: str
    revision: int = Field(ge=1)
    status: Literal["assembling", "materializing", "ready", "conflict", "blocked"]
    profile_version: str
    profile_hash: str
    acceptance_suite_hash: str
    template_hash: str
    tree_hash: str
    manifest_artifact_id: str
    files: list[CandidateFileView]
    created_at: datetime
    updated_at: datetime
    workspace_path: str | None = None
    blocked_reason: str | None = None
    manifest_hash: str | None = None
    manifest_byte_size: int | None = Field(default=None, ge=0)


class AgentRunView(Contract):
    id: str
    run_id: str
    task_id: str
    agent_id: str
    number: int = Field(ge=1)
    fencing_token: int = Field(ge=1)
    status: Literal["created", "running", "succeeded", "failed", "cancelled", "uncertain"]
    provider: str
    model: str | None
    input_versions: dict[str, int]
    parameters: dict
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    provider_request_id: str | None
    stop_reason: str | None
    input_tokens: int | None = Field(ge=0)
    output_tokens: int | None = Field(ge=0)
    cost_usd: float | None = Field(ge=0, allow_inf_nan=False)
    latency_ms: float | None = Field(ge=0, allow_inf_nan=False)
    error_code: str | None
    error_message: str | None
    retry_of_attempt_id: str | None
    decision_id: str | None
    trace_available: bool


ToolOperation = Literal["validate_backend", "test_backend", "build_frontend"]


class ToolCommand(Contract):
    operation_id: ToolOperation
    workspace_id: str = Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    )
    snapshot_version: int = Field(ge=1)
    required_isolation: Literal["process_only", "container", "remote"] = "process_only"
    timeout_seconds: int = Field(default=180, ge=1, le=180)
    output_limit_bytes: int = Field(default=262144, ge=1024, le=262144)


class ToolRunView(ToolCommand):
    model_config = ConfigDict(extra="forbid", from_attributes=True, str_strip_whitespace=False)
    id: str
    run_id: str
    status: Literal[
        "created", "running", "succeeded", "failed", "timed_out", "cancelled", "uncertain"
    ]
    isolation_level: Literal["process_only"] = "process_only"
    tree_hash: str
    manifest_artifact_id: str
    manifest_hash: str
    profile_version: str
    profile_hash: str
    acceptance_suite_hash: str
    template_hash: str
    commands: list[list[str]] = Field(default_factory=list)
    stdout: str = ""
    stderr: str = ""
    report: dict | None = None
    exit_code: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    process_id: int | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    fencing_token: int = Field(default=0, ge=0)
    lease_owner: str | None = None
    lease_expires_at: datetime | None = None
    qa_cycle_id: str | None = None

    @field_validator("created_at", "started_at", "finished_at", "lease_expires_at")
    @classmethod
    def utc_timestamps(cls, value):
        return value.astimezone(UTC) if value is not None else None


class DecisionView(Contract):
    id: str
    run_id: str
    task_id: str | None
    attempt_id: str | None
    tool_run_id: str | None = None
    kind: Literal[
        "architecture_approval", "uncertain_outcome", "file_conflict", "tool_uncertain_outcome"
    ]
    status: Literal["open", "resolved"]
    version: int = Field(ge=1)
    title: str
    summary: str
    choices: list[str]
    artifact_ids: list[str]
    choice: str | None
    comment: str | None
    created_at: datetime
    resolved_at: datetime | None
    blocking: bool = True


class DecisionResolution(Contract):
    version: int = Field(ge=1)
    choice: Literal["approve", "reject", "confirm_failed", "retry_with_risk", "retry_files"]
    comment: str = Field(default="", max_length=8000)


class ArtifactContent(Contract):
    model_config = ConfigDict(extra="forbid", from_attributes=True, str_strip_whitespace=False)
    artifact_id: str
    content_hash: str
    media_type: str
    byte_size: int = Field(ge=0)
    content: str


class AttemptTrace(Contract):
    model_config = ConfigDict(extra="forbid", from_attributes=True, str_strip_whitespace=False)
    attempt_id: str
    prompt: str | None
    raw_response: str | None
    parameters: dict
    input_versions: dict[str, int]
    stop_reason: str | None
    redaction_version: str


class QualityPins(Contract):
    run_id: str
    task_id: str
    candidate_id: str
    revision: int = Field(ge=1)
    tree_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    manifest_artifact_id: str
    manifest_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile_version: str
    profile_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    acceptance_suite_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class QualityCycleView(QualityPins):
    id: str
    iteration: int = Field(ge=0, le=2)
    status: Literal["created", "testing", "analyzing", "passed", "failed", "blocked", "cancelled"]
    tool_run_ids: list[str]
    tool_report_artifact_ids: list[str] = Field(default_factory=list)
    report_artifact_id: str | None = None
    bug_artifact_ids: list[str] = Field(default_factory=list)
    repair_task_id: str | None = None
    followup_task_id: str | None = None
    blocked_reason: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


class RequirementCheck(Contract):
    requirement_id: Literal[
        "REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-006", "REQ-007", "REQ-008"
    ]
    tool_run_ids: list[str]
    status: Literal["passed", "failed", "not_verified"]


class ProposedTest(Contract):
    title: str = Field(min_length=1, max_length=500)
    requirement_ids: list[str]
    status: Literal["proposed"] = "proposed"


class TestReport(QualityPins):
    cycle_id: str
    iteration: int = Field(ge=0, le=2)
    status: Literal["passed", "failed"]
    tool_run_ids: list[str]
    requirements: list[RequirementCheck]
    proposed_tests: list[ProposedTest]
    resolves_bug_ids: list[str] = Field(default_factory=list)


class Bug(QualityPins):
    cycle_id: str
    iteration: int = Field(ge=0, le=2)
    status: Literal["open"] = "open"
    tool_run_ids: list[str]
    requirement_ids: list[str]
    summary: str = Field(min_length=1, max_length=8000)


class Snapshot(Contract):
    schema_version: Literal[1] = 1
    project: ProjectView
    run: RunView
    tasks: list[TaskView]
    agents: list[AgentView]
    artifacts: list[ArtifactView]
    last_event_seq: int = Field(ge=0)
    agent_runs: list[AgentRunView] = Field(default_factory=list)
    decisions: list[DecisionView] = Field(default_factory=list)
    usage: UsageSummary | None = None
    candidate: CandidateView | None = None
    tool_runs: list[ToolRunView] = Field(default_factory=list)
    quality_cycles: list[QualityCycleView] = Field(default_factory=list)


class EventEnvelope(Contract):
    event_id: str
    schema_version: Literal[1] = 1
    project_id: str
    run_id: str
    seq: int = Field(ge=1)
    occurred_at: datetime
    actor_id: str | None
    task_id: str | None
    correlation_id: str
    causation_id: str | None


class RunCreatedPayload(Contract):
    project: ProjectView
    run: RunView
    agents: list[AgentView]
    usage: UsageSummary | None = None


class TaskQueuedPayload(Contract):
    task: TaskView


class RunStatePayload(Contract):
    run: RunView
    tasks: list[TaskView]
    agents: list[AgentView]


class WorkflowUpdatedPayload(RunStatePayload):
    action: str
    artifacts: list[ArtifactView]
    agent_runs: list[AgentRunView]
    decisions: list[DecisionView]
    usage: UsageSummary
    candidate: CandidateView | None = None
    tool_runs: list[ToolRunView] = Field(default_factory=list)
    quality_cycles: list[QualityCycleView] = Field(default_factory=list)


class WorkflowUpdatedEvent(EventEnvelope):
    event_type: Literal["workflow.updated"] = "workflow.updated"
    payload: WorkflowUpdatedPayload


class RunCreatedEvent(EventEnvelope):
    event_type: Literal["run.created"] = "run.created"
    payload: RunCreatedPayload


class TaskQueuedEvent(EventEnvelope):
    event_type: Literal["task.queued"] = "task.queued"
    payload: TaskQueuedPayload


class RunPausedEvent(EventEnvelope):
    event_type: Literal["run.paused"] = "run.paused"
    payload: RunStatePayload


class RunPausingEvent(EventEnvelope):
    event_type: Literal["run.pausing"] = "run.pausing"
    payload: RunStatePayload


class RunResumedEvent(EventEnvelope):
    event_type: Literal["run.resumed"] = "run.resumed"
    payload: RunStatePayload


class RunCancelledEvent(EventEnvelope):
    event_type: Literal["run.cancelled"] = "run.cancelled"
    payload: RunStatePayload


DomainEvent = Annotated[
    RunCreatedEvent
    | TaskQueuedEvent
    | RunPausedEvent
    | RunPausingEvent
    | RunResumedEvent
    | RunCancelledEvent
    | WorkflowUpdatedEvent,
    Field(discriminator="event_type"),
]


class EventsPage(Contract):
    events: list[DomainEvent]
    next_after_seq: int
    has_more: bool
    last_event_seq: int


class RunCommand(Contract):
    command: Literal["pause", "resume", "cancel", "retry_failed"]


class Capability(Contract):
    id: str
    status: Literal["available", "planned", "disabled", "degraded"]
    reason: str | None


class RoleDefinition(Contract):
    role: Role
    name: str
    location: Location
    appearance_id: str
    instructions_version: str
    allowed_operations: list[str] = Field(default_factory=list)


class CapabilitiesResponse(Contract):
    stage: Literal["foundation", "worker"] = "foundation"
    capabilities: list[Capability]
    roles: list[RoleDefinition]


class ApiProblem(Contract):
    code: str
    message: str
    correlation_id: str
    retriable: bool


class UsageSummary(Contract):
    request_count: int
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    provider: str | None
    model: str | None
    cached_tokens: int | None = Field(default=None, ge=0)
    latency_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    source: Literal["test", "live", "unconfigured"] = "unconfigured"


class SessionInfo(Contract):
    command_token: str = Field(repr=False)


class CommandReceiptView(Contract):
    scope: str
    key: str
    params_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    response: ProjectView | RunView | ToolRunView
    created_at: datetime


class ContractBundle(Contract):
    create_project: CreateProject
    start_run: StartRun
    run_command: RunCommand
    snapshot: Snapshot
    events_page: EventsPage
    capabilities: CapabilitiesResponse
    problem: ApiProblem
    usage: UsageSummary
    session: SessionInfo
    command_receipt: CommandReceiptView
    decision_resolution: DecisionResolution
    artifact_content: ArtifactContent
    attempt_trace: AttemptTrace
    file_proposal: FileProposal
    tool_command: ToolCommand
    test_report: TestReport
    bug: Bug
