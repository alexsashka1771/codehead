/* Generated from Python contracts. Run npm run contracts; do not edit. */

export type Name = string;
export type Description = string;
export type Profile = 'clinic_demo';
export type Mode = 'live' | 'test';
export type MaxParallelTasks = number;
export type MaxRepairIterations = number;
export type MaxLlmCalls = number;
export type MaxTokens = number | null;
export type MaxCostUsd = number | null;
export type MaxDurationSeconds = number;
export type MaxFileBytes = number;
export type MaxFilesPerProposal = number;
export type MaxProposalBytes = number;
export type Command = 'pause' | 'resume' | 'cancel' | 'retry_failed';
export type SchemaVersion = 1;
export type Name1 = string;
export type Description1 = string;
export type Profile1 = 'clinic_demo';
export type Id = string;
export type RequirementsVersion = number;
export type CreatedAt = string;
export type Id1 = string;
export type ProjectId = string;
export type Mode1 = 'live' | 'test';
export type WorkflowVersion = string;
export type RequirementsVersion1 = number;
export type RunStatus = 'created' | 'running' | 'pausing' | 'paused' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export type LastEventSeq = number;
export type CreatedAt1 = string;
export type StartedAt = string | null;
export type FinishedAt = string | null;
export type BlockedReason = string | null;
export type CancelRequested = boolean;
export type PauseRequested = boolean;
export type ProfileVersion = string | null;
export type ProfileHash = string | null;
export type AcceptanceSuiteHash = string | null;
export type TemplateHash = string | null;
export type Id2 = string;
export type RunId = string;
export type Role = 'product_manager' | 'architect' | 'cto' | 'backend' | 'frontend' | 'qa' | 'devops';
export type TaskType = string;
export type TaskStatus =
  'queued' | 'running' | 'waiting_for_decision' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export type Dependencies = string[];
export type Iteration = number;
export type Attempt = number;
export type RecordVersion = number;
export type LeaseOwner = string | null;
export type LeaseExpiresAt = string | null;
export type CreatedAt2 = string;
export type FencingToken = number;
export type ActiveAttemptId = string | null;
export type BlockedReason1 = string | null;
export type Tasks = TaskView[];
export type Id3 = string;
export type RunId1 = string;
export type InstructionsVersion = string;
export type AppearanceId = string;
export type Lifecycle = 'idle' | 'busy' | 'blocked' | 'offline' | 'failed';
export type Activity =
  ('planning' | 'analyzing' | 'coding' | 'testing' | 'reviewing' | 'building' | 'meeting' | 'waiting') | null;
export type Location =
  | 'product'
  | 'architecture'
  | 'development'
  | 'qa'
  | 'security'
  | 'devops'
  | 'production'
  | 'research'
  | 'meeting'
  | 'core';
