import type { DomainEvent, Snapshot, TaskView } from '../../../../packages/contracts';

export class ProjectionError extends Error {
  constructor(public readonly code: 'event_gap' | 'foreign_run' | 'unsupported_schema' | 'unsupported_event' | 'invalid_event' | 'invalid_history' | 'invalid_timestamp') {
    super(code);
    this.name = 'ProjectionError';
  }
}

export function applyEvent(snapshot: Snapshot, event: DomainEvent): Snapshot {
  if (snapshot.schema_version !== 1 || event.schema_version !== 1) {
    throw new ProjectionError('unsupported_schema');
  }
  if (event.run_id !== snapshot.run.id || event.project_id !== snapshot.project.id) {
    throw new ProjectionError('foreign_run');
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new ProjectionError('invalid_event');
  validatePayloadScope(snapshot, event);
  if (event.seq <= snapshot.last_event_seq) return snapshot;
  if (event.seq !== snapshot.last_event_seq + 1) throw new ProjectionError('event_gap');

  const cursor = { last_event_seq: event.seq };
  switch (event.event_type) {
    case 'run.created':
      if (event.payload.run.id !== snapshot.run.id || event.payload.project.id !== snapshot.project.id) {
        throw new ProjectionError('foreign_run');
      }
      return hydrateSnapshot({ ...snapshot, ...event.payload, run: { ...event.payload.run, ...cursor }, ...cursor });
    case 'task.queued': {
      const task = event.payload.task;
      if (task.run_id !== snapshot.run.id) throw new ProjectionError('foreign_run');
      const tasks = snapshot.tasks.some((item) => item.id === task.id)
        ? snapshot.tasks.map((item) => item.id === task.id ? task : item)
        : [...snapshot.tasks, task];
      return hydrateSnapshot({ ...snapshot, tasks, run: { ...snapshot.run, ...cursor }, ...cursor });
    }
    case 'run.paused':
    case 'run.pausing':
    case 'run.resumed':
    case 'run.cancelled':
      if (event.payload.run.id !== snapshot.run.id) throw new ProjectionError('foreign_run');
      return hydrateSnapshot({ ...snapshot, ...event.payload, run: { ...event.payload.run, ...cursor }, ...cursor });
    case 'workflow.updated': {
      if (event.payload.run.id !== snapshot.run.id) throw new ProjectionError('foreign_run');
      const { run, tasks, agents, artifacts, agent_runs, decisions, usage, candidate, tool_runs, quality_cycles } = event.payload;
      return hydrateSnapshot({ ...snapshot, run: { ...run, ...cursor }, tasks, agents, artifacts,
        agent_runs, decisions, usage, candidate: candidate ?? null, tool_runs: tool_runs ?? [], quality_cycles: quality_cycles ?? [], ...cursor });
    }
    default:
      throw new ProjectionError('unsupported_event');
  }
}

function validatePayloadScope(snapshot: Snapshot, event: DomainEvent) {
  const payload = event.payload;
  if ('run' in payload && (payload.run.id !== snapshot.run.id || payload.run.project_id !== snapshot.project.id)) {
    throw new ProjectionError('foreign_run');
  }
  if ('project' in payload && payload.project.id !== snapshot.project.id) throw new ProjectionError('foreign_run');
  const check = (views: readonly { run_id: string }[]) => {
    for (const view of views) if (view.run_id !== snapshot.run.id) throw new ProjectionError('foreign_run');
  };
  if ('task' in payload) check([payload.task]);
  if ('tasks' in payload) check(payload.tasks);
  if ('agents' in payload) check(payload.agents);
  if ('artifacts' in payload) check(payload.artifacts);
  if ('agent_runs' in payload) check(payload.agent_runs);
  if ('decisions' in payload) check(payload.decisions);
  if ('tool_runs' in payload && payload.tool_runs) check(payload.tool_runs);
  if ('quality_cycles' in payload && payload.quality_cycles) check(payload.quality_cycles);
  if ('quality_cycles' in payload || 'tool_runs' in payload || ('decisions' in payload && payload.decisions.some(decision => decision.tool_run_id != null || decision.kind === 'tool_uncertain_outcome'))) {
    hydrateSnapshot({ ...snapshot, ...payload, tool_runs: 'tool_runs' in payload ? payload.tool_runs ?? snapshot.tool_runs : snapshot.tool_runs,
      last_event_seq: 'run' in payload ? payload.run.last_event_seq : snapshot.last_event_seq });
  }
  if ('candidate' in payload && payload.candidate) {
    check([payload.candidate]);
    validateCandidate({ ...snapshot, ...payload });
  }
}

export function projectHistory(events: DomainEvent[], expectedLastSeq?: number): Snapshot {
  const first = events[0];
  if (!first) throw new ProjectionError('invalid_history');
  if (first.schema_version !== 1) throw new ProjectionError('unsupported_schema');
  if (first.event_type !== 'run.created') throw new ProjectionError('invalid_history');
  if (first.seq !== 1) throw new ProjectionError('event_gap');
  if (first.payload.run.project_id !== first.payload.project.id) throw new ProjectionError('foreign_run');
  let snapshot: Snapshot = {
    schema_version: 1, project: first.payload.project,
    run: { ...first.payload.run, last_event_seq: 0 },
    tasks: [], agents: [], artifacts: [], last_event_seq: 0,
    agent_runs: [], decisions: [], usage: null, candidate: null, tool_runs: [], quality_cycles: [],
  };
  for (const [index, event] of events.entries()) {
    if (index > 0 && event.event_type === 'run.created') throw new ProjectionError('invalid_history');
    if (event.seq !== index + 1) throw new ProjectionError('event_gap');
    snapshot = applyEvent(snapshot, event);
  }
  if (expectedLastSeq !== undefined && snapshot.last_event_seq !== expectedLastSeq) throw new ProjectionError('event_gap');
  return snapshot;
}

export function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  const normalized = withCompatibilityDefaults(structuredClone(snapshot));
  normalized.project.created_at = normalizeTimestamp(normalized.project.created_at);
  normalized.run.created_at = normalizeTimestamp(normalized.run.created_at);
  if (normalized.run.started_at !== null) normalized.run.started_at = normalizeTimestamp(normalized.run.started_at);
  if (normalized.run.finished_at !== null) normalized.run.finished_at = normalizeTimestamp(normalized.run.finished_at);
  for (const task of normalized.tasks) {
    task.created_at = normalizeTimestamp(task.created_at);
    if (task.lease_expires_at !== null) task.lease_expires_at = normalizeTimestamp(task.lease_expires_at);
  }
  for (const artifact of normalized.artifacts) artifact.created_at = normalizeTimestamp(artifact.created_at);
  for (const attempt of normalized.agent_runs ?? []) {
    attempt.created_at = normalizeTimestamp(attempt.created_at);
    if (attempt.started_at !== null) attempt.started_at = normalizeTimestamp(attempt.started_at);
    if (attempt.finished_at !== null) attempt.finished_at = normalizeTimestamp(attempt.finished_at);
  }
  for (const decision of normalized.decisions ?? []) {
    decision.created_at = normalizeTimestamp(decision.created_at);
    if (decision.resolved_at !== null) decision.resolved_at = normalizeTimestamp(decision.resolved_at);
  }
  for (const tool of normalized.tool_runs ?? []) {
    tool.created_at = normalizeTimestamp(tool.created_at);
    for (const field of ['started_at', 'finished_at', 'lease_expires_at'] as const) {
      if (tool[field] != null) tool[field] = normalizeTimestamp(tool[field]);
    }
  }
  for (const cycle of normalized.quality_cycles ?? []) {
    cycle.created_at = normalizeTimestamp(cycle.created_at);
    if (cycle.finished_at != null) cycle.finished_at = normalizeTimestamp(cycle.finished_at);
  }
  if (normalized.candidate) {
    normalized.candidate.created_at = normalizeTimestamp(normalized.candidate.created_at);
    normalized.candidate.updated_at = normalizeTimestamp(normalized.candidate.updated_at);
    normalized.candidate.files.sort((left, right) => left.relative_path.localeCompare(right.relative_path, 'en'));
  }
  const byId = (left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  normalized.tasks.sort(byId);
  normalized.agents.sort(byId);
  normalized.artifacts.sort(byId);
  normalized.agent_runs?.sort(byId);
  normalized.decisions?.sort(byId);
  normalized.tool_runs?.sort(byId);
  normalized.quality_cycles?.sort((left, right) => left.iteration - right.iteration);
  return normalized;
}

function taskDefaults(task: TaskView): TaskView {
  return { ...task, fencing_token: task.fencing_token ?? 0,
    active_attempt_id: task.active_attempt_id ?? null, blocked_reason: task.blocked_reason ?? null };
}

function withCompatibilityDefaults(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot, run: { ...snapshot.run, cancel_requested: snapshot.run.cancel_requested ?? false,
      test_scenario: snapshot.run.test_scenario ?? 'standard', injection_done: snapshot.run.injection_done ?? false,
      pause_requested: snapshot.run.pause_requested ?? false,
      profile_version: snapshot.run.profile_version ?? null,
      profile_hash: snapshot.run.profile_hash ?? null,
      acceptance_suite_hash: snapshot.run.acceptance_suite_hash ?? null,
      template_hash: snapshot.run.template_hash ?? null,
      limits: { ...snapshot.run.limits, max_file_bytes: snapshot.run.limits.max_file_bytes ?? 65536,
        max_files_per_proposal: snapshot.run.limits.max_files_per_proposal ?? 4,
        max_proposal_bytes: snapshot.run.limits.max_proposal_bytes ?? 262144 } },
    candidate: snapshot.candidate ?? null,
    tasks: snapshot.tasks.map(taskDefaults), agent_runs: snapshot.agent_runs ?? [],
    decisions: (snapshot.decisions ?? []).map(decision => ({ ...decision, blocking: decision.blocking ?? true, tool_run_id: decision.tool_run_id ?? null })),
    tool_runs: (snapshot.tool_runs ?? []).map(tool => ({ ...tool, qa_cycle_id: tool.qa_cycle_id ?? null })),
    quality_cycles: (snapshot.quality_cycles ?? []).map(cycle => ({ ...cycle,
      tool_report_artifact_ids: cycle.tool_report_artifact_ids ?? [], bug_artifact_ids: cycle.bug_artifact_ids ?? [],
      report_artifact_id: cycle.report_artifact_id ?? null, repair_task_id: cycle.repair_task_id ?? null,
      followup_task_id: cycle.followup_task_id ?? null, blocked_reason: cycle.blocked_reason ?? null,
      finished_at: cycle.finished_at ?? null })),
    usage: snapshot.usage == null ? null : { ...snapshot.usage,
      source: snapshot.usage.source ?? 'unconfigured', cached_tokens: snapshot.usage.cached_tokens ?? null,
      latency_ms: snapshot.usage.latency_ms ?? null },
    artifacts: snapshot.artifacts.map(artifact => ({ ...artifact, media_type: artifact.media_type ?? null,
      byte_size: artifact.byte_size ?? null })),
  };
}

