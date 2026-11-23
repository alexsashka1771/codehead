import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent, UsageSummary } from '../../../../packages/contracts';
import { api } from '../app/api';
import { mountHook } from './hookHarness';
import { useImmutableResource } from './useImmutableResource';
import { useRunConnection } from './useRunConnection';
import { makeEvent, makeSnapshot } from './fixtures';
import { makeWorkerSnapshot, makeWorkflowEvent } from './workerFixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

class Socket {
  static latest: Socket;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  constructor(public url: string) { Socket.latest = this; }
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', { location: { href: 'http://localhost/' }, setTimeout, clearTimeout });
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('immutable selection reads', () => {
  it('refreshes trace for the same attempt when its persisted outcome arrives and ignores the earlier partial response', async () => {
    let outcome = 'running';
    const partial = deferred<string>(); const complete = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((_id: string, signal: AbortSignal) => {
      signals.push(signal); return signals.length === 1 ? partial.promise : complete.promise;
    });
    const hook = await mountHook(() => useImmutableResource('attempt-one', read, outcome));
    try {
      outcome = 'succeeded'; await hook.rerender();
      expect(signals[0].aborted).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => { complete.resolve('prompt and final response'); });
      await act(async () => { partial.resolve('prompt without response'); });
      expect(hook.value.data).toBe('prompt and final response');
    } finally { await hook.unmount(); }
  });

  it('aborts changed selections and prevents late content from replacing the current document', async () => {
    let selected: string | null = 'one';
    const first = deferred<string>(); const second = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((id: string, signal: AbortSignal) => {
      signals.push(signal); return id === 'one' ? first.promise : second.promise;
    });
    const hook = await mountHook(() => useImmutableResource(selected, read));
    try {
      expect(hook.value.loading).toBe(true);
      selected = 'two'; await hook.rerender();
      expect(signals[0].aborted).toBe(true);
      expect(hook.value.data).toBeNull();
      await act(async () => { second.resolve('second document'); });
      expect(hook.value.data).toBe('second document');
      await act(async () => { first.resolve('stale first document'); });
      expect(hook.value.data).toBe('second document');
      selected = null; await hook.rerender();
      expect(signals[1].aborted).toBe(true);
      expect(hook.value.data).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
    } finally { await hook.unmount(); }
  });
});

describe('worker stream usage', () => {
  it('opens the websocket before a delayed usage read and never overwrites newer projected usage', async () => {
    const snapshot = makeWorkerSnapshot();
    const first: DomainEvent = { ...makeEvent(), event_type: 'run.created',
      payload: { project: snapshot.project, run: { ...snapshot.run, last_event_seq: 1 }, agents: [] } };
    const lateUsage = deferred<UsageSummary>();
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshot);
    vi.spyOn(api, 'events').mockResolvedValue({ events: [first, makeWorkflowEvent(2)],
      has_more: false, next_after_seq: 2, last_event_seq: 2 });
    vi.spyOn(api, 'usage').mockReturnValue(lateUsage.promise);
    const hook = await mountHook(() => useRunConnection(snapshot.run.id));
    try {
      expect(hook.value.snapshot?.last_event_seq).toBe(2);
      expect(String(Socket.latest.url)).toContain('after_seq=2');
      expect(hook.value.usage?.request_count).toBe(3);
      await act(async () => { Socket.latest.onopen?.(); });
      expect(hook.value.connection).toBe('connected');
      const updated = makeWorkflowEvent(3);
      updated.payload.usage.request_count = 4;
      await act(async () => { Socket.latest.onmessage?.({ data: JSON.stringify(updated) }); });
      expect(hook.value.usage?.request_count).toBe(4);
      await act(async () => { lateUsage.resolve({ ...snapshot.usage!, request_count: 0 }); });
      expect(hook.value.usage?.request_count).toBe(4);
      expect(hook.value.snapshot?.last_event_seq).toBe(3);
    } finally { await hook.unmount(); }
  });

  it('hydrates legacy snapshots and can read their unknown usage independently', async () => {
    const snapshot = makeSnapshot(); delete snapshot.usage;
    vi.spyOn(api, 'snapshot').mockResolvedValue(snapshot);
    vi.spyOn(api, 'events').mockResolvedValue({ events: [], has_more: false, next_after_seq: 0, last_event_seq: 0 });
    vi.spyOn(api, 'usage').mockResolvedValue({ request_count: 0, input_tokens: null, output_tokens: null,
      cost_usd: null, provider: null, model: null, source: 'unconfigured' });
    const hook = await mountHook(() => useRunConnection(snapshot.run.id));
    try {
      expect(hook.value.snapshot?.agent_runs).toEqual([]);
      expect(hook.value.usage?.cost_usd).toBeNull();
      expect(hook.value.usage?.source).toBe('unconfigured');
    } finally { await hook.unmount(); }
  });
});
