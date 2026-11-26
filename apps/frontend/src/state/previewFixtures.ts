import type { ArtifactView, DeliveryView, PreviewSessionView, PreviewView, Snapshot, ToolRunView } from '../../../../packages/contracts';
import { createHash } from 'node:crypto';
import { makeSnapshot, testTask } from './fixtures';
import { makeQualitySnapshot } from './qualityFixtures';

const deterministicHash = (character: string) => character.repeat(64);

export function makeDeliverySnapshot({ runId = 'run-one', readySession = true } = {}): Snapshot {
  const snapshot = makeQualitySnapshot(2);
  snapshot.run = { ...snapshot.run, workflow_version: 'clinic-v4', status: 'succeeded', blocked_reason: null };
  const cycle = snapshot.quality_cycles![1];
  const qaReport = snapshot.artifacts.find(artifact => artifact.id === cycle.report_artifact_id)!;
  const build = snapshot.tool_runs!.find(tool => tool.id === cycle.tool_run_ids[2])!;
  build.report = { status: 'passed' };
  const buildReport = snapshot.artifacts.find(artifact => artifact.provenance?.producer_id === build.id)!;
  const taskId = 'task-devops';
  const attemptId = 'attempt-devops';
  const agentId = 'agent-devops';
  const packageId = 'package-' + runId;
  const sessionId = 'preview-' + runId;
  const date = snapshot.candidate!.updated_at;
  snapshot.tasks.push({ ...testTask, id: taskId, role: 'devops', task_type: 'build_and_preview',
    dependencies: [cycle.task_id], status: 'succeeded' });
  snapshot.agents.push({ ...snapshot.agents[0], id: agentId, role: 'devops', location: 'devops' });
  snapshot.agent_runs!.push({ ...snapshot.agent_runs![0], id: attemptId, agent_id: agentId, task_id: taskId });
  const tool = (operation: ToolRunView['operation_id'], id: string, previewId: string | null): ToolRunView => ({
    ...build, operation_id: operation, id, qa_cycle_id: null, delivery_id: packageId, preview_session_id: previewId,
    report: { ok: true },
  });
  const smoke = tool('smoke_test', 'tool-smoke', null);
  smoke.report = { status: 'passed', package_tree_hash: deterministicHash('2'), health_status: 200, index_status: 200,
    fresh_database: true, owned_processes_stopped: true };
  snapshot.tool_runs!.push(smoke);
  const sourceVersions = {
    [cycle.manifest_artifact_id]: cycle.revision, [qaReport.id]: qaReport.version, [buildReport.id]: buildReport.version,
  };
  const artifact = (id: string, artifactType: string, mediaType: string, producer: string, origin: 'tool' | 'test',
    inputVersions: Record<string, number>): ArtifactView => ({
    id, run_id: runId, task_id: taskId, artifact_type: artifactType, version: 1, author_role: 'devops',
    content_hash: deterministicHash('e'), media_type: mediaType, byte_size: 42, relative_path: 'delivery/' + id,
    provenance: { origin, producer_id: producer, parent_artifact_id: null }, input_versions: inputVersions, created_at: date,
  });
  const smokeReport = { ...artifact('artifact-smoke', 'smoke_report', 'application/json', smoke.id, 'tool',
    { [cycle.manifest_artifact_id]: cycle.revision }), author_role: null };
  const devopsVersions = { ...sourceVersions, [smokeReport.id]: smokeReport.version };
  snapshot.artifacts.push(smokeReport,
    artifact('artifact-package', 'deployment_package', 'application/json', attemptId, 'test', devopsVersions),
    artifact('artifact-runbook', 'runbook', 'text/markdown', attemptId, 'test', devopsVersions));
  snapshot.delivery = {
    id: packageId, run_id: runId, task_id: taskId, status: 'ready', qa_cycle_id: cycle.id,
    candidate_id: cycle.candidate_id, revision: cycle.revision, tree_hash: cycle.tree_hash,
    manifest_artifact_id: cycle.manifest_artifact_id, manifest_hash: cycle.manifest_hash,
    profile_version: cycle.profile_version, profile_hash: cycle.profile_hash,
    acceptance_suite_hash: cycle.acceptance_suite_hash, template_hash: cycle.template_hash,
    qa_report_artifact_id: qaReport.id, qa_report_hash: qaReport.content_hash, build_tool_run_id: build.id,
    build_report_hash: createHash('sha256').update(JSON.stringify(build.report) + '\n').digest('hex'), package_generation: 1,
    package_manifest_hash: deterministicHash('1'), package_manifest_byte_size: 500, package_tree_hash: deterministicHash('2'),
    package_archive_hash: deterministicHash('3'), package_archive_byte_size: 20_704,
    package_payload_byte_size: 99_420, package_file_count: 30, smoke_tool_run_id: smoke.id,
    smoke_report_artifact_id: smokeReport.id, deployment_package_artifact_id: 'artifact-package', runbook_artifact_id: 'artifact-runbook',
    created_at: date, updated_at: date, finished_at: date,
  } satisfies DeliveryView;
  snapshot.preview_sessions = readySession ? [{
    id: sessionId, run_id: runId, package_id: packageId, package_generation: 1,
    package_tree_hash: snapshot.delivery.package_tree_hash!, status: 'ready', version: 3,
    start_tool_run_id: 'tool-start-preview', created_at: date, updated_at: date, ready_at: date,
  }] : [];
  if (readySession) snapshot.tool_runs!.push(tool('start_preview', 'tool-start-preview', sessionId));
  snapshot.run.id = runId;
  snapshot.candidate!.run_id = runId;
  snapshot.delivery.run_id = runId;
  for (const list of [snapshot.tasks, snapshot.artifacts, snapshot.agents, snapshot.agent_runs!, snapshot.tool_runs!, snapshot.quality_cycles!]) {
    for (const item of list) item.run_id = runId;
  }
  return snapshot;
}

export function makeAccess(snapshot: Snapshot, origin = 'http://127.0.0.1:45670', checkedAt = new Date().toISOString()): PreviewView {
  const session = snapshot.preview_sessions?.at(-1);
  return { run_id: snapshot.run.id, delivery: snapshot.delivery, preview_sessions: snapshot.preview_sessions,
    access: { run_id: snapshot.run.id, package_id: snapshot.delivery!.id, preview_session_id: session?.id ?? null,
      version: session?.version ?? null, status: session?.status === 'ready' ? 'available' : 'unavailable',
      reason: session?.status === 'ready' ? null : 'Локальный preview ещё не запущен.',
      origin: session?.status === 'ready' ? origin : null, health_checked_at: checkedAt } };
}

export function makeReceipt(snapshot: Snapshot, command: 'start' | 'stop'): PreviewSessionView {
  const session = snapshot.preview_sessions?.at(-1);
  const date = snapshot.delivery!.updated_at;
  return { id: command === 'start' ? 'new-session' : session!.id, run_id: snapshot.run.id,
    package_id: snapshot.delivery!.id, package_generation: snapshot.delivery!.package_generation,
    package_tree_hash: snapshot.delivery!.package_tree_hash!, status: command === 'start' ? 'created' : 'stopping',
    start_tool_run_id: session?.start_tool_run_id ?? 'new-start-tool', stop_tool_run_id: command === 'stop' ? 'new-stop-tool' : null,
    version: (session?.version ?? 0) + 1, created_at: date, updated_at: date };
}

export function legacyWithoutDelivery() {
  const snapshot = makeSnapshot();
  delete snapshot.delivery; delete snapshot.preview_sessions;
  return snapshot;
}
