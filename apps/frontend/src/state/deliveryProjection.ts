import type { ArtifactView, DeliveryView, PreviewSessionView, Snapshot, ToolRunView } from '../../../../packages/contracts';
import { ProjectionError } from './projectionError';
import { normalizeTimestamp } from './projectionTimestamp';

const sourcePins = ['run_id', 'tree_hash', 'manifest_artifact_id', 'manifest_hash', 'profile_version',
  'profile_hash', 'acceptance_suite_hash', 'template_hash'] as const;
const deliveryPins = ['id', 'task_id', 'candidate_id', 'revision', 'qa_cycle_id', 'qa_report_artifact_id',
  'qa_report_hash', 'build_tool_run_id', 'build_report_hash', ...sourcePins] as const;
const packageHashes = ['package_manifest_hash', 'package_tree_hash', 'package_archive_hash'] as const;
const packageSizes = ['package_manifest_byte_size', 'package_archive_byte_size', 'package_payload_byte_size', 'package_file_count'] as const;
const packageFields = [...packageHashes, ...packageSizes] as const;
const deliveryReferences = ['smoke_tool_run_id', 'smoke_report_artifact_id', 'deployment_package_artifact_id', 'runbook_artifact_id'] as const;
const sessionPins = ['id', 'run_id', 'package_id', 'package_generation', 'package_tree_hash', 'start_tool_run_id'] as const;
const deliveryStatuses = ['created', 'publishing', 'smoking', 'analyzing', 'ready', 'failed', 'blocked', 'cancelled'] as const;
const sessionTransitions: Record<PreviewSessionView['status'], PreviewSessionView['status'][]> = {
  created: ['starting', 'stopping', 'failed', 'uncertain'],
  starting: ['ready', 'stopping', 'failed', 'uncertain'],
  ready: ['stopping', 'stopped', 'failed', 'uncertain'],
  stopping: ['stopped', 'failed', 'uncertain'],
  uncertain: ['stopped', 'failed'],
  stopped: [], failed: [],
};
const activeStatuses: PreviewSessionView['status'][] = ['created', 'starting', 'ready', 'stopping', 'uncertain'];
const deliveryArtifactKinds = ['smoke_report', 'deployment_package', 'runbook'];

const validHash = (hash: unknown) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const invalid = (): never => { throw new ProjectionError('invalid_event'); };
const sameTimestamp = (left: string, right: string | null | undefined) => right != null && normalizeTimestamp(left) === normalizeTimestamp(right);
function owned<T extends { run_id: string }>(entity: T | undefined, runId: string): T {
  if (!entity || entity.run_id !== runId) throw new ProjectionError('foreign_run');
  return entity;
}

export function latestPreview(sessions: readonly PreviewSessionView[] = []) {
  return sessions.reduce<PreviewSessionView | null>((latest, session) =>
    !latest || session.version > latest.version ? session : latest, null);
}

export function ownsPreview(session: PreviewSessionView, delivery: DeliveryView) {
  return session.run_id === delivery.run_id && session.package_id === delivery.id
    && session.package_generation === delivery.package_generation && session.package_tree_hash === delivery.package_tree_hash;
}

function ownsTool(tool: ToolRunView, delivery: DeliveryView) {
  return tool.workspace_id === delivery.candidate_id && tool.snapshot_version === delivery.revision
    && sourcePins.every(field => tool[field] === delivery[field]);
}

function checkArtifact(artifact: ArtifactView, delivery: DeliveryView, type: string, mediaType: string,
  inputs: Record<string, number>) {
  if (artifact.artifact_type !== type || artifact.task_id !== delivery.task_id || artifact.media_type !== mediaType
    || !validHash(artifact.content_hash) || !positiveInteger(artifact.version) || !positiveInteger(artifact.byte_size)
    || Object.keys(artifact.input_versions).length !== Object.keys(inputs).length
    || Object.entries(inputs).some(([id, version]) => artifact.input_versions[id] !== version)) invalid();
}