export type CurrentTaskId = string | null;
export type AllowedOperations = string[];
export type Agents = AgentView[];
export type Id4 = string;
export type RunId2 = string;
export type TaskId = string | null;
export type ArtifactType = string;
export type Version = number;
export type ContentHash = string;
export type RelativePath = string;
export type CreatedAt3 = string;
export type Origin = 'user' | 'template' | 'llm' | 'tool' | 'test' | 'unclassified';
export type ProducerId = string | null;
export type ParentArtifactId = string | null;
export type MediaType = string | null;
export type ByteSize = number | null;
export type Artifacts = ArtifactView[];
export type LastEventSeq1 = number;
export type Id5 = string;
export type RunId3 = string;
export type TaskId1 = string;
export type AgentId = string;
export type Number = number;
export type FencingToken1 = number;
export type Status = 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
export type Provider = string;
export type Model = string | null;
export type CreatedAt4 = string;
export type StartedAt1 = string | null;
export type FinishedAt1 = string | null;
export type ProviderRequestId = string | null;
export type StopReason = string | null;
export type InputTokens = number | null;
export type OutputTokens = number | null;
export type CostUsd = number | null;
export type LatencyMs = number | null;
export type ErrorCode = string | null;
export type ErrorMessage = string | null;
export type RetryOfAttemptId = string | null;
export type DecisionId = string | null;
export type TraceAvailable = boolean;
export type AgentRuns = AgentRunView[];
export type Id6 = string;
export type RunId4 = string;
export type TaskId2 = string | null;
export type AttemptId = string | null;
export type ToolRunId = string | null;
export type Kind = 'architecture_approval' | 'uncertain_outcome' | 'file_conflict' | 'tool_uncertain_outcome';
export type Status1 = 'open' | 'resolved';
export type Version1 = number;
export type Title = string;
export type Summary = string;
export type Choices = string[];
export type ArtifactIds = string[];
export type Choice = string | null;
export type Comment = string | null;
export type CreatedAt5 = string;
export type ResolvedAt = string | null;
export type Blocking = boolean;
export type Decisions = DecisionView[];
export type RequestCount = number;
export type InputTokens1 = number | null;
export type OutputTokens1 = number | null;
export type CostUsd1 = number | null;
export type Provider1 = string | null;
export type Model1 = string | null;
export type CachedTokens = number | null;
export type LatencyMs1 = number | null;
export type Source = 'test' | 'live' | 'unconfigured';
export type Id7 = string;
export type RunId5 = string;
export type Revision = number;
export type Status2 = 'assembling' | 'materializing' | 'ready' | 'conflict' | 'blocked';
export type ProfileVersion1 = string;
export type ProfileHash1 = string;
export type AcceptanceSuiteHash1 = string;
export type TemplateHash1 = string;
export type TreeHash = string;
export type ManifestArtifactId = string;
export type RelativePath1 = string;
export type ArtifactId = string;
export type Version2 = number;
export type ContentHash1 = string;
export type MediaType1 = string;
export type ByteSize1 = number;
export type Origin1 = 'template' | 'generated' | 'human' | 'test_injected';
export type Source1 = 'template' | 'live' | 'human' | 'test';
export type ProducerId1 = string | null;
export type ParentArtifactId1 = string | null;
export type ParentHash = string | null;
export type NormalizationVersion = 'utf8-lf-v1';
export type Files = CandidateFileView[];
export type CreatedAt6 = string;
export type UpdatedAt = string;
export type WorkspacePath = string | null;
export type BlockedReason2 = string | null;
export type ManifestHash = string | null;
export type ManifestByteSize = number | null;
export type OperationId = 'validate_backend' | 'test_backend' | 'build_frontend';
export type WorkspaceId = string;
export type SnapshotVersion = number;
export type RequiredIsolation = 'process_only' | 'container' | 'remote';
export type TimeoutSeconds = number;
export type OutputLimitBytes = number;
export type Id8 = string;
export type RunId6 = string;
export type Status3 = 'created' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'uncertain';
export type IsolationLevel = 'process_only';
export type TreeHash1 = string;
export type ManifestArtifactId1 = string;
export type ManifestHash1 = string;
export type ProfileVersion2 = string;
export type ProfileHash2 = string;
export type AcceptanceSuiteHash2 = string;
export type TemplateHash2 = string;
export type Commands = string[][];
export type Stdout = string;
export type Stderr = string;
export type Report = {
  [k: string]: unknown;
} | null;
export type ExitCode = number | null;
export type ErrorCode1 = string | null;
export type ErrorMessage1 = string | null;
export type ProcessId = number | null;
export type CreatedAt7 = string;
export type StartedAt2 = string | null;
export type FinishedAt2 = string | null;
export type FencingToken2 = number;
export type LeaseOwner1 = string | null;
export type LeaseExpiresAt1 = string | null;
export type ToolRuns = ToolRunView[];
export type EventId = string;
export type SchemaVersion1 = 1;
export type ProjectId1 = string;
export type RunId7 = string;
export type Seq = number;
export type OccurredAt = string;
export type ActorId = string | null;
export type TaskId3 = string | null;
export type CorrelationId = string;
export type CausationId = string | null;
export type EventType = 'run.created';
export type Agents1 = AgentView[];
export type EventId1 = string;
export type SchemaVersion2 = 1;
export type ProjectId2 = string;
export type RunId8 = string;
export type Seq1 = number;
export type OccurredAt1 = string;
export type ActorId1 = string | null;
export type TaskId4 = string | null;
export type CorrelationId1 = string;
export type CausationId1 = string | null;
export type EventType1 = 'task.queued';
export type EventId2 = string;
export type SchemaVersion3 = 1;
export type ProjectId3 = string;
export type RunId9 = string;
export type Seq2 = number;
export type OccurredAt2 = string;
export type ActorId2 = string | null;
export type TaskId5 = string | null;
export type CorrelationId2 = string;
export type CausationId2 = string | null;
export type EventType2 = 'run.paused';
export type Tasks1 = TaskView[];
export type Agents2 = AgentView[];
export type EventId3 = string;
export type SchemaVersion4 = 1;
export type ProjectId4 = string;
export type RunId10 = string;
export type Seq3 = number;
export type OccurredAt3 = string;
export type ActorId3 = string | null;
export type TaskId6 = string | null;
export type CorrelationId3 = string;
export type CausationId3 = string | null;
export type EventType3 = 'run.pausing';
export type EventId4 = string;
export type SchemaVersion5 = 1;
export type ProjectId5 = string;
export type RunId11 = string;
export type Seq4 = number;
export type OccurredAt4 = string;
export type ActorId4 = string | null;
export type TaskId7 = string | null;
export type CorrelationId4 = string;
export type CausationId4 = string | null;
export type EventType4 = 'run.resumed';
export type EventId5 = string;
export type SchemaVersion6 = 1;
export type ProjectId6 = string;
export type RunId12 = string;
export type Seq5 = number;
export type OccurredAt5 = string;
export type ActorId5 = string | null;
export type TaskId8 = string | null;
export type CorrelationId5 = string;
export type CausationId5 = string | null;
export type EventType5 = 'run.cancelled';
export type EventId6 = string;
export type SchemaVersion7 = 1;
export type ProjectId7 = string;
export type RunId13 = string;
export type Seq6 = number;
export type OccurredAt6 = string;
export type ActorId6 = string | null;
export type TaskId9 = string | null;
export type CorrelationId6 = string;
export type CausationId6 = string | null;
export type EventType6 = 'workflow.updated';
export type Tasks2 = TaskView[];
export type Agents3 = AgentView[];
export type Action = string;
export type Artifacts1 = ArtifactView[];
export type AgentRuns1 = AgentRunView[];
export type Decisions1 = DecisionView[];
export type ToolRuns1 = ToolRunView[];
export type Events = (
  | RunCreatedEvent
  | TaskQueuedEvent
  | RunPausedEvent
  | RunPausingEvent
  | RunResumedEvent
  | RunCancelledEvent
  | WorkflowUpdatedEvent
)[];
export type NextAfterSeq = number;
export type HasMore = boolean;
export type LastEventSeq2 = number;
export type Stage = 'foundation' | 'worker';
export type Id9 = string;
export type Status4 = 'available' | 'planned' | 'disabled' | 'degraded';
export type Reason = string | null;
export type Capabilities = Capability[];
export type Name2 = string;
export type AppearanceId1 = string;
export type InstructionsVersion1 = string;
export type AllowedOperations1 = string[];
export type Roles = RoleDefinition[];
export type Code = string;
export type Message = string;
export type CorrelationId7 = string;
export type Retriable = boolean;
export type CommandToken = string;
export type Scope = string;
export type Key = string;
export type ParamsHash = string;
export type Response = ProjectView | RunView | ToolRunView;
export type CreatedAt8 = string;
export type Version3 = number;
export type Choice1 = 'approve' | 'reject' | 'confirm_failed' | 'retry_with_risk' | 'retry_files';
export type Comment1 = string;
export type ArtifactId1 = string;
export type ContentHash2 = string;
export type MediaType2 = string;
export type ByteSize2 = number;
export type Content = string;
export type AttemptId1 = string;
export type Prompt = string | null;
export type RawResponse = string | null;
export type StopReason1 = string | null;
export type RedactionVersion = string;
export type RelativePath2 = string;
export type BaseHash = string | null;
export type MediaType3 = string;
export type Content1 = string;
export type OperationId1 = 'validate_backend' | 'test_backend' | 'build_frontend';
export type WorkspaceId1 = string;
export type SnapshotVersion1 = number;
export type RequiredIsolation1 = 'process_only' | 'container' | 'remote';
export type TimeoutSeconds1 = number;
export type OutputLimitBytes1 = number;

