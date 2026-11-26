import { useEffect, useRef, useState } from 'react';
import type { DeliveryView, PreviewCommand, PreviewSessionView, PreviewView, Snapshot } from '../../../../packages/contracts';
import { api, ApiError, errorMessage } from '../app/api';
import { latestPreview, ownsPreview } from './deliveryProjection';

const pollIntervalMs = 2_500;
const healthLifetimeMs = 10_000;
const staleAccess = 'Доступ к preview не подтверждён для выбранной сессии.';
const expiredAccess = 'Проверка доступности preview устарела.';
const canStopSession = (session: PreviewSessionView | null) => session != null && ['created', 'starting', 'ready'].includes(session.status);
const canStartSession = (session: PreviewSessionView | null) => session == null || session.status === 'stopped' || session.status === 'failed';

interface Target { packageKey: string; accessKey: string; delivery: DeliveryView; session: PreviewSessionView | null }
interface Grant { origin: string; expiresAt: number }
interface AccessResult { grant: Grant | null; reason: string | null; ahead: boolean }
interface ReadState extends AccessResult { key: string; checking: boolean }
interface Reader { key: string; refresh: (open?: boolean) => Promise<void>; close: () => void }
interface CommandState {
  key: string;
  pending: boolean;
  receipt: PreviewSessionView | null;
  error: string | null;
}
interface CommandScope { key: string; inFlight: boolean; receipt: PreviewSessionView | null; intent: { fingerprint: string; key: string } | null }

function selectTarget(snapshot: Snapshot | null): Target | null {
  const delivery = snapshot?.delivery;
  if (!delivery || snapshot.run.id !== delivery.run_id || snapshot.run.mode !== 'test'
    || snapshot.run.workflow_version !== 'clinic-v4' || snapshot.run.status !== 'succeeded' || delivery.status !== 'ready'
    || !delivery.package_tree_hash || !Number.isSafeInteger(delivery.package_generation) || delivery.package_generation < 1) return null;
  const session = latestPreview(snapshot.preview_sessions);
  if (session && !ownsPreview(session, delivery)) return null;
  const packageKey = JSON.stringify([snapshot.run.id, delivery.id, delivery.package_generation, delivery.package_tree_hash]);
  const accessKey = JSON.stringify([packageKey, session?.id, session?.version, session?.status]);
  return { packageKey, accessKey, delivery, session };
}

function authorizeAccess(target: Target, view: PreviewView): AccessResult {
  const unavailable = (reason: string, ahead = false): AccessResult => ({ grant: null, reason, ahead });
  const { delivery, session } = target;
  const expected = view.delivery;
  const access = view.access;
  if (view.run_id !== delivery.run_id || access?.run_id !== delivery.run_id || expected?.run_id !== delivery.run_id
    || expected.id !== delivery.id || expected.package_generation !== delivery.package_generation
    || expected.package_tree_hash !== delivery.package_tree_hash || expected.status !== 'ready'
    || access.package_id !== delivery.id) return unavailable(staleAccess);
  const received = latestPreview(view.preview_sessions);
  if (received && !ownsPreview(received, delivery)) return unavailable(staleAccess);
  if (received?.id !== session?.id || received?.version !== session?.version || received?.status !== session?.status
    || (access.preview_session_id ?? null) !== (session?.id ?? null) || (access.version ?? null) !== (session?.version ?? null)) {
    return unavailable(staleAccess, (received?.version ?? 0) > (session?.version ?? 0));
  }
  if (access.status === 'unavailable' && access.origin == null) return unavailable(access.reason || staleAccess);
  const origin = access.origin;
  const address = typeof origin === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin) : null;
  if (access.status !== 'available' || session?.status !== 'ready' || access.reason != null || !origin || !address
    || Number(address[1]) > 65_535 || new URL(origin).origin !== origin || origin === globalThis.location?.origin) return unavailable(staleAccess);
  const checkedAt = Date.parse(access.health_checked_at ?? '');
  const now = Date.now();
  const expiresAt = checkedAt + healthLifetimeMs;
  if (!Number.isFinite(checkedAt) || checkedAt > now || expiresAt <= now) return unavailable(expiredAccess);
  return { grant: { origin, expiresAt }, reason: null, ahead: false };
}

function awaitsSnapshot(receipt: PreviewSessionView | null, target: Target) {
  return receipt != null && (target.session?.version ?? 0) < receipt.version;
}

function sameReceipt(target: Target, receipt: PreviewSessionView, input: PreviewCommand) {
  if (!ownsPreview(receipt, target.delivery) || !receipt.id || !receipt.start_tool_run_id
    || receipt.version !== input.expected_version + 1) return false;
  return input.command === 'start' ? receipt.status === 'created' && receipt.id !== target.session?.id
    : receipt.status === 'stopping' && receipt.id === input.preview_session_id
      && receipt.start_tool_run_id === target.session?.start_tool_run_id && Boolean(receipt.stop_tool_run_id);
}