export function hydrateSnapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.schema_version !== 1) throw new ProjectionError('unsupported_schema');
  if (snapshot.run.project_id !== snapshot.project.id) throw new ProjectionError('foreign_run');
  if (!Number.isSafeInteger(snapshot.last_event_seq) || snapshot.last_event_seq < 0
    || snapshot.last_event_seq !== snapshot.run.last_event_seq) throw new ProjectionError('event_gap');
  const normalized = withCompatibilityDefaults(snapshot);
  if (normalized.candidate && normalized.candidate.run_id !== normalized.run.id) throw new ProjectionError('foreign_run');
  const collections = [normalized.tasks, normalized.agents, normalized.artifacts,
    normalized.agent_runs ?? [], normalized.decisions ?? [], normalized.tool_runs ?? [], normalized.quality_cycles ?? []];
  for (const collection of collections) {
    const ids = new Set<string>();
    for (const entity of collection) {
      if (entity.run_id !== normalized.run.id) throw new ProjectionError('foreign_run');
      if (ids.has(entity.id)) throw new ProjectionError('invalid_event');
      ids.add(entity.id);
    }
  }
  const taskIds = new Set(normalized.tasks.map(task => task.id));
  const agentIds = new Set(normalized.agents.map(agent => agent.id));
  const artifactIds = new Set(normalized.artifacts.map(artifact => artifact.id));
  const attemptIds = new Set(normalized.agent_runs?.map(attempt => attempt.id));
  const decisionIds = new Set(normalized.decisions?.map(decision => decision.id));
  const toolIds = new Set(normalized.tool_runs?.map(tool => tool.id));
  const requireId = (id: string | null | undefined, ids: Set<string>) => {
    if (id != null && !ids.has(id)) throw new ProjectionError('foreign_run');
  };
  for (const task of normalized.tasks) requireId(task.active_attempt_id, attemptIds);
  for (const agent of normalized.agents) requireId(agent.current_task_id, taskIds);
  for (const artifact of normalized.artifacts) requireId(artifact.task_id, taskIds);
  for (const attempt of normalized.agent_runs ?? []) {
    requireId(attempt.task_id, taskIds); requireId(attempt.agent_id, agentIds);
    requireId(attempt.retry_of_attempt_id, attemptIds); requireId(attempt.decision_id, decisionIds);
  }
  for (const decision of normalized.decisions ?? []) {
    requireId(decision.task_id, taskIds); requireId(decision.attempt_id, attemptIds);
    requireId(decision.tool_run_id, toolIds);
    if (decision.kind === 'tool_uncertain_outcome' && (decision.task_id !== null || decision.attempt_id !== null || decision.tool_run_id == null)) throw new ProjectionError('invalid_event');
    if (decision.kind !== 'tool_uncertain_outcome' && decision.tool_run_id != null) throw new ProjectionError('invalid_event');
    for (const id of decision.artifact_ids) requireId(id, artifactIds);
  }
  validateCandidate(normalized);
  validateTools(normalized);
  validateQuality(normalized);
  return normalized;
}