export function validateDeliveryProjection(snapshot: Snapshot) {
  const delivery = snapshot.delivery;
  const sessions = snapshot.preview_sessions ?? [];
  const tools = snapshot.tool_runs ?? [];
  const deliveryTools = tools.filter(tool => {
    if (['smoke_test', 'start_preview', 'stop_preview'].includes(tool.operation_id)) return true;
    if (tool.delivery_id != null || tool.preview_session_id != null) invalid();
    return false;
  });
  const artifacts = new Map(snapshot.artifacts.map(artifact => [artifact.id, artifact]));
  if ('access' in snapshot || 'preview_access' in snapshot || !Array.isArray(sessions)) invalid();
  if (!delivery) {
    if (sessions.length || deliveryTools.length || snapshot.artifacts.some(artifact => deliveryArtifactKinds.includes(artifact.artifact_type))) invalid();
    if (snapshot.run.workflow_version === 'clinic-v4' && snapshot.run.status === 'succeeded') invalid();
    return;
  }
  const runId = snapshot.run.id;
  owned(delivery, runId);
  if (snapshot.run.workflow_version !== 'clinic-v4' || snapshot.run.mode !== 'test' || !deliveryStatuses.includes(delivery.status)
    || !delivery.id || !Number.isSafeInteger(delivery.package_generation) || delivery.package_generation < 0
    || !validHash(delivery.qa_report_hash) || !validHash(delivery.build_report_hash)) invalid();
  normalizeTimestamp(delivery.created_at); normalizeTimestamp(delivery.updated_at);
  if (delivery.finished_at != null) normalizeTimestamp(delivery.finished_at);

  const task = owned(snapshot.tasks.find(item => item.id === delivery.task_id), runId);
  const candidate = owned(snapshot.candidate ?? undefined, runId);
  const cycle = owned(snapshot.quality_cycles?.find(item => item.id === delivery.qa_cycle_id), runId);
  const qaTask = owned(snapshot.tasks.find(item => item.id === cycle.task_id), runId);
  const qaReport = owned(artifacts.get(delivery.qa_report_artifact_id), runId);
  const build = owned(tools.find(tool => tool.id === delivery.build_tool_run_id), runId);
  const buildReport = owned(cycle.tool_report_artifact_ids?.map(id => artifacts.get(id))
    .find(artifact => artifact?.provenance?.producer_id === build.id), runId);
  if (task.role !== 'devops' || task.task_type !== 'build_and_preview'
    || task.dependencies.length !== 1 || task.dependencies[0] !== cycle.task_id
    || candidate.id !== delivery.candidate_id || cycle.candidate_id !== delivery.candidate_id
    || candidate.revision !== delivery.revision || cycle.revision !== delivery.revision
    || !sourcePins.every(field => candidate[field] === delivery[field] && cycle[field] === delivery[field])
    || cycle.status !== 'passed' || qaTask.status !== 'succeeded'
    || snapshot.quality_cycles?.some(item => item.iteration > cycle.iteration)
    || cycle.report_artifact_id !== qaReport.id || qaReport.content_hash !== delivery.qa_report_hash
    || !cycle.tool_run_ids.includes(build.id) || build.qa_cycle_id !== cycle.id
    || build.operation_id !== 'build_frontend' || build.status !== 'succeeded' || build.exit_code !== 0
    || build.report?.status !== 'passed' || !ownsTool(build, delivery)) invalid();

  const published = packageFields.some(field => delivery[field] != null);
  if (published && (!positiveInteger(delivery.package_generation)
    || !packageHashes.every(field => validHash(delivery[field])) || !packageSizes.every(field => positiveInteger(delivery[field])))) invalid();
  if (['smoking', 'analyzing', 'ready'].includes(delivery.status) && (!published || !delivery.smoke_tool_run_id)) invalid();
  if (!published && deliveryReferences.some(field => delivery[field] != null)) invalid();
  if (snapshot.run.status === 'succeeded' && delivery.status !== 'ready') invalid();

  const expectedToolIds = new Set<string>();
  const matchingTool = (tool: ToolRunView, operation: ToolRunView['operation_id'], sessionId: string | null) =>
    tool.operation_id === operation && tool.delivery_id === delivery.id && tool.qa_cycle_id == null
    && (tool.preview_session_id ?? null) === sessionId && ownsTool(tool, delivery);
  function linkedTool(id: string, operation: ToolRunView['operation_id'], sessionId: string | null) {
    const tool = owned(tools.find(item => item.id === id), runId);
    if (expectedToolIds.has(id) || !matchingTool(tool, operation, sessionId)) invalid();
    expectedToolIds.add(id);
    return tool;
  }

  const smoke = delivery.smoke_tool_run_id ? linkedTool(delivery.smoke_tool_run_id, 'smoke_test', null) : null;
  const smokeReport = delivery.smoke_report_artifact_id ? owned(artifacts.get(delivery.smoke_report_artifact_id), runId) : null;
  const manifestInput = { [delivery.manifest_artifact_id]: delivery.revision };
  if (smokeReport) {
    checkArtifact(smokeReport, delivery, 'smoke_report', 'application/json', manifestInput);
    if (!smoke || smokeReport.author_role != null || smokeReport.provenance?.origin !== 'tool'
      || smokeReport.provenance.producer_id !== smoke.id) invalid();
  }
  if (delivery.status === 'analyzing' || delivery.status === 'ready') {
    if (!smoke || !smokeReport || smoke.status !== 'succeeded' || smoke.exit_code !== 0
      || smoke.report?.status !== 'passed' || smoke.report.package_tree_hash !== delivery.package_tree_hash
      || smoke.report.health_status !== 200 || smoke.report.index_status !== 200
      || smoke.report.fresh_database !== true || smoke.report.owned_processes_stopped !== true) invalid();
  }

  const packageArtifact = delivery.deployment_package_artifact_id ? owned(artifacts.get(delivery.deployment_package_artifact_id), runId) : null;
  const runbook = delivery.runbook_artifact_id ? owned(artifacts.get(delivery.runbook_artifact_id), runId) : null;
  if (delivery.status === 'ready' && (!packageArtifact || !runbook || task.status !== 'succeeded' || !delivery.finished_at)) invalid();
  if (packageArtifact || runbook) {
    if (!packageArtifact || !runbook || !smokeReport) return invalid();
    const inputs = { ...manifestInput, [qaReport.id]: qaReport.version, [buildReport.id]: buildReport.version, [smokeReport.id]: smokeReport.version };
    checkArtifact(packageArtifact, delivery, 'deployment_package', 'application/json', inputs);
    checkArtifact(runbook, delivery, 'runbook', 'text/markdown', inputs);
    const producer = owned(snapshot.agent_runs?.find(attempt => attempt.id === packageArtifact.provenance?.producer_id), runId);
    const agent = owned(snapshot.agents.find(item => item.id === producer.agent_id), runId);
    if (producer.task_id !== task.id || producer.status !== 'succeeded' || agent.role !== 'devops'
      || [packageArtifact, runbook].some(artifact => artifact.author_role !== 'devops' || artifact.provenance?.origin !== 'test'
        || artifact.provenance.producer_id !== producer.id)) invalid();
  }
  for (const artifact of snapshot.artifacts) {
    if (deliveryArtifactKinds.includes(artifact.artifact_type) && artifact !== smokeReport && artifact !== packageArtifact && artifact !== runbook) invalid();
  }

  const current = latestPreview(sessions);
  const versions = new Set<number>();
  for (const session of sessions) {
    owned(session, runId);
    if (delivery.status !== 'ready' || snapshot.run.status !== 'succeeded' || !ownsPreview(session, delivery)
      || !session.id || !Object.hasOwn(sessionTransitions, session.status) || !positiveInteger(session.version) || versions.has(session.version)
      || (activeStatuses.includes(session.status) && session !== current) || !session.start_tool_run_id
      || ('origin' in session || 'access' in session || 'health_checked_at' in session)) return invalid();
    normalizeTimestamp(session.created_at); normalizeTimestamp(session.updated_at);
    if (session.ready_at != null) normalizeTimestamp(session.ready_at);
    if (session.finished_at != null) normalizeTimestamp(session.finished_at);
    versions.add(session.version);
    const start = linkedTool(session.start_tool_run_id, 'start_preview', session.id);
    if (session.status === 'ready' && (!session.ready_at || start.status !== 'succeeded')) invalid();
    if (session.status === 'stopping' && !session.stop_tool_run_id) invalid();
    if (session.stop_tool_run_id) linkedTool(session.stop_tool_run_id, 'stop_preview', session.id);
  }
  for (const tool of deliveryTools) {
    if (expectedToolIds.has(tool.id)) continue;
    if (!smoke || tool.status !== 'cancelled' || !matchingTool(tool, 'smoke_test', null)) invalid();
  }
}