export function usePreview(snapshot: Snapshot | null, enabled: boolean) {
  const target = selectTarget(snapshot);
  const packageKey = target?.packageKey;
  const accessKey = target?.accessKey;
  const readKey = enabled ? accessKey : undefined;
  const targetRef = useRef(target);
  targetRef.current = target;
  const readKeyRef = useRef(readKey);
  readKeyRef.current = readKey;
  const readerRef = useRef<Reader | null>(null);
  const commandRef = useRef<CommandScope | null>(null);
  const [readState, setReadState] = useState<ReadState | null>(null);
  const [frame, setFrame] = useState<{ key: string; origin: string } | null>(null);
  const [commandState, setCommandState] = useState<CommandState | null>(null);

  useEffect(() => {
    setFrame(null);
    setReadState(null);
    const requested = targetRef.current;
    if (!readKey || requested?.accessKey !== readKey) return;
    let active = true;
    let request: AbortController | null = null;
    let opening = false;
    let expire: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && readKeyRef.current === readKey;

    function publish(result: AccessResult) {
      clearTimeout(expire);
      setReadState({ ...result, key: readKey!, checking: false });
      setFrame(previous => result.grant && previous?.origin === result.grant.origin ? previous : null);
      if (result.grant) {
        expire = setTimeout(() => {
          if (current()) publish({ grant: null, reason: expiredAccess, ahead: false });
        }, Math.max(0, result.grant.expiresAt - Date.now()));
      }
    }

    async function refresh(open = false) {
      if (!current() || (request && !open) || opening) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      opening = open;
      if (open) setReadState(previous => previous ? { ...previous, checking: true } : null);
      const accepts = () => current() && !controller.signal.aborted;
      try {
        const reply = await api.preview(requested!.delivery.run_id, controller.signal);
        if (!accepts()) return;
        const result = authorizeAccess(requested!, reply);
        publish(result);
        if (open && result.grant) setFrame({ key: readKey!, origin: result.grant.origin });
      } catch (error) {
        if (accepts()) publish({ grant: null, reason: errorMessage(error), ahead: false });
      } finally {
        if (request === controller) { request = null; opening = false; }
      }
    }

    function close() {
      if (opening) {
        request?.abort(); request = null; opening = false;
        setReadState(previous => previous ? { ...previous, checking: false } : null);
      }
      setFrame(null);
    }

    readerRef.current = { key: readKey, refresh, close };
    void refresh();
    const poll = setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => {
      active = false;
      request?.abort();
      clearInterval(poll);
      clearTimeout(expire);
      readerRef.current = null;
    };
  }, [readKey]);

  useEffect(() => {
    setCommandState(null);
    commandRef.current = packageKey ? { key: packageKey, inFlight: false, receipt: null, intent: null } : null;
    return () => { commandRef.current = null; };
  }, [packageKey]);

  const scopedRead = readState?.key === readKey ? readState : null;
  const scopedCommand = commandState?.key === packageKey ? commandState : null;
  const commandPhase = scopedCommand?.pending ? 'sending' : target && awaitsSnapshot(scopedCommand?.receipt ?? null, target) ? 'accepted' : null;
  const hasFreshAccess = scopedRead?.grant != null && scopedRead.grant.expiresAt > Date.now();
  const canOpen = Boolean(target && hasFreshAccess && !scopedRead?.checking && !commandPhase);
  const canCommand = enabled && target && !scopedRead?.ahead && !commandPhase;

  function close() { readerRef.current?.close(); }

  async function open() {
    if (!canOpen || readerRef.current?.key !== readKeyRef.current) return;
    await readerRef.current?.refresh(true);
  }

  async function command(operation: PreviewCommand['command']) {
    const scope = commandRef.current;
    const selected = targetRef.current;
    if (!scope || !selected || scope.key !== selected.packageKey || selected.accessKey !== accessKey || readKeyRef.current !== selected.accessKey
      || scopedRead?.ahead || scope.inFlight || awaitsSnapshot(scope.receipt, selected)) return;
    const { delivery, session } = selected;
    const input: PreviewCommand = { command: operation, package_id: delivery.id, expected_version: session?.version ?? 0 };
    if (operation === 'start') { if (!canStartSession(session)) return; }
    else {
      if (!session || !canStopSession(session)) return;
      input.preview_session_id = session.id;
    }
    close();
    const fingerprint = JSON.stringify(input);
    if (scope.intent?.fingerprint !== fingerprint) scope.intent = { fingerprint, key: crypto.randomUUID() };
    scope.inFlight = true;
    const current = () => commandRef.current === scope && targetRef.current?.packageKey === scope.key;
    const unchangedVersion = () => targetRef.current?.accessKey === selected.accessKey;
    setCommandState({ key: scope.key, pending: true, receipt: null, error: null });
    try {
      const receipt = await api.commandPreview(delivery.run_id, input, scope.intent.key);
      if (!current()) return;
      if (!sameReceipt(selected, receipt, input)) {
        setCommandState(unchangedVersion() ? { key: scope.key, pending: false, receipt: null,
          error: 'Ответ команды не соответствует выбранному пакету или версии preview.' } : null);
        return;
      }
      scope.intent = null;
      scope.receipt = receipt;
      setCommandState({ key: scope.key, pending: false, receipt, error: null });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && !error.problem.retriable) scope.intent = null;
      if (unchangedVersion()) {
        setCommandState({ key: scope.key, pending: false, receipt: null, error: errorMessage(error) });
        void readerRef.current?.refresh();
      } else setCommandState(null);
    } finally { scope.inFlight = false; }
  }

  return {
    session: latestPreview(snapshot?.preview_sessions),
    canStart: Boolean(canCommand && canStartSession(target.session)),
    canStop: Boolean(canCommand && canStopSession(target.session)),
    canOpen,
    checking: Boolean(readKey && (!scopedRead || scopedRead.checking)),
    openedOrigin: hasFreshAccess && !commandPhase && frame && frame.key === readKey && frame.origin === scopedRead?.grant?.origin ? frame.origin : null,
    accessReason: scopedRead?.reason ?? null,
    commandPhase,
    commandError: scopedCommand?.error ?? null,
    open, close, command,
  };
}