function validateQuality(snapshot: Snapshot) {
  const cycles = snapshot.quality_cycles ?? [];
  const invalid = () => { throw new ProjectionError('invalid_event'); };
  const artifacts = new Map(snapshot.artifacts.map(a => [a.id, a]));
  const tools = new Map(snapshot.tool_runs?.map(t => [t.id, t]));
  const tasks = new Map(snapshot.tasks.map(t => [t.id, t]));
  const attempts = new Map(snapshot.agent_runs?.map(a => [a.id, a]));
  const cycleIds = new Set(cycles.map(c => c.id));
  const iterations = new Set<number>();
  const unique = (ids: string[]) => ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length;
  for (const tool of snapshot.tool_runs ?? []) if (tool.qa_cycle_id != null && !cycleIds.has(tool.qa_cycle_id)) invalid();
  for (const cycle of [...cycles].sort((a, b) => a.iteration - b.iteration)) {
    const candidate = snapshot.candidate;
    const task = tasks.get(cycle.task_id);
    const manifest = artifacts.get(cycle.manifest_artifact_id);
    if (!candidate || cycle.candidate_id !== candidate.id || !task || !manifest) throw new ProjectionError('foreign_run');
    if (!Number.isInteger(cycle.iteration) || cycle.iteration < 0 || cycle.iteration > 2 || iterations.has(cycle.iteration)
      || cycle.iteration !== iterations.size || task.role !== 'qa' || task.task_type !== 'quality_assurance' || task.iteration !== cycle.iteration
      || !['created', 'testing', 'analyzing', 'passed', 'failed', 'blocked', 'cancelled'].includes(cycle.status)
      || !Number.isSafeInteger(cycle.revision) || cycle.revision < 1 || cycle.revision > candidate.revision
      || manifest.artifact_type !== 'candidate_manifest' || manifest.version !== cycle.revision || manifest.content_hash !== cycle.manifest_hash
      || cycle.profile_version !== snapshot.run.profile_version || cycle.profile_hash !== snapshot.run.profile_hash
      || cycle.acceptance_suite_hash !== snapshot.run.acceptance_suite_hash || cycle.template_hash !== candidate.template_hash
      || ![cycle.tree_hash, cycle.manifest_hash, cycle.profile_hash, cycle.acceptance_suite_hash, cycle.template_hash].every(hash => /^[a-f0-9]{64}$/.test(hash))) invalid();
    if (cycle.revision === candidate.revision && (cycle.tree_hash !== candidate.tree_hash || cycle.manifest_artifact_id !== candidate.manifest_artifact_id)) invalid();
    iterations.add(cycle.iteration);
    if (!unique(cycle.tool_run_ids) || cycle.tool_run_ids.length > 3 || !unique(cycle.tool_report_artifact_ids ?? []) || !unique(cycle.bug_artifact_ids ?? [])) invalid();
    const operations = new Set<string>();
    for (const id of cycle.tool_run_ids) {
      const tool = tools.get(id);
      if (!tool) throw new ProjectionError('foreign_run');
      if (tool.qa_cycle_id !== cycle.id || tool.workspace_id !== cycle.candidate_id || tool.snapshot_version !== cycle.revision
        || tool.tree_hash !== cycle.tree_hash || tool.manifest_artifact_id !== cycle.manifest_artifact_id || tool.manifest_hash !== cycle.manifest_hash
        || tool.profile_version !== cycle.profile_version || tool.profile_hash !== cycle.profile_hash
        || tool.acceptance_suite_hash !== cycle.acceptance_suite_hash || tool.template_hash !== cycle.template_hash
        || !['validate_backend', 'test_backend', 'build_frontend'].includes(tool.operation_id) || operations.has(tool.operation_id)) invalid();
      operations.add(tool.operation_id);
    }
    for (const tool of tools.values()) if (tool.qa_cycle_id === cycle.id && !cycle.tool_run_ids.includes(tool.id)) invalid();
    const checkArtifact = (id: string, type: string) => {
      const artifact = artifacts.get(id);
      if (!artifact) throw new ProjectionError('foreign_run');
      if (artifact.artifact_type !== type || artifact.task_id !== cycle.task_id || artifact.author_role !== 'qa'
        || artifact.media_type !== 'application/json' || !/^[a-f0-9]{64}$/.test(artifact.content_hash)
        || artifact.input_versions[cycle.manifest_artifact_id] !== cycle.revision) invalid();
      for (const [input, version] of Object.entries(artifact.input_versions)) if (artifacts.get(input)?.version !== version) invalid();
      if (type === 'tool_report') {
        if (artifact.provenance?.origin !== 'tool' || !cycle.tool_run_ids.includes(artifact.provenance.producer_id ?? '')) invalid();
      } else {
        const producer = attempts.get(artifact.provenance?.producer_id ?? '');
        if (!producer || producer.task_id !== cycle.task_id || producer.run_id !== cycle.run_id
          || snapshot.agents.find(agent => agent.id === producer.agent_id)?.role !== 'qa'
          || !['test', 'llm'].includes(artifact.provenance?.origin ?? '')) invalid();
      }
      return artifact;
    };
    const producers = new Set<string>();
    for (const id of cycle.tool_report_artifact_ids ?? []) {
      const report = checkArtifact(id, 'tool_report');
      if (producers.has(report.provenance!.producer_id!)) invalid(); producers.add(report.provenance!.producer_id!);
    }
    if (cycle.report_artifact_id) checkArtifact(cycle.report_artifact_id, 'test_report');
    for (const id of cycle.bug_artifact_ids ?? []) checkArtifact(id, 'bug');
    if (['passed', 'failed'].includes(cycle.status) && (cycle.tool_run_ids.length !== 3
      || cycle.tool_report_artifact_ids?.length !== 3 || !cycle.report_artifact_id)) invalid();
    if (cycle.status === 'passed' && (cycle.bug_artifact_ids?.length || cycle.tool_run_ids.some(id => tools.get(id)?.status !== 'succeeded'))) invalid();
    if (cycle.status === 'failed') {
      const cycleTools = cycle.tool_run_ids.map(id => tools.get(id)!);
      const http = cycleTools.find(tool => tool.operation_id === 'test_backend');
      if (http?.status !== 'failed' || http.error_code !== 'tool_failed' || http.exit_code !== 1
        || cycleTools.some(tool => tool.operation_id !== 'test_backend' && tool.status !== 'succeeded')) invalid();
    }
    if (cycle.repair_task_id != null || cycle.followup_task_id != null) {
      const repair = tasks.get(cycle.repair_task_id ?? ''); const followup = tasks.get(cycle.followup_task_id ?? '');
      if (!repair || !followup) throw new ProjectionError('foreign_run');
      if (cycle.iteration >= 2 || !cycle.bug_artifact_ids?.length || repair.role !== 'backend' || repair.task_type !== 'backend_repair'
        || repair.iteration !== cycle.iteration + 1 || !repair.dependencies.includes(cycle.task_id)
        || followup.role !== 'qa' || followup.task_type !== 'quality_assurance' || followup.iteration !== repair.iteration
        || !followup.dependencies.includes(repair.id)) invalid();
    }
  }
  if (!cycles.length) return;
  // Historical artifacts remain evidence even after a repaired candidate advances.
  for (const artifact of snapshot.artifacts.filter(a => ['source_code', 'candidate_manifest'].includes(a.artifact_type))) {
    for (const [id, version] of Object.entries(artifact.input_versions)) if (artifacts.get(id)?.version !== version) invalid();
    const parentId = artifact.provenance?.parent_artifact_id;
    if (parentId) {
      const parent = artifacts.get(parentId);
      if (!parent || parent.artifact_type !== artifact.artifact_type || parent.version >= artifact.version
        || (artifact.artifact_type === 'source_code' && parent.relative_path !== artifact.relative_path)) invalid();
    }
    if (artifact.provenance?.producer_id) {
      const producer = attempts.get(artifact.provenance.producer_id);
      if (!producer || producer.task_id !== artifact.task_id || tasks.get(producer.task_id)?.role !== artifact.author_role) invalid();
    }
  }
}