export interface ContractBundle {
  create_project: CreateProject;
  start_run: StartRun;
  run_command: RunCommand;
  snapshot: Snapshot;
  events_page: EventsPage;
  capabilities: CapabilitiesResponse;
  problem: ApiProblem;
  usage: UsageSummary;
  session: SessionInfo;
  command_receipt: CommandReceiptView;
  decision_resolution: DecisionResolution;
  artifact_content: ArtifactContent;
  attempt_trace: AttemptTrace;
  file_proposal: FileProposal;
  tool_command: ToolCommand;
}
export interface CreateProject {
  name: Name;
  description: Description;
  profile?: Profile;
}
export interface StartRun {
  mode?: Mode;
  limits?: RunLimits;
}
export interface RunLimits {
  max_parallel_tasks?: MaxParallelTasks;
  max_repair_iterations?: MaxRepairIterations;
  max_llm_calls?: MaxLlmCalls;
  max_tokens?: MaxTokens;
  max_cost_usd?: MaxCostUsd;
  max_duration_seconds?: MaxDurationSeconds;
  max_file_bytes?: MaxFileBytes;
  max_files_per_proposal?: MaxFilesPerProposal;
  max_proposal_bytes?: MaxProposalBytes;
}
export interface RunCommand {
  command: Command;
}
export interface Snapshot {
  schema_version?: SchemaVersion;
  project: ProjectView;
  run: RunView;
  tasks: Tasks;
  agents: Agents;
  artifacts: Artifacts;
  last_event_seq: LastEventSeq1;
  agent_runs?: AgentRuns;
  decisions?: Decisions;
  usage?: UsageSummary | null;
  candidate?: CandidateView | null;
  tool_runs?: ToolRuns;
}
export interface ProjectView {
  name: Name1;
  description: Description1;
  profile?: Profile1;
  id: Id;
  requirements_version: RequirementsVersion;
  created_at: CreatedAt;
}
export interface RunView {
  id: Id1;
  project_id: ProjectId;
  mode: Mode1;
  workflow_version: WorkflowVersion;
  requirements_version: RequirementsVersion1;
  status: RunStatus;
  limits: RunLimits;
  last_event_seq: LastEventSeq;
  created_at: CreatedAt1;
  started_at: StartedAt;
  finished_at: FinishedAt;
  blocked_reason: BlockedReason;
  cancel_requested?: CancelRequested;
  pause_requested?: PauseRequested;
  profile_version?: ProfileVersion;
  profile_hash?: ProfileHash;
  acceptance_suite_hash?: AcceptanceSuiteHash;
  template_hash?: TemplateHash;
}
export interface TaskView {
  id: Id2;
  run_id: RunId;
  role: Role;
  task_type: TaskType;
  status: TaskStatus;
  dependencies: Dependencies;
  input_versions: InputVersions;
  iteration: Iteration;
  attempt: Attempt;
  record_version: RecordVersion;
  lease_owner: LeaseOwner;
  lease_expires_at: LeaseExpiresAt;
  created_at: CreatedAt2;
  fencing_token?: FencingToken;
  active_attempt_id?: ActiveAttemptId;
  blocked_reason?: BlockedReason1;
}
export interface InputVersions {
  [k: string]: number;
}
export interface AgentView {
  id: Id3;
  run_id: RunId1;
  role: Role;
  instructions_version: InstructionsVersion;
  appearance_id: AppearanceId;
  lifecycle: Lifecycle;
  activity: Activity;
  location: Location;
  current_task_id: CurrentTaskId;
  allowed_operations?: AllowedOperations;
}
export interface ArtifactView {
  id: Id4;
  run_id: RunId2;
  task_id: TaskId;
  artifact_type: ArtifactType;
  version: Version;
  content_hash: ContentHash;
  relative_path: RelativePath;
  author_role: Role | null;
  input_versions: InputVersions1;
  created_at: CreatedAt3;
  provenance?: ArtifactProvenance;
  media_type?: MediaType;
  byte_size?: ByteSize;
}
export interface InputVersions1 {
  [k: string]: number;
}
export interface ArtifactProvenance {
  origin?: Origin;
  producer_id?: ProducerId;
  parent_artifact_id?: ParentArtifactId;
}
export interface AgentRunView {
  id: Id5;
  run_id: RunId3;
  task_id: TaskId1;
  agent_id: AgentId;
  number: Number;
  fencing_token: FencingToken1;
  status: Status;
  provider: Provider;
  model: Model;
  input_versions: InputVersions2;
  parameters: Parameters;
  created_at: CreatedAt4;
  started_at: StartedAt1;
  finished_at: FinishedAt1;
  provider_request_id: ProviderRequestId;
  stop_reason: StopReason;
  input_tokens: InputTokens;
  output_tokens: OutputTokens;
  cost_usd: CostUsd;
  latency_ms: LatencyMs;
  error_code: ErrorCode;
  error_message: ErrorMessage;
  retry_of_attempt_id: RetryOfAttemptId;
  decision_id: DecisionId;
  trace_available: TraceAvailable;
}
export interface InputVersions2 {
  [k: string]: number;
}
export interface Parameters {
  [k: string]: unknown;
}
export interface DecisionView {
  id: Id6;
  run_id: RunId4;
  task_id: TaskId2;
  attempt_id: AttemptId;
  tool_run_id?: ToolRunId;
  kind: Kind;
  status: Status1;
  version: Version1;
  title: Title;
  summary: Summary;
  choices: Choices;
  artifact_ids: ArtifactIds;
  choice: Choice;
  comment: Comment;
  created_at: CreatedAt5;
  resolved_at: ResolvedAt;
  blocking?: Blocking;
}
export interface UsageSummary {
  request_count: RequestCount;
  input_tokens: InputTokens1;
  output_tokens: OutputTokens1;
  cost_usd: CostUsd1;
  provider: Provider1;
  model: Model1;
  cached_tokens?: CachedTokens;
  latency_ms?: LatencyMs1;
  source?: Source;
}
export interface CandidateView {
  id: Id7;
  run_id: RunId5;
  revision: Revision;
  status: Status2;
  profile_version: ProfileVersion1;
  profile_hash: ProfileHash1;
  acceptance_suite_hash: AcceptanceSuiteHash1;
  template_hash: TemplateHash1;
  tree_hash: TreeHash;
  manifest_artifact_id: ManifestArtifactId;
  files: Files;
  created_at: CreatedAt6;
  updated_at: UpdatedAt;
  workspace_path?: WorkspacePath;
  blocked_reason?: BlockedReason2;
  manifest_hash?: ManifestHash;
  manifest_byte_size?: ManifestByteSize;
}
export interface CandidateFileView {
  relative_path: RelativePath1;
  artifact_id: ArtifactId;
  version: Version2;
  content_hash: ContentHash1;
  media_type: MediaType1;
  byte_size: ByteSize1;
  origin: Origin1;
  source: Source1;
  producer_id?: ProducerId1;
  producer_role?: Role | null;
  parent_artifact_id?: ParentArtifactId1;
  parent_hash?: ParentHash;
  input_versions?: InputVersions3;
  normalization_version?: NormalizationVersion;
}
export interface InputVersions3 {
  [k: string]: number;
}
export interface ToolRunView {
  operation_id: OperationId;
  workspace_id: WorkspaceId;
  snapshot_version: SnapshotVersion;
  required_isolation?: RequiredIsolation;
  timeout_seconds?: TimeoutSeconds;
  output_limit_bytes?: OutputLimitBytes;
  id: Id8;
  run_id: RunId6;
  status: Status3;
  isolation_level?: IsolationLevel;
  tree_hash: TreeHash1;
  manifest_artifact_id: ManifestArtifactId1;
  manifest_hash: ManifestHash1;
  profile_version: ProfileVersion2;
  profile_hash: ProfileHash2;
  acceptance_suite_hash: AcceptanceSuiteHash2;
  template_hash: TemplateHash2;
  commands?: Commands;
  stdout?: Stdout;
  stderr?: Stderr;
  report?: Report;
  exit_code?: ExitCode;
  error_code?: ErrorCode1;
  error_message?: ErrorMessage1;
  process_id?: ProcessId;
  created_at: CreatedAt7;
  started_at?: StartedAt2;
  finished_at?: FinishedAt2;
  fencing_token?: FencingToken2;
  lease_owner?: LeaseOwner1;
  lease_expires_at?: LeaseExpiresAt1;
}
export interface EventsPage {
  events: Events;
  next_after_seq: NextAfterSeq;
  has_more: HasMore;
  last_event_seq: LastEventSeq2;
}
export interface RunCreatedEvent {
  event_id: EventId;
  schema_version?: SchemaVersion1;
  project_id: ProjectId1;
  run_id: RunId7;
  seq: Seq;
  occurred_at: OccurredAt;
  actor_id: ActorId;
  task_id: TaskId3;
  correlation_id: CorrelationId;
  causation_id: CausationId;
  event_type?: EventType;
  payload: RunCreatedPayload;
}
export interface RunCreatedPayload {
  project: ProjectView;
  run: RunView;
  agents: Agents1;
  usage?: UsageSummary | null;
}
export interface TaskQueuedEvent {
  event_id: EventId1;
  schema_version?: SchemaVersion2;
  project_id: ProjectId2;
  run_id: RunId8;
  seq: Seq1;
  occurred_at: OccurredAt1;
  actor_id: ActorId1;
  task_id: TaskId4;
  correlation_id: CorrelationId1;
  causation_id: CausationId1;
  event_type?: EventType1;
  payload: TaskQueuedPayload;
}
export interface TaskQueuedPayload {
  task: TaskView;
}
export interface RunPausedEvent {
  event_id: EventId2;
  schema_version?: SchemaVersion3;
  project_id: ProjectId3;
  run_id: RunId9;
  seq: Seq2;
  occurred_at: OccurredAt2;
  actor_id: ActorId2;
  task_id: TaskId5;
  correlation_id: CorrelationId2;
  causation_id: CausationId2;
  event_type?: EventType2;
  payload: RunStatePayload;
}
export interface RunStatePayload {
  run: RunView;
  tasks: Tasks1;
  agents: Agents2;
}
export interface RunPausingEvent {
  event_id: EventId3;
  schema_version?: SchemaVersion4;
  project_id: ProjectId4;
  run_id: RunId10;
  seq: Seq3;
  occurred_at: OccurredAt3;
  actor_id: ActorId3;
  task_id: TaskId6;
  correlation_id: CorrelationId3;
  causation_id: CausationId3;
  event_type?: EventType3;
  payload: RunStatePayload;
}
export interface RunResumedEvent {
  event_id: EventId4;
  schema_version?: SchemaVersion5;
  project_id: ProjectId5;
  run_id: RunId11;
  seq: Seq4;
  occurred_at: OccurredAt4;
  actor_id: ActorId4;
  task_id: TaskId7;
  correlation_id: CorrelationId4;
  causation_id: CausationId4;
  event_type?: EventType4;
  payload: RunStatePayload;
}
export interface RunCancelledEvent {
  event_id: EventId5;
  schema_version?: SchemaVersion6;
  project_id: ProjectId6;
  run_id: RunId12;
  seq: Seq5;
  occurred_at: OccurredAt5;
  actor_id: ActorId5;
  task_id: TaskId8;
  correlation_id: CorrelationId5;
  causation_id: CausationId5;
  event_type?: EventType5;
  payload: RunStatePayload;
}
export interface WorkflowUpdatedEvent {
  event_id: EventId6;
  schema_version?: SchemaVersion7;
  project_id: ProjectId7;
  run_id: RunId13;
  seq: Seq6;
  occurred_at: OccurredAt6;
  actor_id: ActorId6;
  task_id: TaskId9;
  correlation_id: CorrelationId6;
  causation_id: CausationId6;
  event_type?: EventType6;
  payload: WorkflowUpdatedPayload;
}
export interface WorkflowUpdatedPayload {
  run: RunView;
  tasks: Tasks2;
  agents: Agents3;
  action: Action;
  artifacts: Artifacts1;
  agent_runs: AgentRuns1;
  decisions: Decisions1;
  usage: UsageSummary;
  candidate?: CandidateView | null;
  tool_runs?: ToolRuns1;
}
export interface CapabilitiesResponse {
  stage?: Stage;
  capabilities: Capabilities;
  roles: Roles;
}
export interface Capability {
  id: Id9;
  status: Status4;
  reason: Reason;
}
export interface RoleDefinition {
  role: Role;
  name: Name2;
  location: Location;
  appearance_id: AppearanceId1;
  instructions_version: InstructionsVersion1;
  allowed_operations?: AllowedOperations1;
}
export interface ApiProblem {
  code: Code;
  message: Message;
  correlation_id: CorrelationId7;
  retriable: Retriable;
}
export interface SessionInfo {
  command_token: CommandToken;
}
export interface CommandReceiptView {
  scope: Scope;
  key: Key;
  params_hash: ParamsHash;
  response: Response;
  created_at: CreatedAt8;
}
export interface DecisionResolution {
  version: Version3;
  choice: Choice1;
  comment?: Comment1;
}
export interface ArtifactContent {
  artifact_id: ArtifactId1;
  content_hash: ContentHash2;
  media_type: MediaType2;
  byte_size: ByteSize2;
  content: Content;
}
export interface AttemptTrace {
  attempt_id: AttemptId1;
  prompt: Prompt;
  raw_response: RawResponse;
  parameters: Parameters1;
  input_versions: InputVersions4;
  stop_reason: StopReason1;
  redaction_version: RedactionVersion;
}
export interface Parameters1 {
  [k: string]: unknown;
}
export interface InputVersions4 {
  [k: string]: number;
}
export interface FileProposal {
  relative_path: RelativePath2;
  base_hash?: BaseHash;
  media_type?: MediaType3;
  content: Content1;
}
export interface ToolCommand {
  operation_id: OperationId1;
  workspace_id: WorkspaceId1;
  snapshot_version: SnapshotVersion1;
  required_isolation?: RequiredIsolation1;
  timeout_seconds?: TimeoutSeconds1;
  output_limit_bytes?: OutputLimitBytes1;
}

export type DomainEvent = EventsPage['events'][number];
