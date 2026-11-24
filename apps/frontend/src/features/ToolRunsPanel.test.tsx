import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as inspector from './Inspector';
import { DecisionCard } from './WorkerDetails';
import { RunPanel } from './RunPanel';
import { makeToolSnapshot } from '../state/toolFixtures';
import type { CapabilitiesResponse, DecisionView, Snapshot, ToolCommand } from '../../../../packages/contracts';

const capabilities: CapabilitiesResponse = { roles: [], capabilities: [{ id: 'runner', status: 'available', reason: 'Runner ready' }] };
function render(snapshot: Snapshot, connected = true, available = capabilities, awaitingToolEvent = false) {
  expect(inspector).toHaveProperty('ToolRunsPanel');
  const Panel = (inspector as unknown as { ToolRunsPanel: (props: {
    snapshot: Snapshot; capabilities: CapabilitiesResponse; connected: boolean; pending: boolean; awaitingToolEvent?: boolean;
    onQueue: (command: ToolCommand) => Promise<boolean>; onSelectArtifact: (id: string) => void;
    onSelectDecision: (id: string) => void;
  }) => React.ReactNode }).ToolRunsPanel;
  return renderToStaticMarkup(<Panel snapshot={snapshot} capabilities={available} connected={connected} pending={false} awaitingToolEvent={awaitingToolEvent}
    onQueue={async () => true} onSelectArtifact={() => {}} onSelectDecision={() => {}} />);
}
describe('Runner controls and result inspection', () => {
  it('visibly disables controls for an accepted command awaiting its event without inventing a saved result', () => {
    const initial = { ...makeToolSnapshot(), tool_runs: [] };
    const markup = render(initial, true, capabilities, true);
    expect(markup).toContain('Команда принята. Ожидаем событие проверки');
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
    expect(markup).not.toContain('data-tool-id');
    expect(markup).not.toContain('Проверки ещё не запускались');
  });
  it('offers pause for a blocked run with an active tool and resume after its known completion', () => {
    const snapshot = makeToolSnapshot('running');
    const renderRun = () => renderToStaticMarkup(<RunPanel run={snapshot.run} runs={[snapshot.run]} snapshot={snapshot}
      loading={false} pending={null} hasProject connected usage={snapshot.usage!} onSelectRun={() => {}}
      onStart={() => {}} onStartTest={() => {}} onCommand={() => {}} />);
    expect(renderRun()).toMatch(/>Пауза<\/button>/);
    snapshot.run.pause_requested = true;
    expect(renderRun()).not.toMatch(/>Продолжить<\/button>/);
    snapshot.tool_runs![0].status = 'succeeded';
    expect(renderRun()).toMatch(/>Продолжить<\/button>/);
  });
  it('offers three explicit checks, saved results and escaped process output', () => {
    const snapshot = makeToolSnapshot(); const markup = render(snapshot);
    for (const name of ['Проверить Python', 'Проверить HTTP', 'Собрать интерфейс', 'process_only', 'Код завершения', 'Manifest', 'stdout', 'stderr']) expect(markup).toContain(name);
    expect(markup).toContain('&lt;script&gt;compile complete&lt;/script&gt;');
    expect(markup).not.toContain('<script>'); expect(markup).not.toContain('disabled=""');
    for (const hash of [snapshot.candidate!.tree_hash, snapshot.candidate!.profile_hash, snapshot.candidate!.manifest_hash!]) expect(markup).toContain(hash);
  });
  it.each(['created', 'running', 'failed', 'cancelled', 'uncertain', 'timed_out'] as const)('renders saved %s honestly', status => {
    expect(render(makeToolSnapshot(status))).toContain('data-tool-status="' + status + '"');
  });
  it('labels created and timed out states and blocks another command while a created tool awaits worker', () => {
    const created = render(makeToolSnapshot('created'));
    expect(created).toContain('В очереди'); expect(created).toContain('disabled=""');
    expect(render(makeToolSnapshot('timed_out'))).toContain('Таймаут');
  });
  it('disables disconnected, paused, cancelled, legacy and unavailable commands with explanatory copy', () => {
    const snapshot = makeToolSnapshot();
    expect(render(snapshot, false)).toContain('восстановите соединение');
    snapshot.run.pause_requested = true; expect(render(snapshot)).toContain('пауза');
    snapshot.run.pause_requested = false; snapshot.run.cancel_requested = true; expect(render(snapshot)).toContain('отмена');
    snapshot.run.cancel_requested = false; snapshot.run.workflow_version = 'clinic-v1'; expect(render(snapshot)).toContain('clinic-v1');
    snapshot.run.workflow_version = 'clinic-v2';
    expect(render(snapshot, true, { roles: [], capabilities: [{ id: 'runner', status: 'disabled', reason: 'Worker absent' }] })).toContain('Worker absent');
  });
  it('requires an explanation for uncertain local processes and offers no risk retry', () => {
    const snapshot = makeToolSnapshot('uncertain');
    const decision: DecisionView = { id: 'tool-decision', run_id: snapshot.run.id, task_id: null, attempt_id: null,
      tool_run_id: 'tool-one', kind: 'tool_uncertain_outcome', status: 'open', version: 1,
      title: 'Исход процесса неизвестен', summary: 'Проверьте процесс', choices: ['confirm_failed', 'retry_with_risk'],
      artifact_ids: [], choice: null, comment: null, created_at: snapshot.run.created_at, resolved_at: null };
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} artifacts={[]} pending={false} connected
      onResolve={async () => true} onSelectArtifact={() => {}} />);
    expect(markup).toContain('Подтвердить остановку'); expect(markup).toContain('локального процесса');
    expect(markup).toContain('минимум 10 символов'); expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('Повторить с риском'); expect(markup).not.toContain('type="checkbox"');
  });
});
