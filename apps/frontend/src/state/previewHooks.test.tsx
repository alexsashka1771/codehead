import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSessionView, PreviewView } from '../../../../packages/contracts';
import { api } from '../app/api';
import { mountHook } from './hookHarness';
import { makeAccess, makeDeliverySnapshot, makeReceipt } from './previewFixtures';
import { usePreview } from './usePreview';

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('preview interaction', () => {
  it('never starts or opens preview on reading and remounting', async () => {
    const selected = makeDeliverySnapshot();
    const get = vi.spyOn(api, 'preview').mockImplementation(async () => makeAccess(selected));
    const post = vi.spyOn(api, 'commandPreview');
    const hook = await mountHook(() => usePreview(selected, true));
    try {
      expect(hook.value.canOpen).toBe(true);
      expect(hook.value.openedOrigin).toBeNull();
      await act(async () => { await hook.value.open(); });
      expect(get).toHaveBeenCalledTimes(2);
      expect(hook.value.openedOrigin).toBe('http://127.0.0.1:45670');
    } finally { await hook.unmount(); }
    const reloaded = await mountHook(() => usePreview(selected, true));
    try {
      expect(reloaded.value.canOpen).toBe(true);
      expect(reloaded.value.openedOrigin).toBeNull();
      expect(post).not.toHaveBeenCalled();
    } finally { await reloaded.unmount(); }
  });

  it.each([
    ['stale health', (view: PreviewView) => { view.access.health_checked_at = new Date(Date.now() - 11_000).toISOString(); }],
    ['foreign access', (view: PreviewView) => { view.access.run_id = 'other-run'; }],
    ['foreign package', (view: PreviewView) => { view.access.package_id = 'other-package'; }],
    ['older version', (view: PreviewView) => { view.access.version = 2; }],
    ['wrong session', (view: PreviewView) => { view.access.preview_session_id = 'other-preview'; }],
    ['read for a different package generation', (view: PreviewView) => { view.delivery = { ...view.delivery!, package_generation: 9 }; }],
    ['host alias', (view: PreviewView) => { view.access.origin = 'http://localhost:45670'; }],
    ['credential-bearing address', (view: PreviewView) => { view.access.origin = 'http://name:secret@127.0.0.1:45670'; }],
    ['noncanonical or attacker-influenced path', (view: PreviewView) => { view.access.origin = 'http://127.0.0.1:45670/?query=1'; }],
    ['invalid port', (view: PreviewView) => { view.access.origin = 'http://127.0.0.1:65536'; }],
  ] as const)('never opens an iframe when a fresh recheck returns %s', async (_name, damage) => {
    const snapshot = makeDeliverySnapshot();
    const unsafe = makeAccess(snapshot); damage(unsafe);
    vi.spyOn(api, 'preview').mockResolvedValueOnce(makeAccess(snapshot)).mockResolvedValue(unsafe);
    const hook = await mountHook(() => usePreview(snapshot, true));
    try {
      expect(hook.value.canOpen).toBe(true);
      await act(async () => { await hook.value.open(); });
      expect(hook.value.canOpen).toBe(false);
      expect(hook.value.openedOrigin).toBeNull();
    } finally { await hook.unmount(); }
  });

  it('cancels an open recheck when switching runs and never displays its stale origin', async () => {
    let selected = makeDeliverySnapshot();
    const first = selected;
    let finishRead!: (reply: PreviewView) => void;
    const postponed = new Promise<PreviewView>(resolve => { finishRead = resolve; });
    const get = vi.spyOn(api, 'preview').mockResolvedValueOnce(makeAccess(first)).mockReturnValueOnce(postponed)
      .mockImplementation(async () => makeAccess(selected, 'http://127.0.0.1:45671'));
    const hook = await mountHook(() => usePreview(selected, true));
    try {
      await act(async () => { void hook.value.open(); });
      selected = makeDeliverySnapshot({ runId: 'run-two' }); await hook.rerender();
      expect(get.mock.calls[1][1]?.aborted).toBe(true);
      await act(async () => { finishRead(makeAccess(first)); });
      expect(hook.value.openedOrigin).toBeNull();
      expect(hook.value.canOpen).toBe(true);
      await act(async () => { await hook.value.open(); });
      expect(hook.value.openedOrigin).toBe('http://127.0.0.1:45671');
    } finally { await hook.unmount(); }
  });

  it('rejects the platform origin even if the runtime response otherwise owns the selection', async () => {
    const snapshot = makeDeliverySnapshot();
    const platform = 'http://127.0.0.1:5180';
    vi.stubGlobal('location', new URL(platform));
    vi.spyOn(api, 'preview').mockResolvedValue(makeAccess(snapshot, platform));
    const hook = await mountHook(() => usePreview(snapshot, true));
    try {
      expect(hook.value.canOpen).toBe(false);
      await act(async () => { await hook.value.open(); });
      expect(hook.value.openedOrigin).toBeNull();
    } finally { await hook.unmount(); }
  });

  it('closes on lost or expired access and requires another explicit open when healthy again', async () => {
    const selected = makeDeliverySnapshot();
    const access = makeAccess(selected);
    const unavailable = { ...access, access: { ...access.access, status: 'unavailable' as const, origin: null, reason: 'Worker недоступен.' } };
    const read = vi.spyOn(api, 'preview').mockImplementation(async () => makeAccess(selected));
    let visible = true;
    vi.useFakeTimers();
    const hook = await mountHook(() => usePreview(selected, visible));
    try {
      await act(async () => { await hook.value.open(); });
      expect(hook.value.openedOrigin).toBe('http://127.0.0.1:45670');
      read.mockResolvedValueOnce(unavailable);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(hook.value.accessReason).toContain('Worker недоступен');
      expect(hook.value.openedOrigin).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
      expect(hook.value.canOpen).toBe(true);
      expect(hook.value.openedOrigin).toBeNull();
      await act(async () => { await hook.value.open(); });
      read.mockReturnValue(new Promise(() => {}));
      await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
      expect(hook.value.openedOrigin).toBeNull();
      visible = false; await hook.rerender();
      expect(hook.value.canOpen).toBe(false);
    } finally { await hook.unmount(); vi.useRealTimers(); }
  });

  it('reuses a retry key and waits for a new projected session after the start receipt', async () => {
    const snapshot = makeDeliverySnapshot({ readySession: false });
    vi.spyOn(api, 'preview').mockResolvedValue(makeAccess(snapshot));
    const post = vi.spyOn(api, 'commandPreview').mockRejectedValueOnce(new TypeError('lost receipt'))
      .mockResolvedValue(makeReceipt(snapshot, 'start'));
    const hook = await mountHook(() => usePreview(snapshot, true));
    try {
      expect(hook.value.canStart).toBe(true);
      await act(async () => { await hook.value.command('start'); });
      await act(async () => { await hook.value.command('start'); });
      expect(post.mock.calls[0][1]).toEqual({ command: 'start', package_id: snapshot.delivery!.id, expected_version: 0 });
      expect(post.mock.calls[0][2]).toBe(post.mock.calls[1][2]);
      expect(hook.value.commandPhase).toBe('accepted');
      expect(hook.value.canStart).toBe(false);
      expect(hook.value.openedOrigin).toBeNull();
      await act(async () => { await hook.value.command('start'); });
      expect(post).toHaveBeenCalledTimes(2);
    } finally { await hook.unmount(); }
  });

  it('sends stop with the selected version and drops its receipt when the run switches', async () => {
    let selected = makeDeliverySnapshot();
    const first = selected;
    let finishCommand!: (reply: PreviewSessionView) => void;
    const postponed = new Promise<PreviewSessionView>(resolve => { finishCommand = resolve; });
    vi.spyOn(api, 'preview').mockImplementation(async () => makeAccess(selected));
    const post = vi.spyOn(api, 'commandPreview').mockReturnValueOnce(postponed);
    const hook = await mountHook(() => usePreview(selected, true));
    try {
      await act(async () => { await hook.value.open(); });
      await act(async () => { void hook.value.command('stop'); });
      expect(hook.value.openedOrigin).toBeNull();
      expect(post.mock.calls[0][1]).toEqual({ command: 'stop', package_id: first.delivery!.id,
        expected_version: 3, preview_session_id: first.preview_sessions![0].id });
      selected = makeDeliverySnapshot({ runId: 'run-two', readySession: false }); await hook.rerender();
      await act(async () => { finishCommand(makeReceipt(first, 'stop')); });
      expect(hook.value.commandPhase).toBeNull();
      expect(hook.value.canStart).toBe(true);
      expect(hook.value.openedOrigin).toBeNull();
    } finally { await hook.unmount(); }
  });

  it('ignores a receipt for the wrong package or a rollback in the accepted version', async () => {
    const selected = makeDeliverySnapshot({ readySession: false });
    vi.spyOn(api, 'preview').mockResolvedValue(makeAccess(selected));
    vi.spyOn(api, 'commandPreview').mockResolvedValueOnce({ ...makeReceipt(selected, 'start'), package_id: 'other-package' })
      .mockResolvedValueOnce({ ...makeReceipt(selected, 'start'), version: 0 });
    const hook = await mountHook(() => usePreview(selected, true));
    try {
      await act(async () => { await hook.value.command('start'); });
      expect(hook.value.commandPhase).not.toBe('accepted');
      expect(hook.value.commandError).toContain('Ответ');
      await act(async () => { await hook.value.command('start'); });
      expect(hook.value.commandPhase).not.toBe('accepted');
      expect(hook.value.canStart).toBe(true);
    } finally { await hook.unmount(); }
  });

  it('keeps a pending Stop across a brief disconnect without permitting another mutation', async () => {
    const selected = makeDeliverySnapshot();
    let finishCommand!: (reply: PreviewSessionView) => void;
    const postponed = new Promise<PreviewSessionView>(resolve => { finishCommand = resolve; });
    vi.spyOn(api, 'preview').mockImplementation(async () => makeAccess(selected));
    const post = vi.spyOn(api, 'commandPreview').mockReturnValue(postponed);
    let connected = true;
    const hook = await mountHook(() => usePreview(selected, connected));
    try {
      await act(async () => { await hook.value.open(); });
      await act(async () => { void hook.value.command('stop'); });
      connected = false; await hook.rerender();
      expect(hook.value.canOpen).toBe(false);
      connected = true; await hook.rerender();
      expect(hook.value.canStop).toBe(false);
      await act(async () => { void hook.value.command('stop'); });
      expect(post).toHaveBeenCalledTimes(1);
      await act(async () => { finishCommand(makeReceipt(selected, 'stop')); });
      expect(hook.value.commandPhase).toBe('accepted');
      expect(hook.value.openedOrigin).toBeNull();
    } finally { await hook.unmount(); }
  });

  it('drops an invalid late receipt after the stream already changed the selected version', async () => {
    let selected = makeDeliverySnapshot();
    const first = selected;
    let finishCommand!: (reply: PreviewSessionView) => void;
    const postponed = new Promise<PreviewSessionView>(resolve => { finishCommand = resolve; });
    vi.spyOn(api, 'preview').mockImplementation(async () => makeAccess(selected));
    vi.spyOn(api, 'commandPreview').mockReturnValue(postponed);
    const hook = await mountHook(() => usePreview(selected, true));
    try {
      await act(async () => { void hook.value.command('stop'); });
      selected = structuredClone(selected);
      selected.preview_sessions![0].version = 5;
      selected.preview_sessions![0].status = 'stopped';
      await hook.rerender();
      await act(async () => { finishCommand({ ...makeReceipt(first, 'stop'), run_id: 'other-run' }); });
      expect(hook.value.commandError).toBeNull();
      expect(hook.value.canStart).toBe(true);
    } finally { await hook.unmount(); }
  });
});
