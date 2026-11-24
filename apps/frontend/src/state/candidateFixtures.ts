import type { AgentRunView, ArtifactView, CandidateFileView, CandidateView, Role, Snapshot, WorkflowUpdatedEvent } from '../../../../packages/contracts';
import { makeEvent, makeSnapshot, testTask } from './fixtures';

const createdAt = '2026-11-24T10:00:02.123456Z';
const updatedAt = '2026-11-24T10:00:04.654321Z';
const roles: Role[] = ['product_manager', 'architect', 'cto', 'backend', 'frontend'];

export function makeCandidateSnapshot(status: CandidateView['status'] = 'ready'): Snapshot {
  const snapshot = makeSnapshot();
  snapshot.run = { ...snapshot.run, workflow_version: 'clinic-v2', mode: 'test', status: 'blocked', last_event_seq: 3,
    profile_version: 'clinic_demo/v1', profile_hash: 'a'.repeat(64), acceptance_suite_hash: 'b'.repeat(64),
    template_hash: 'c'.repeat(64),
    blocked_reason: 'QA и DevOps ещё не исполняются worker. Preview недоступен.' };
  snapshot.last_event_seq = 3;
  snapshot.tasks = roles.map((role, index) => ({ ...testTask, id: 'task-' + role, role, status: 'succeeded',
    dependencies: index ? ['task-' + roles[Math.min(index - 1, 2)]] : [],
    active_attempt_id: 'attempt-' + role, attempt: 1, input_versions: {}, created_at: createdAt }));
  snapshot.agents = roles.map(role => ({ id: 'agent-' + role, run_id: snapshot.run.id, role, instructions_version: '2',
    appearance_id: role + '-v1', lifecycle: 'idle', activity: null, location: 'development', current_task_id: null }));
  snapshot.agent_runs = roles.map((role): AgentRunView => ({ id: 'attempt-' + role, run_id: snapshot.run.id,
    task_id: 'task-' + role, agent_id: 'agent-' + role, number: 1, fencing_token: 1, status: 'succeeded',
    provider: 'test', model: 'clinic-fixture-v2', input_versions: {}, parameters: {}, created_at: createdAt,
    started_at: createdAt, finished_at: updatedAt, provider_request_id: 'test-request-' + role, stop_reason: 'stop',
    input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 10, error_code: null, error_message: null,
    retry_of_attempt_id: null, decision_id: null, trace_available: true }));
  const document = (id: string, artifactType: string, role: Role): ArtifactView => ({ id, run_id: snapshot.run.id,
    task_id: 'task-' + role, artifact_type: artifactType, version: 1, content_hash: 'd'.repeat(64),
    relative_path: 'docs/' + artifactType + '.md', author_role: role, input_versions: {}, created_at: createdAt,
    provenance: { origin: 'test', producer_id: 'attempt-' + role, parent_artifact_id: null },
    media_type: 'text/markdown', byte_size: 25 });
  snapshot.artifacts = [document('requirements-one', 'requirements', 'product_manager'),
    document('architecture-one', 'architecture', 'architect'), document('contract-one', 'api_contract', 'architect'),
    document('review-one', 'decision', 'cto')];
  const files: CandidateFileView[] = [];
  const inputs = { 'requirements-one': 1, 'architecture-one': 1, 'contract-one': 1, 'review-one': 1 };
  const paths = ['backend/clinic_api.py', 'backend/clinic_storage.py', 'backend/clinic_models.py',
    'frontend/src/App.tsx', 'frontend/src/api.ts', 'frontend/src/styles.css'];
  paths.forEach((relativePath, index) => {
    const role: Role = relativePath.startsWith('backend/') ? 'backend' : 'frontend';
    const parentId = 'template-file-' + index;
    const artifactId = 'source-file-' + index;
    const parentHash = String(index + 1).repeat(64);
    const contentHash = String(index + 3).repeat(64);
    const mediaType = relativePath.endsWith('.py') ? 'text/x-python' : relativePath.endsWith('.css') ? 'text/css' : 'text/plain';
    const parent: ArtifactView = { id: parentId, run_id: snapshot.run.id, task_id: null, artifact_type: 'source_code',
      version: 1, content_hash: parentHash, relative_path: relativePath, author_role: null, input_versions: {},
      created_at: createdAt, provenance: { origin: 'template', producer_id: null, parent_artifact_id: null },
      media_type: mediaType, byte_size: 0 };
    snapshot.artifacts.push(parent, { ...parent, id: artifactId, task_id: 'task-' + role, version: 2,
      content_hash: contentHash, author_role: role, input_versions: inputs, byte_size: 120 + index,
      created_at: updatedAt, provenance: { origin: 'test', producer_id: 'attempt-' + role, parent_artifact_id: parentId } });
    files.push({ relative_path: relativePath, artifact_id: artifactId, version: 2, content_hash: contentHash,
      media_type: mediaType, byte_size: 120 + index, origin: 'test_injected', source: 'test', producer_id: 'attempt-' + role,
      producer_role: role, parent_artifact_id: parentId, parent_hash: parentHash, input_versions: inputs,
      normalization_version: 'utf8-lf-v1' });
  });
  const template: ArtifactView = { id: 'template-package', run_id: snapshot.run.id, task_id: null,
    artifact_type: 'source_code', version: 1, content_hash: 'c'.repeat(64), relative_path: 'frontend/package.json',
    author_role: null, input_versions: {}, created_at: createdAt,
    provenance: { origin: 'template', producer_id: null, parent_artifact_id: null }, media_type: 'application/json', byte_size: 90 };
  snapshot.artifacts.push(template);
  files.push({ relative_path: template.relative_path, artifact_id: template.id, version: template.version,
    content_hash: template.content_hash, media_type: template.media_type!, byte_size: template.byte_size!,
    origin: 'template', source: 'template', producer_id: null, producer_role: null, parent_artifact_id: null,
    parent_hash: null, input_versions: {}, normalization_version: 'utf8-lf-v1' });
  const manifest: ArtifactView = { id: 'manifest-three', run_id: snapshot.run.id, task_id: 'task-frontend',
    artifact_type: 'candidate_manifest', version: 3, content_hash: 'e'.repeat(64), relative_path: 'candidate/manifest-v3.json',
    author_role: 'frontend', input_versions: inputs, created_at: updatedAt,
    provenance: { origin: 'test', producer_id: 'attempt-frontend', parent_artifact_id: null },
    media_type: 'application/json', byte_size: 4020 };
  snapshot.artifacts.push(manifest);
  snapshot.candidate = { id: 'candidate-one', run_id: snapshot.run.id, revision: 3, status,
    profile_version: snapshot.run.profile_version!, profile_hash: snapshot.run.profile_hash!,
    acceptance_suite_hash: snapshot.run.acceptance_suite_hash!, template_hash: 'c'.repeat(64), tree_hash: 'f'.repeat(64),
    manifest_artifact_id: manifest.id, manifest_hash: manifest.content_hash, manifest_byte_size: manifest.byte_size,
    files, created_at: createdAt, updated_at: updatedAt, workspace_path: '.data/candidates/candidate-one/v3',
    blocked_reason: status === 'conflict' ? 'Основа frontend/src/App.tsx изменилась.'
      : status === 'blocked' ? 'Файл workspace не соответствует сохранённому хэшу.' : null };
  snapshot.usage = { request_count: 5, input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: 'test',
    model: 'clinic-fixture-v2', source: 'test', cached_tokens: 0, latency_ms: 50 };
  return snapshot;
}

export function makeCandidateEvent(seq = 3, status: CandidateView['status'] = 'ready'): WorkflowUpdatedEvent {
  const snapshot = makeCandidateSnapshot(status);
  return { ...makeEvent(seq), event_type: 'workflow.updated', payload: { action: 'candidate.materialized',
    run: { ...snapshot.run, last_event_seq: seq }, tasks: snapshot.tasks, agents: snapshot.agents,
    artifacts: snapshot.artifacts, agent_runs: snapshot.agent_runs!, decisions: [], usage: snapshot.usage!, candidate: snapshot.candidate } };
}