export function validateDeliveryProgression(previous: Snapshot, next: Snapshot) {
  const before = previous.delivery;
  if (!before) return;
  const after = next.delivery;
  if (!after || deliveryPins.some(field => before[field] !== after[field]) || !sameTimestamp(before.created_at, after.created_at)
    || before.package_generation > after.package_generation
    || (before.package_tree_hash != null && (before.package_generation !== after.package_generation
      || packageFields.some(field => before[field] !== after[field])))
    || deliveryReferences.some(field => field !== 'smoke_tool_run_id' && before[field] != null && before[field] !== after[field])) return invalid();
  if (before.smoke_tool_run_id && before.smoke_tool_run_id !== after.smoke_tool_run_id) {
    if (before.status !== 'smoking' || after.status !== 'smoking' || !next.run.pause_requested
      || !next.tool_runs?.some(tool => tool.id === before.smoke_tool_run_id && tool.status === 'cancelled')) invalid();
  }

  const artifactIds = new Set([before.qa_report_artifact_id, before.smoke_report_artifact_id,
    before.deployment_package_artifact_id, before.runbook_artifact_id]);
  const nextArtifacts = new Map(next.artifacts.map(artifact => [artifact.id, artifact]));
  for (const artifact of previous.artifacts) {
    if (!artifactIds.has(artifact.id)) continue;
    const updated = nextArtifacts.get(artifact.id);
    if (!updated || updated.version !== artifact.version || updated.content_hash !== artifact.content_hash
      || updated.provenance?.producer_id !== artifact.provenance?.producer_id) invalid();
  }

  const previousSessions = new Map(previous.preview_sessions?.map(session => [session.id, session]));
  const nextSessions = new Map(next.preview_sessions?.map(session => [session.id, session]));
  for (const [id, session] of previousSessions) {
    const updated = nextSessions.get(id);
    if (!updated || sessionPins.some(field => session[field] !== updated[field]) || !sameTimestamp(session.created_at, updated.created_at)
      || session.version > updated.version
      || (session.status === updated.status ? session.version !== updated.version : session.version === updated.version
        || !sessionTransitions[session.status].includes(updated.status))
      || (session.stop_tool_run_id != null && session.stop_tool_run_id !== updated.stop_tool_run_id)
      || (session.ready_at != null && !sameTimestamp(session.ready_at, updated.ready_at))) invalid();
  }
  const lastVersion = latestPreview(previous.preview_sessions)?.version ?? 0;
  for (const [id, session] of nextSessions) {
    if (!previousSessions.has(id) && session.version <= lastVersion) invalid();
  }
}
