import { useCallback, useEffect, useState } from 'react';
import type { DomainEvent, Snapshot, UsageSummary } from '../../../../packages/contracts';
import { api, errorMessage } from '../app/api';
import { applyEvent, hydrateSnapshot, ProjectionError } from './projection';

export type Connection = 'idle' | 'loading' | 'connecting' | 'connected' | 'reconnecting' | 'error';
interface RunState {
  runId: string | null; snapshot: Snapshot | null; events: DomainEvent[];
  usage: UsageSummary | null; connection: Connection; error: string | null;
}

function emptyState(runId: string | null): RunState {
  return { runId, snapshot: null, events: [], usage: null, connection: runId ? 'loading' : 'idle', error: null };
}

export function useRunConnection(runId: string | null) {
  const [state, setState] = useState<RunState>(() => emptyState(runId));
  const [revision, setRevision] = useState(0);
  const reconnect = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!runId) { setState(emptyState(null)); return; }
    const selectedRunId = runId;
    const controller = new AbortController();
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let current: Snapshot | null = null;
    let journal = new Map<number, DomainEvent>();
    let attempt = 0;
    let syncing = false;
    let synchronization = 0;
    let authoritativeUsage = false;
    const active = () => !controller.signal.aborted;
    const publish = (patch: Partial<RunState>) => {
      if (active()) setState((previous) => ({ ...previous, ...patch, runId: selectedRunId }));
    };
    setState((previous) => previous.runId === selectedRunId
      ? { ...previous, connection: previous.snapshot ? 'reconnecting' : 'loading', error: null }
      : emptyState(selectedRunId));

    function closeSocket() {
      if (!socket) return;
      socket.onclose = null; socket.onmessage = null; socket.onerror = null; socket.onopen = null;
      socket.close(); socket = null;
    }

    function retry(cause?: unknown) {
      if (!active()) return;
      closeSocket();
      if (cause instanceof ProjectionError && ['unsupported_schema', 'unsupported_event'].includes(cause.code)) {
        publish({ connection: 'error', error: 'Версия событий сервера не поддерживается. Обновите страницу после обновления приложения.' });
        return;
      }
      publish({ connection: 'reconnecting', error: cause ? errorMessage(cause) : 'Соединение прервано. Восстанавливаем состояние из журнала.' });
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void synchronize(), Math.min(1_000 * 2 ** attempt++, 10_000));
    }

    function connect() {
      if (!active() || !current) return;
      const url = new URL(`/api/runs/${encodeURIComponent(selectedRunId)}/stream`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('after_seq', String(current.last_event_seq));
      socket = new WebSocket(url);
      socket.onopen = () => { attempt = 0; publish({ connection: 'connected', error: null }); };
      socket.onclose = () => retry();
      socket.onerror = () => socket?.close();
      socket.onmessage = ({ data }) => {
        if (!active() || !current) return;
        try {
          const event = JSON.parse(String(data)) as DomainEvent;
          const previousSeq = current.last_event_seq;
          current = applyEvent(current, event);
          if (event.seq > previousSeq && (event.event_type === 'workflow.updated'
            || (event.event_type === 'run.created' && event.payload.usage !== undefined))) authoritativeUsage = true;
          journal.set(event.seq, event);
          publish({ snapshot: current, events: [...journal.values()].sort((a, b) => a.seq - b.seq),
            ...(authoritativeUsage ? { usage: current.usage ?? null } : {}) });
        } catch (cause) { retry(cause); }
      };
    }

    async function synchronize() {
      if (!active() || syncing) return;
      syncing = true;
      const currentSynchronization = ++synchronization;
      closeSocket();
      publish({ connection: current ? 'reconnecting' : 'loading' });
      try {
        const received = await api.snapshot(selectedRunId, controller.signal);
        authoritativeUsage = received.usage !== undefined;
        let next = hydrateSnapshot(received);
        if (next.run.id !== selectedRunId) throw new ProjectionError('foreign_run');
        if (next.last_event_seq !== next.run.last_event_seq) throw new ProjectionError('event_gap');
        const nextJournal = new Map<number, DomainEvent>();
        let after = 0;
        let hasMore = true;
        while (hasMore && active()) {
          const page = await api.events(selectedRunId, after, controller.signal);
          for (const event of page.events) {
            if (event.seq !== after + 1) throw new ProjectionError('event_gap');
            const previousSeq = next.last_event_seq;
            next = applyEvent(next, event);
            if (event.seq > previousSeq && (event.event_type === 'workflow.updated'
              || (event.event_type === 'run.created' && event.payload.usage !== undefined))) authoritativeUsage = true;
            nextJournal.set(event.seq, event);
            after = event.seq;
          }
          if (page.has_more && page.next_after_seq <= after && page.events.length === 0) throw new ProjectionError('event_gap');
          hasMore = page.has_more;
        }
        if (!active()) return;
        current = next;
        journal = nextJournal;
        publish({ snapshot: next, events: [...journal.values()], usage: next.usage ?? null, connection: 'connecting', error: null });
        connect();
        void api.usage(selectedRunId, controller.signal)
          .catch(() => null)
          .then((usage) => { if (synchronization === currentSynchronization && !authoritativeUsage) publish({ usage }); });
      } catch (cause) { retry(cause); }
      finally { syncing = false; }
    }

    void synchronize();
    return () => {
      controller.abort();
      window.clearTimeout(retryTimer);
      closeSocket();
    };
  }, [runId, revision]);

  return { ...(state.runId === runId ? state : emptyState(runId)), reconnect };
}
