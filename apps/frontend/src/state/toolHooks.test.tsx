import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../app/api';
import { mountHook } from './hookHarness';
import { useWorkspace } from './useWorkspace';
import { makeToolSnapshot } from './toolFixtures';
import type { ToolCommand, ToolRunView } from '../../../../packages/contracts';

const snapshot = makeToolSnapshot('created');
const command: ToolCommand = { operation_id: 'validate_backend', workspace_id: snapshot.candidate!.id, snapshot_version: 3 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { location: { href: 'http://localhost/?project=project-one&run=run-one' }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.spyOn(api, 'projects').mockResolvedValue([snapshot.project]);
  vi.spyOn(api, 'capabilities').mockResolvedValue({ roles: [], capabilities: [] });
  vi.spyOn(api, 'runs').mockResolvedValue([snapshot.run]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Runner command intent', () => {
  it('keeps an accepted command guarded after its receipt and before its event without inserting a ToolRun into the snapshot', async () => {
    const initial = { ...snapshot, tool_runs: [] };
    const before = structuredClone(initial);
    const hook = await mountHook(useWorkspace);
    try {
      const post = vi.spyOn(api, 'queueTool').mockResolvedValue(snapshot.tool_runs![0]);
      await act(async () => { expect(await hook.value.queueTool(initial, command)).toBe(true); });
      expect(hook.value.pending).toBeNull();
      await act(async () => { expect(await hook.value.queueTool(initial, command)).toBe(false); });
      expect(post).toHaveBeenCalledTimes(1);
      expect(hook.value.acceptedTools).toHaveLength(1);
      expect(initial).toEqual(before); expect(hook.value.run).toEqual(snapshot.run);
    } finally { await hook.unmount(); }
  });
  it('retains guards for different accepted operations until each actual ToolRun is observed', async () => {
    const initial = { ...snapshot, tool_runs: [] };
    const hook = await mountHook(useWorkspace);
    try {
      const http: ToolCommand = { ...command, operation_id: 'test_backend' };
      const httpReceipt: ToolRunView = { ...snapshot.tool_runs![0], id: 'tool-http', operation_id: 'test_backend' };
      const post = vi.spyOn(api, 'queueTool').mockResolvedValueOnce(snapshot.tool_runs![0]).mockResolvedValueOnce(httpReceipt);
      await act(async () => { await hook.value.queueTool(initial, command); });
      await act(async () => { await hook.value.queueTool(initial, http); });
      await act(async () => { expect(await hook.value.queueTool(initial, command)).toBe(false); });
      expect(post).toHaveBeenCalledTimes(2);
      expect(hook.value.acceptedTools).toHaveLength(2);
      expect(hook.value).toHaveProperty('observeToolSnapshot');
      const observed = { ...initial, tool_runs: [{ ...snapshot.tool_runs![0], status: 'succeeded' as const }] };
      await act(async () => { hook.value.observeToolSnapshot(observed); });
      expect(hook.value.acceptedTools).toHaveLength(1);
      post.mockResolvedValueOnce({ ...snapshot.tool_runs![0], id: 'tool-second-python' });
      await act(async () => { expect(await hook.value.queueTool(observed, command)).toBe(true); });
      await act(async () => { expect(await hook.value.queueTool(observed, http)).toBe(false); });
      expect(post).toHaveBeenCalledTimes(3);
    } finally { await hook.unmount(); }
  });
  it('scopes accepted guards to a run and candidate revision while retaining the old scope across selection changes', async () => {
    const initial = { ...snapshot, tool_runs: [] };
    const hook = await mountHook(useWorkspace);
    try {
      const other = { ...initial, run: { ...initial.run, id: 'other-run' }, candidate: { ...initial.candidate!, run_id: 'other-run' } };
      const advanced = { ...initial, candidate: { ...initial.candidate!, revision: 4 } };
      const post = vi.spyOn(api, 'queueTool').mockResolvedValueOnce(snapshot.tool_runs![0])
        .mockResolvedValueOnce({ ...snapshot.tool_runs![0], id: 'tool-other-run', run_id: 'other-run' })
        .mockResolvedValueOnce({ ...snapshot.tool_runs![0], id: 'tool-v4', snapshot_version: 4 });
      await act(async () => { await hook.value.queueTool(initial, command); hook.value.selectRun('other-run'); });
      await act(async () => { expect(await hook.value.queueTool(other, command)).toBe(true); hook.value.selectRun('run-one'); });
      await act(async () => { expect(await hook.value.queueTool(advanced, { ...command, snapshot_version: 4 })).toBe(true); });
      await act(async () => { expect(await hook.value.queueTool(initial, command)).toBe(false); });
      expect(post).toHaveBeenCalledTimes(3); expect(hook.value.acceptedTools).toHaveLength(3);
    } finally { await hook.unmount(); }
  });
  it('does not reserve an accepted guard for an invalid receipt and allows a valid response on retry', async () => {
    const initial = { ...snapshot, tool_runs: [] };
    const hook = await mountHook(useWorkspace);
    try {
      const post = vi.spyOn(api, 'queueTool').mockResolvedValueOnce({ ...snapshot.tool_runs![0], run_id: 'foreign-run' })
        .mockResolvedValueOnce(snapshot.tool_runs![0]);
      await act(async () => { expect(await hook.value.queueTool(initial, command)).toBe(false); });
      expect(hook.value.acceptedTools).toEqual([]);
      await act(async () => { expect(await hook.value.queueTool(initial, command)).toBe(true); });
      expect(post).toHaveBeenCalledTimes(2); expect(hook.value.acceptedTools).toHaveLength(1);
    } finally { await hook.unmount(); }
  });
  it('blocks synchronous duplicate clicks without replacing saved run state with a queued receipt', async () => {
    const hook = await mountHook(useWorkspace);
    try {
      expect(hook.value).toHaveProperty('queueTool');
      const receipt = deferred<ToolRunView>(); const post = vi.spyOn(api, 'queueTool').mockReturnValue(receipt.promise);
      let first!: Promise<boolean>; let second!: Promise<boolean>;
      await act(async () => { first = hook.value.queueTool(snapshot, command); second = hook.value.queueTool(snapshot, command); });
      expect(post).toHaveBeenCalledTimes(1); await expect(second).resolves.toBe(false);
      await act(async () => { receipt.resolve(snapshot.tool_runs![0]); await first; });
      expect(hook.value.run).toEqual(snapshot.run);
    } finally { await hook.unmount(); }
  });
  it('retains retry idempotency and ignores late answers after selecting another run', async () => {
    const hook = await mountHook(useWorkspace);
    try {
      expect(hook.value).toHaveProperty('queueTool');
      const receipt = deferred<ToolRunView>();
      const post = vi.spyOn(api, 'queueTool').mockRejectedValueOnce(new ApiError({ code: 'offline', message: 'Retry me', retriable: true, correlation_id: '' }, 503)).mockReturnValueOnce(receipt.promise);
      await act(async () => { await hook.value.queueTool(snapshot, command); });
      let result!: Promise<boolean>;
      await act(async () => { result = hook.value.queueTool(snapshot, command); });
      expect(post.mock.calls[0][2]).toBe(post.mock.calls[1][2]);
      await act(async () => { hook.value.selectRun('other-run'); });
      await act(async () => { receipt.resolve(snapshot.tool_runs![0]); });
      await expect(result).resolves.toBe(false); expect(hook.value.actionError).toBeNull();
    } finally { await hook.unmount(); }
  });
  it('rejects a foreign candidate and a stale revision before issuing a POST', async () => {
    const hook = await mountHook(useWorkspace);
    try {
      expect(hook.value).toHaveProperty('queueTool'); const post = vi.spyOn(api, 'queueTool');
      await expect(hook.value.queueTool(snapshot, { ...command, workspace_id: 'foreign' })).resolves.toBe(false);
      await expect(hook.value.queueTool(snapshot, { ...command, snapshot_version: 2 })).resolves.toBe(false);
      expect(post).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
  });
  it('ignores a receipt when the current candidate advances while the POST is pending', async () => {
    const hook = await mountHook(useWorkspace);
    try {
      const receipt = deferred<ToolRunView>(); vi.spyOn(api, 'queueTool').mockReturnValue(receipt.promise);
      let current = snapshot; let result!: Promise<boolean>;
      await act(async () => { result = hook.value.queueTool(snapshot, command, () => current); });
      current = { ...snapshot, candidate: { ...snapshot.candidate!, revision: 4 } };
      await act(async () => { receipt.resolve(snapshot.tool_runs![0]); });
      await expect(result).resolves.toBe(false);
    } finally { await hook.unmount(); }
  });
  it('rejects a foreign receipt without adopting its saved state', async () => {
    const hook = await mountHook(useWorkspace);
    try {
      vi.spyOn(api, 'queueTool').mockResolvedValue({ ...snapshot.tool_runs![0], run_id: 'foreign-run' });
      await act(async () => { expect(await hook.value.queueTool(snapshot, command)).toBe(false); });
      expect(hook.value.actionError).toContain('не соответствует'); expect(hook.value.run).toEqual(snapshot.run);
    } finally { await hook.unmount(); }
  });
});
