import { act } from 'react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../app/api';
import { mountHook } from './hookHarness';
import { useWorkspace } from './useWorkspace';
import { makeSnapshot } from './fixtures';
import { makeQualitySnapshot, makeTestReport } from './qualityFixtures';
import { useQualityDocument } from './useQualityDocument';
import type { ArtifactContent } from '../../../../packages/contracts';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { location: { href: 'http://localhost/?project=project-one' }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.spyOn(api, 'projects').mockResolvedValue([makeSnapshot().project]);
  vi.spyOn(api, 'capabilities').mockResolvedValue({ roles: [], capabilities: [] });
  vi.spyOn(api, 'runs').mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('QA start intent', () => {
  it('reuses retry keys only for the same project, mode and test scenario', async () => {
    const post = vi.spyOn(api, 'start').mockRejectedValue(new TypeError('lost receipt'));
    const hook = await mountHook(useWorkspace);
    try {
      await act(async () => { await hook.value.start('test', 'repair_success'); });
      await act(async () => { await hook.value.start('test', 'repair_success'); });
      await act(async () => { await hook.value.start('test', 'repair_blocked'); });
      expect(post.mock.calls[0][1]).toBe(post.mock.calls[1][1]);
      expect(post.mock.calls[2][1]).not.toBe(post.mock.calls[1][1]);
      expect(post.mock.calls.map(call => call[3])).toEqual(['repair_success', 'repair_success', 'repair_blocked']);
      await act(async () => { hook.value.selectProject('project-two'); });
      await act(async () => { await hook.value.start('test', 'repair_blocked'); });
      expect(post.mock.calls[3][1]).not.toBe(post.mock.calls[2][1]);
    } finally { await hook.unmount(); }
  });
  it('clears a retry key when a scenario changes before returning to the previous scenario', async () => {
    const post = vi.spyOn(api, 'start').mockRejectedValue(new TypeError('lost receipt'));
    const hook = await mountHook(useWorkspace);
    try {
      await act(async () => { await hook.value.start('test', 'standard'); });
      await act(async () => { hook.value.selectTestScenario('repair_success'); });
      await act(async () => { hook.value.selectTestScenario('standard'); await hook.value.start('test', 'standard'); });
      expect(post.mock.calls[0][1]).not.toBe(post.mock.calls[1][1]);
    } finally { await hook.unmount(); }
  });
});

describe('QA content selection', () => {
  it('reports invalid QA evidence as a document error with a retry path', async () => {
    const snapshot = makeQualitySnapshot(); const artifact = snapshot.artifacts.find(a => a.artifact_type === 'test_report')!;
    vi.spyOn(api, 'artifactContent').mockResolvedValue({ artifact_id: 'foreign', content_hash: artifact.content_hash,
      content: '{}', media_type: 'application/json', byte_size: 2 });
    const hook = await mountHook(() => useQualityDocument(snapshot, artifact));
    try { expect(hook.value.data).toBeNull(); expect(hook.value.error).toContain('Документ QA'); }
    finally { await hook.unmount(); }
  });
  it('aborts a late report when the run changes and exposes only verified selected-run content', async () => {
    const one = makeQualitySnapshot(); const two = makeQualitySnapshot(); two.run.id = 'run-two'; two.candidate!.run_id = two.run.id;
    for (const list of [two.tasks, two.agents, two.artifacts, two.agent_runs!, two.tool_runs!, two.quality_cycles!]) for (const view of list) view.run_id = two.run.id;
    const input = (snapshot: typeof one) => {
      const artifact = snapshot.artifacts.find(a => a.id === snapshot.quality_cycles![0].report_artifact_id)!;
      const content = JSON.stringify(makeTestReport(snapshot.quality_cycles![0])); artifact.content_hash = createHash('sha256').update(content).digest('hex');
      return { artifact, content: { artifact_id: artifact.id, content_hash: artifact.content_hash, media_type: 'application/json', byte_size: Buffer.byteLength(content), content } };
    };
    const first = input(one); const second = input(two); let selected = one;
    let finishFirst!: (content: ArtifactContent) => void; const delayed = new Promise<ArtifactContent>(resolve => { finishFirst = resolve; });
    const signals: AbortSignal[] = [];
    vi.spyOn(api, 'artifactContent').mockImplementation((_id, signal) => { signals.push(signal!); return signals.length === 1 ? delayed : Promise.resolve(second.content); });
    const hook = await mountHook(() => useQualityDocument(selected, selected === one ? first.artifact : second.artifact));
    try {
      selected = two; await hook.rerender(); expect(signals[0].aborted).toBe(true);
      await vi.waitFor(() => expect(hook.value.data?.cycle.run_id).toBe('run-two'));
      await act(async () => { finishFirst(first.content); });
      expect(hook.value.data?.cycle.run_id).toBe('run-two');
    } finally { await hook.unmount(); }
  });
});
