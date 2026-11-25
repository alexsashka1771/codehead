import { describe, expect, it } from 'vitest';
import { applyEvent, hydrateSnapshot, normalizeSnapshot } from './projection';
import { makeSnapshot } from './fixtures';
import { makeQualityEvent, makeQualitySnapshot } from './qualityFixtures';

describe('quality cycle projection', () => {
  it('accepts llm-origin QA artifacts with the proper QA attempt producer', () => {
    const snapshot = makeQualitySnapshot(); snapshot.artifacts.find(a => a.artifact_type === 'test_report')!.provenance!.origin = 'llm';
    expect(hydrateSnapshot(snapshot).quality_cycles).toHaveLength(1);
  });
  it('hydrates legacy defaults without inventing QA results', () => {
    const legacy = makeSnapshot(); delete legacy.quality_cycles; delete legacy.run.test_scenario; delete legacy.run.injection_done;
    const result = hydrateSnapshot(legacy);
    expect(result.quality_cycles).toEqual([]); expect(result.run.test_scenario).toBe('standard'); expect(result.run.injection_done).toBe(false);
  });
  it('carries cycles in workflow events and retains older pinned revisions', () => {
    const snapshot = makeQualitySnapshot(2);
    const result = applyEvent(makeQualitySnapshot(), makeQualityEvent(snapshot));
    expect(result.quality_cycles).toEqual(snapshot.quality_cycles);
    expect(normalizeSnapshot(result).quality_cycles).toHaveLength(2);
    expect(hydrateSnapshot(snapshot).quality_cycles![0].revision).toBeLessThan(snapshot.candidate!.revision);
  });
  it.each([
    ['foreign run', (s: ReturnType<typeof makeQualitySnapshot>) => { s.quality_cycles![0].run_id = 'foreign'; }],
    ['foreign task', (s: ReturnType<typeof makeQualitySnapshot>) => { s.quality_cycles![0].task_id = 'missing'; }],
    ['wrong hash', (s: ReturnType<typeof makeQualitySnapshot>) => { s.quality_cycles![0].manifest_hash = '0'.repeat(64); }],
    ['wrong status', (s: ReturnType<typeof makeQualitySnapshot>) => { Object.assign(s.quality_cycles![0], { status: 'invented' }); }],
    ['duplicate iteration', (s: ReturnType<typeof makeQualitySnapshot>) => { s.quality_cycles!.push({ ...s.quality_cycles![0], id: 'another' }); }],
    ['tool cycle', (s: ReturnType<typeof makeQualitySnapshot>) => { s.tool_runs![0].qa_cycle_id = 'other'; }],
    ['duplicate operation', (s: ReturnType<typeof makeQualitySnapshot>) => { s.tool_runs![1].operation_id = s.tool_runs![0].operation_id; }],
    ['agent producer for tool report', (s: ReturnType<typeof makeQualitySnapshot>) => { s.artifacts.find(a => a.artifact_type === 'tool_report')!.provenance!.producer_id = 'attempt-qa-0'; }],
    ['wrong QA producer task', (s: ReturnType<typeof makeQualitySnapshot>) => { s.artifacts.find(a => a.artifact_type === 'test_report')!.provenance!.producer_id = 'attempt-backend'; }],
    ['wrong QA producer agent', (s: ReturnType<typeof makeQualitySnapshot>) => { s.agent_runs!.find(a => a.id === 'attempt-qa-0')!.agent_id = 'agent-backend'; }],
    ['missing report', (s: ReturnType<typeof makeQualitySnapshot>) => { s.quality_cycles![0].report_artifact_id = 'missing'; }],
  ])('rejects %s before exposing a snapshot', (_name, change) => {
    const snapshot = makeQualitySnapshot(); change(snapshot); expect(() => hydrateSnapshot(snapshot)).toThrow();
  });
  it('rejects repair references without the next iteration and dependencies', () => {
    const snapshot = makeQualitySnapshot(2); snapshot.tasks.find(t => t.task_type === 'backend_repair')!.dependencies = [];
    expect(() => hydrateSnapshot(snapshot)).toThrow();
  });
  it('rejects ToolReport metadata without mandatory manifest inputs', () => {
    const snapshot = makeQualitySnapshot();
    snapshot.artifacts.filter(a => a.artifact_type === 'tool_report').forEach(a => { a.input_versions = {}; });
    expect(() => hydrateSnapshot(snapshot)).toThrow();
  });
  it('rejects a failed QA cycle when all three actual tools succeeded', () => {
    const snapshot = makeQualitySnapshot(); snapshot.quality_cycles![0].status = 'failed';
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
  });
  it.each(['exit_code', 'error_code', 'operation_id'] as const)('rejects a failed QA cycle without a known HTTP failure: %s', field => {
    const snapshot = makeQualitySnapshot(2);
    const http = snapshot.tool_runs!.find(tool => tool.qa_cycle_id === 'cycle-0' && tool.operation_id === 'test_backend')!;
    if (field === 'operation_id') snapshot.tool_runs!.find(tool => tool.qa_cycle_id === 'cycle-0' && tool.operation_id === 'validate_backend')!.operation_id = 'test_backend';
    Object.assign(http, field === 'exit_code' ? { exit_code: 2 } : field === 'error_code' ? { error_code: 'runner_unavailable' } : { operation_id: 'validate_backend' });
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
  });
});
