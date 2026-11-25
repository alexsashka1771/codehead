import type { ArtifactContent, ArtifactView, Bug, QualityCycleView, Snapshot, TestReport } from '../../../../packages/contracts';
import { ApiError } from '../app/api';

export type QualityDocument = { kind: 'test_report'; cycle: QualityCycleView; value: TestReport }
  | { kind: 'bug'; cycle: QualityCycleView; value: Bug }
  | { kind: 'tool_report'; cycle: QualityCycleView; value: Record<string, unknown> };
export const qualityContentError = 'Документ QA не соответствует сохранённому циклу, хэшу или источникам. Обновите данные запуска.';
const pinFields = ['run_id', 'task_id', 'candidate_id', 'revision', 'tree_hash', 'manifest_artifact_id',
  'manifest_hash', 'profile_version', 'profile_hash', 'acceptance_suite_hash', 'template_hash'] as const;
export const requirementLabels = {
  'REQ-001': 'Врачи и пациенты', 'REQ-002': 'Запись на приём', 'REQ-003': 'Конкурентный слот', 'REQ-004': 'Перенос записи',
  'REQ-005': 'Отмена приёма', 'REQ-006': 'Состояния интерфейса', 'REQ-007': 'Ошибки API', 'REQ-008': 'Запуск приложения',
};
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function ids(value: unknown): value is string[] { return Array.isArray(value) && value.every(id => typeof id === 'string') && new Set(value).size === value.length; }
function requirements(value: unknown): value is (keyof typeof requirementLabels)[] {
  return ids(value) && value.every(id => Object.hasOwn(requirementLabels, id));
}
function fail(): never { throw new ApiError({ code: 'invalid_quality_document', message: qualityContentError, correlation_id: '', retriable: false }, 409); }
export async function validateQualityArtifactContent(snapshot: Snapshot, artifact: ArtifactView, content: ArtifactContent): Promise<QualityDocument> {
  if (artifact.run_id !== snapshot.run.id || content.artifact_id !== artifact.id || content.content_hash !== artifact.content_hash
    || artifact.media_type !== 'application/json' || typeof content.content !== 'string') fail();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content.content));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== artifact.content_hash) fail();
  let value: unknown;
  try { value = JSON.parse(content.content); } catch { fail(); }
  if (!record(value) || typeof value.cycle_id !== 'string') fail();
  const cycle = snapshot.quality_cycles?.find(item => item.id === value.cycle_id);
  if (!cycle || cycle.run_id !== snapshot.run.id || artifact.task_id !== cycle.task_id || artifact.author_role !== 'qa'
    || !pinFields.every(field => value[field] === cycle[field])) fail();
  const manifest = snapshot.artifacts.find(item => item.id === cycle.manifest_artifact_id);
  if (!manifest || manifest.version !== cycle.revision || manifest.content_hash !== cycle.manifest_hash
    || artifact.input_versions[manifest.id] !== manifest.version) fail();
  for (const [id, version] of Object.entries(artifact.input_versions)) if (snapshot.artifacts.find(a => a.id === id)?.version !== version) fail();
  const tools = cycle.tool_run_ids.map(id => snapshot.tool_runs?.find(tool => tool.id === id));
  if (tools.some(tool => !tool || tool.run_id !== cycle.run_id || tool.qa_cycle_id !== cycle.id
    || tool.workspace_id !== cycle.candidate_id || tool.snapshot_version !== cycle.revision || tool.tree_hash !== cycle.tree_hash
    || tool.manifest_artifact_id !== cycle.manifest_artifact_id || tool.manifest_hash !== cycle.manifest_hash
    || tool.profile_version !== cycle.profile_version || tool.profile_hash !== cycle.profile_hash
    || tool.acceptance_suite_hash !== cycle.acceptance_suite_hash || tool.template_hash !== cycle.template_hash)) fail();
  if (artifact.artifact_type === 'tool_report') {
    const tool = tools.find(item => item?.id === value.tool_run_id);
    if (!cycle.tool_report_artifact_ids?.includes(artifact.id) || !tool || artifact.provenance?.origin !== 'tool'
      || artifact.provenance.producer_id !== tool.id || value.operation_id !== tool.operation_id || value.status !== tool.status
      || value.exit_code !== tool.exit_code || value.error_code !== tool.error_code || value.error_message !== tool.error_message
      || typeof value.diagnostic_excerpt !== 'string' || new TextEncoder().encode(value.diagnostic_excerpt).length > 8192
      || value.full_output_url !== `/api/runs/${snapshot.run.id}/tools`) fail();
    return { kind: 'tool_report', cycle, value };
  }
  const producer = snapshot.agent_runs?.find(attempt => attempt.id === artifact.provenance?.producer_id);
  if (!producer || producer.task_id !== cycle.task_id || producer.run_id !== cycle.run_id
    || snapshot.agents.find(agent => agent.id === producer.agent_id)?.role !== 'qa'
    || !['test', 'llm'].includes(artifact.provenance?.origin ?? '') || value.iteration !== cycle.iteration
    || !ids(value.tool_run_ids)
    || value.tool_run_ids.some(id => !cycle.tool_run_ids.includes(id))) fail();
  if (artifact.artifact_type === 'bug') {
    const bugTools = value.tool_run_ids;
    if (!cycle.bug_artifact_ids?.includes(artifact.id) || value.status !== 'open' || !requirements(value.requirement_ids)
      || !value.requirement_ids.length || typeof value.summary !== 'string' || !value.summary.trim() || Array.from(value.summary).length > 8000
      || bugTools.length !== 1 || tools.find(t => t?.id === bugTools[0])?.operation_id !== 'test_backend') fail();
    return { kind: 'bug', cycle, value: value as unknown as Bug };
  }
  if (artifact.artifact_type !== 'test_report' || cycle.report_artifact_id !== artifact.id
    || value.tool_run_ids.length !== cycle.tool_run_ids.length
    || typeof value.status !== 'string' || !['passed', 'failed'].includes(value.status) || value.status !== cycle.status
    || !Array.isArray(value.requirements) || value.requirements.length !== 8 || !Array.isArray(value.proposed_tests)
    || !ids(value.resolves_bug_ids ?? [])) fail();
  const seen = new Set<string>();
  for (const check of value.requirements) {
    if (!record(check) || typeof check.requirement_id !== 'string' || !Object.hasOwn(requirementLabels, check.requirement_id)
      || seen.has(check.requirement_id) || typeof check.status !== 'string' || !['passed', 'failed', 'not_verified'].includes(check.status)
      || !ids(check.tool_run_ids) || check.tool_run_ids.some(id => !cycle.tool_run_ids.includes(id))) fail();
    seen.add(check.requirement_id);
    const expectedStatus = value.status === 'passed' && !['REQ-006', 'REQ-008'].includes(check.requirement_id)
      ? 'passed' : 'not_verified';
    if (check.status !== expectedStatus) fail();
    const expectedTool = tools.find(tool => tool?.operation_id === (check.requirement_id === 'REQ-006' ? 'build_frontend' : 'test_backend'));
    if (check.tool_run_ids.length !== 1 || check.tool_run_ids[0] !== expectedTool?.id) fail();
    const evidence = tools.filter(tool => tool && (check.tool_run_ids as string[]).includes(tool.id));
    if (check.status === 'passed' && evidence.some(tool => tool?.status !== 'succeeded')) fail();
  }
  for (const proposal of value.proposed_tests) {
    if (!record(proposal) || proposal.status !== 'proposed' || typeof proposal.title !== 'string' || !proposal.title.trim()
      || Array.from(proposal.title).length > 500 || !requirements(proposal.requirement_ids) || !proposal.requirement_ids.length) fail();
  }
  for (const id of value.resolves_bug_ids as string[] | undefined ?? []) {
    const previous = snapshot.quality_cycles?.find(item => item.bug_artifact_ids?.includes(id));
    const bug = snapshot.artifacts.find(item => item.id === id);
    if (value.status !== 'passed' || !previous || previous.iteration >= cycle.iteration || previous.candidate_id !== cycle.candidate_id
      || bug?.artifact_type !== 'bug' || bug.run_id !== cycle.run_id || bug.task_id !== previous.task_id) fail();
  }
  if (value.status === 'passed' && tools.some(tool => tool?.status !== 'succeeded')) fail();
  if (value.status === 'failed' && !tools.some(tool => tool?.status === 'failed')) fail();
  return { kind: 'test_report', cycle, value: value as unknown as TestReport };
}
