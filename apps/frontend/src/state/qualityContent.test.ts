import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ArtifactContent, ArtifactView, Snapshot } from '../../../../packages/contracts';
import { makeBug, makeQualitySnapshot, makeTestReport } from './qualityFixtures';
import { validateQualityArtifactContent } from './qualityContent';

function document(snapshot: Snapshot, value: unknown, type = 'test_report', iteration = 0) {
  const cycle = snapshot.quality_cycles![iteration];
  const artifact = snapshot.artifacts.find(a => a.id === (type === 'test_report' ? cycle.report_artifact_id : cycle.bug_artifact_ids![0]))!;
  const text = JSON.stringify(value); artifact.content_hash = createHash('sha256').update(text).digest('hex');
  return { artifact, content: { artifact_id: artifact.id, content_hash: artifact.content_hash, content: text } as ArtifactContent };
}
describe('immutable QA JSON evidence', () => {
  it('accepts the 500-character proposal title contract boundary', async () => {
    const snapshot = makeQualitySnapshot(); const report = makeTestReport(snapshot.quality_cycles![0]); report.proposed_tests[0].title = 'x'.repeat(500);
    const input = document(snapshot, report);
    expect((await validateQualityArtifactContent(snapshot, input.artifact, input.content)).kind).toBe('test_report');
  });
  it.each([500, 501])('checks the Unicode proposal title boundary by code points: %i', async length => {
    const snapshot = makeQualitySnapshot(); const report = makeTestReport(snapshot.quality_cycles![0]);
    report.proposed_tests[0].title = '😀'.repeat(length);
    const input = document(snapshot, report); const result = validateQualityArtifactContent(snapshot, input.artifact, input.content);
    if (length === 500) expect((await result).kind).toBe('test_report'); else await expect(result).rejects.toThrow();
  });
  it.each([8000, 8001])('checks the Unicode Bug summary boundary by code points: %i', async length => {
    const snapshot = makeQualitySnapshot(2); const bug = makeBug(snapshot.quality_cycles![0]); bug.summary = '😀'.repeat(length);
    const input = document(snapshot, bug, 'bug'); const result = validateQualityArtifactContent(snapshot, input.artifact, input.content);
    if (length === 8000) expect((await result).kind).toBe('bug'); else await expect(result).rejects.toThrow();
  });
  it('accepts contract llm provenance and an 8000-character Bug summary', async () => {
    const snapshot = makeQualitySnapshot(2); const bug = makeBug(snapshot.quality_cycles![0]); bug.summary = 'x'.repeat(8000);
    const input = document(snapshot, bug, 'bug'); input.artifact.provenance!.origin = 'llm';
    expect((await validateQualityArtifactContent(snapshot, input.artifact, input.content)).kind).toBe('bug');
  });
  it('validates real content hashes and retains not_verified requirements and proposed tests', async () => {
    const snapshot = makeQualitySnapshot(); const input = document(snapshot, makeTestReport(snapshot.quality_cycles![0]));
    const result = await validateQualityArtifactContent(snapshot, input.artifact, input.content);
    expect(result.kind).toBe('test_report');
    if (result.kind === 'test_report') {
      expect(result.value.requirements[5].status).toBe('not_verified'); expect(result.value.proposed_tests[0].status).toBe('proposed');
    }
  });
  it('accepts backend not_verified evidence references while never treating a build as UI verification', async () => {
    const snapshot = makeQualitySnapshot(); const report = makeTestReport(snapshot.quality_cycles![0]);
    report.requirements[5].tool_run_ids = [report.tool_run_ids[2]]; report.requirements[7].tool_run_ids = [report.tool_run_ids[1]];
    const input = document(snapshot, report);
    expect((await validateQualityArtifactContent(snapshot, input.artifact, input.content)).kind).toBe('test_report');
  });
  it('accepts historical reports and Bug without comparing them to the latest candidate revision', async () => {
    const snapshot = makeQualitySnapshot(2); const cycle = snapshot.quality_cycles![0];
    const input = document(snapshot, makeTestReport(cycle));
    expect((await validateQualityArtifactContent(snapshot, input.artifact, input.content)).cycle.revision).toBe(3);
    const bug = document(snapshot, makeBug(cycle), 'bug');
    expect((await validateQualityArtifactContent(snapshot, bug.artifact, bug.content)).kind).toBe('bug');
  });
  it('rejects an individual requirement failure inferred from an aggregate HTTP failure', async () => {
    const snapshot = makeQualitySnapshot(2); const report = makeTestReport(snapshot.quality_cycles![0]);
    report.requirements[2].status = 'failed';
    const input = document(snapshot, report);
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow('Документ QA');
  });
  it('rejects a not_verified HTTP requirement when the pinned suite passed', async () => {
    const snapshot = makeQualitySnapshot(); const report = makeTestReport(snapshot.quality_cycles![0]);
    report.requirements[2].status = 'not_verified';
    const input = document(snapshot, report);
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow('Документ QA');
  });
  it.each(['run_id', 'task_id', 'candidate_id', 'revision', 'tree_hash', 'manifest_hash', 'profile_hash', 'cycle_id'])('rejects changed %s pins even with a valid content digest', async field => {
    const snapshot = makeQualitySnapshot(); const report = { ...makeTestReport(snapshot.quality_cycles![0]), [field]: 'foreign' };
    const input = document(snapshot, report);
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow('Документ QA');
  });
  it.each([
    ['UI green from build', (report: ReturnType<typeof makeTestReport>) => { report.requirements[5].status = 'passed'; report.requirements[5].tool_run_ids = [report.tool_run_ids[2]]; }],
    ['preview green', (report: ReturnType<typeof makeTestReport>) => { report.requirements[7].status = 'passed'; }],
    ['missing requirements', (report: ReturnType<typeof makeTestReport>) => { report.requirements.pop(); }],
    ['foreign tool', (report: ReturnType<typeof makeTestReport>) => { report.requirements[0].tool_run_ids = ['foreign']; }],
    ['proposals executed', (report: ReturnType<typeof makeTestReport>) => { Object.assign(report.proposed_tests[0], { status: 'passed' }); }],
    ['foreign resolved bug', (report: ReturnType<typeof makeTestReport>) => { report.resolves_bug_ids = ['foreign']; }],
  ])('rejects %s', async (_label, change) => {
    const snapshot = makeQualitySnapshot(); const report = makeTestReport(snapshot.quality_cycles![0]); change(report);
    const input = document(snapshot, report);
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow();
  });
  it('rejects forged content and response identities before rendering JSON', async () => {
    const snapshot = makeQualitySnapshot(); const input = document(snapshot, makeTestReport(snapshot.quality_cycles![0]));
    await expect(validateQualityArtifactContent(snapshot, input.artifact, { ...input.content, content: input.content.content + ' ' })).rejects.toThrow();
    await expect(validateQualityArtifactContent(snapshot, input.artifact, { ...input.content, artifact_id: 'foreign' })).rejects.toThrow();
  });
  it('rejects a QA artifact carrying a developer attempt as producer', async () => {
    const snapshot = makeQualitySnapshot(); const input = document(snapshot, makeTestReport(snapshot.quality_cycles![0]));
    input.artifact.provenance!.producer_id = 'attempt-backend';
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow();
  });
  it('rejects a QA producer whose attempt refers to a developer agent', async () => {
    const snapshot = makeQualitySnapshot(); const input = document(snapshot, makeTestReport(snapshot.quality_cycles![0]));
    snapshot.agent_runs!.find(a => a.id === input.artifact.provenance!.producer_id)!.agent_id = 'agent-backend';
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow();
  });
  it('rejects a non-string requirement status even when its string conversion is passed', async () => {
    const snapshot = makeQualitySnapshot(); const report = makeTestReport(snapshot.quality_cycles![0]);
    Object.assign(report.requirements[0], { status: ['passed'] });
    const input = document(snapshot, report);
    await expect(validateQualityArtifactContent(snapshot, input.artifact, input.content)).rejects.toThrow();
  });
  it('rejects ToolReport content with empty mandatory manifest inputs', async () => {
    const snapshot = makeQualitySnapshot(); const cycle = snapshot.quality_cycles![0]; const tool = snapshot.tool_runs![0];
    const artifact = snapshot.artifacts.find(a => a.id === cycle.tool_report_artifact_ids![0])!;
    const content = JSON.stringify({ ...cycle, cycle_id: cycle.id, tool_run_id: tool.id, operation_id: tool.operation_id,
      status: tool.status, exit_code: tool.exit_code, error_code: tool.error_code, error_message: tool.error_message,
      diagnostic_excerpt: '<script>compile completed</script>', full_output_url: `/api/runs/${snapshot.run.id}/tools` });
    artifact.input_versions = {}; artifact.content_hash = createHash('sha256').update(content).digest('hex');
    await expect(validateQualityArtifactContent(snapshot, artifact, { artifact_id: artifact.id, content_hash: artifact.content_hash,
      media_type: 'application/json', byte_size: Buffer.byteLength(content), content })).rejects.toThrow();
  });
});