function validateTools(snapshot: Snapshot) {
  for (const tool of snapshot.tool_runs ?? []) {
    const candidate = snapshot.candidate;
    const manifest = snapshot.artifacts.find(artifact => artifact.id === tool.manifest_artifact_id);
    if (!candidate || tool.workspace_id !== candidate.id || !manifest || manifest.run_id !== snapshot.run.id) throw new ProjectionError('foreign_run');
    if (!['created', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain', 'timed_out'].includes(tool.status)
      || !Number.isSafeInteger(tool.snapshot_version) || tool.snapshot_version < 1 || tool.snapshot_version > candidate.revision
      || manifest.artifact_type !== 'candidate_manifest' || manifest.version !== tool.snapshot_version || manifest.content_hash !== tool.manifest_hash
      || ![tool.tree_hash, tool.manifest_hash, tool.profile_hash, tool.acceptance_suite_hash, tool.template_hash].every(hash => /^[a-f0-9]{64}$/.test(hash))) throw new ProjectionError('invalid_event');
    if (tool.snapshot_version === candidate.revision && (tool.tree_hash !== candidate.tree_hash || tool.manifest_artifact_id !== candidate.manifest_artifact_id
      || tool.manifest_hash !== candidate.manifest_hash || tool.profile_version !== candidate.profile_version || tool.profile_hash !== candidate.profile_hash
      || tool.acceptance_suite_hash !== candidate.acceptance_suite_hash || tool.template_hash !== candidate.template_hash)) throw new ProjectionError('invalid_event');
  }
}

function validateCandidate(snapshot: Snapshot) {
  const candidate = snapshot.candidate;
  if (!candidate) return;
  const invalid = () => { throw new ProjectionError('invalid_event'); };
  const artifact = (id: string) => {
    const found = snapshot.artifacts.find(item => item.id === id);
    if (!found || found.run_id !== snapshot.run.id) throw new ProjectionError('foreign_run');
    return found;
  };
  const sameVersions = (left: Record<string, number>, right: Record<string, number>) =>
    Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([id, version]) => right[id] === version);
  const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (candidate.run_id !== snapshot.run.id) throw new ProjectionError('foreign_run');
  if (candidate.profile_version !== snapshot.run.profile_version || candidate.profile_hash !== snapshot.run.profile_hash
    || candidate.acceptance_suite_hash !== snapshot.run.acceptance_suite_hash
    || (snapshot.run.template_hash != null && candidate.template_hash !== snapshot.run.template_hash)
    || ![candidate.profile_hash, candidate.acceptance_suite_hash, candidate.template_hash, candidate.tree_hash].every(hash)) invalid();
  const manifest = artifact(candidate.manifest_artifact_id);
  let currentManifest: typeof manifest | null = manifest;
  while (currentManifest) {
    for (const [id, version] of Object.entries(currentManifest.input_versions)) {
      if (artifact(id).version !== version) invalid();
    }
    if (currentManifest.provenance?.producer_id) {
      const producer = snapshot.agent_runs?.find(item => item.id === currentManifest!.provenance!.producer_id);
      if (!producer || producer.run_id !== snapshot.run.id) throw new ProjectionError('foreign_run');
      if (producer.task_id !== currentManifest.task_id || snapshot.tasks.find(task => task.id === producer.task_id)?.role !== currentManifest.author_role) invalid();
    }
    const parent: typeof manifest | null = currentManifest.provenance?.parent_artifact_id ? artifact(currentManifest.provenance.parent_artifact_id) : null;
    if (parent && (parent.artifact_type !== 'candidate_manifest' || parent.version >= currentManifest.version)) invalid();
    currentManifest = parent;
  }
  if (manifest.artifact_type !== 'candidate_manifest' || manifest.version !== candidate.revision
    || !hash(manifest.content_hash) || candidate.manifest_hash !== manifest.content_hash
    || candidate.manifest_byte_size !== manifest.byte_size || manifest.media_type !== 'application/json') invalid();
  const paths = new Set<string>();
  for (const file of candidate.files) {
    const source = artifact(file.artifact_id);
    const parent = file.parent_artifact_id ? artifact(file.parent_artifact_id) : null;
    const producer = file.producer_id ? snapshot.agent_runs?.find(item => item.id === file.producer_id) : null;
    if (file.producer_id && (!producer || producer.run_id !== snapshot.run.id)) throw new ProjectionError('foreign_run');
    if (paths.has(file.relative_path) || source.artifact_type !== 'source_code' || source.relative_path !== file.relative_path
      || source.version !== file.version || source.content_hash !== file.content_hash || !hash(file.content_hash)
      || source.media_type !== file.media_type || source.byte_size !== file.byte_size
      || (source.author_role ?? null) !== (file.producer_role ?? null)
      || source.provenance?.origin !== file.source || (source.provenance?.producer_id ?? null) !== (file.producer_id ?? null)
      || (source.provenance?.parent_artifact_id ?? null) !== (file.parent_artifact_id ?? null)
      || !sameVersions(source.input_versions, file.input_versions ?? {})) invalid();
    if (parent && (parent.artifact_type !== 'source_code' || parent.relative_path !== file.relative_path
      || parent.content_hash !== file.parent_hash || parent.version >= file.version)) invalid();
    if (!parent && file.parent_hash != null) invalid();
    if (producer && (producer.task_id !== source.task_id
      || snapshot.tasks.find(task => task.id === producer.task_id)?.role !== file.producer_role)) invalid();
    if ((file.origin === 'template') !== (file.source === 'template')
      || (file.origin === 'test_injected' && file.source !== 'test') || (file.origin === 'generated' && file.source !== 'live')) invalid();
    for (const [id, version] of Object.entries(file.input_versions ?? {})) {
      if (artifact(id).version !== version) invalid();
    }
    paths.add(file.relative_path);
  }
}

function normalizeTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new ProjectionError('invalid_timestamp');
  const [, date, time, fraction = '', offset] = match;
  const utc = new Date(`${date}T${time}${offset}`);
  if (Number.isNaN(utc.getTime())) throw new ProjectionError('invalid_timestamp');
  const fractionalSeconds = fraction.replace(/0+$/, '');
  return `${utc.toISOString().slice(0, -5)}${fractionalSeconds ? `.${fractionalSeconds}` : ''}Z`;
}
