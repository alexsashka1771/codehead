import type { CapabilitiesResponse, Snapshot, ToolCommand, ToolRunView } from '../../../../packages/contracts';
import { formatTime } from './roles';
import { ArtifactText } from './WorkerDetails';

export type QueueTool = (command: ToolCommand) => Promise<boolean>;
const operations: { id: ToolCommand['operation_id']; label: string; result: string }[] = [
  { id: 'validate_backend', label: 'Проверить Python', result: 'Проверка Python' },
  { id: 'test_backend', label: 'Проверить HTTP', result: 'Проверка HTTP' },
  { id: 'build_frontend', label: 'Собрать интерфейс', result: 'Сборка интерфейса' },
];
const statusLabels: Record<ToolRunView['status'], string> = {
  created: 'В очереди', running: 'Выполняется', succeeded: 'Успешно', failed: 'Ошибка', cancelled: 'Отменено', uncertain: 'Исход неизвестен', timed_out: 'Таймаут',
};
export function ToolRunsPanel({ snapshot, capabilities, connected, pending, onQueue, onSelectArtifact, onSelectDecision, awaitingToolEvent = false, selectedId = null, onSelectAll }: {
  snapshot: Snapshot | null; capabilities: CapabilitiesResponse | null; connected: boolean; pending: boolean;
  onQueue: QueueTool; onSelectArtifact: (id: string) => void; onSelectDecision: (id: string) => void;
  awaitingToolEvent?: boolean;
  selectedId?: string | null; onSelectAll?: () => void;
}) {
  const candidate = snapshot?.candidate;
  const tools = snapshot?.tool_runs ?? [];
  const runner = capabilities?.capabilities.find(capability => capability.id === 'runner');
  const active = tools.some(tool => ['created', 'running', 'uncertain'].includes(tool.status));
  const reason = !snapshot ? 'Выберите запуск, чтобы проверить сохранённого кандидата.'
    : !connected ? 'Для проверки восстановите соединение с сервером.'
    : !['clinic-v2', 'clinic-v3'].includes(snapshot.run.workflow_version) ? 'Запуск clinic-v1 не создаёт исходный код кандидата для Runner.'
    : snapshot.run.mode !== 'test' ? 'На этом этапе Runner доступен для просматриваемого тестового кандидата. Live-генерация пока недоступна.'
    : snapshot.run.cancel_requested || snapshot.run.status === 'cancelled' ? 'Запрошена отмена. Новые проверки недоступны.'
    : snapshot.run.pause_requested || ['paused', 'pausing'].includes(snapshot.run.status) ? 'Запрошена пауза. Возобновите запуск перед новой проверкой.'
    : ['succeeded', 'failed'].includes(snapshot.run.status) ? 'Запуск завершён. Новые проверки недоступны.'
    : runner?.status !== 'available' ? runner?.reason ?? 'Runner недоступен. Дождитесь подключения worker с поддержкой проверок.'
    : candidate?.status !== 'ready' ? 'Дождитесь сохранения готовой версии кандидата.'
    : awaitingToolEvent ? 'Команда принята. Ожидаем событие проверки от сервера.'
    : active ? 'Дождитесь завершения текущей проверки. Неизвестный исход требует решения автора.' : null;
  const disabled = pending || reason !== null;
  return <section className="tool-panel" aria-label="Проверки кандидата" data-candidate-revision={candidate?.revision}>
    <div className="decision-heading"><h3>Проверки кандидата{candidate ? ' · версия ' + candidate.revision : ''}</h3></div>
    <p className="field-hint">Runner выполняет реальные локальные процессы. {snapshot?.run.workflow_version === 'clinic-v3' ? 'История автоматических циклов и отчёты доступны во вкладке QA. DevOps и preview пока недоступны.' : 'QA, DevOps и preview пока недоступны.'}</p>
    <p className="tool-isolation">Изоляция process_only: Python, pytest и npm исполняют код с доступом к файлам и сети локального пользователя. Используйте проверенный учебный код и синтетические данные.</p>
    <div className="tool-actions">{operations.map(operation => <button type="button" key={operation.id} className="button secondary" disabled={disabled}
      onClick={() => { if (!disabled && candidate) void onQueue({ operation_id: operation.id, workspace_id: candidate.id,
        snapshot_version: candidate.revision, required_isolation: 'process_only', timeout_seconds: 180, output_limit_bytes: 262144 }); }}>{operation.label}</button>)}</div>
    {reason ? <p className="field-hint" role="status">{reason}</p> : null}
    {pending ? <p className="field-hint" role="status">Сохраняем команду проверки…</p> : null}
    {selectedId ? <button type="button" className="button text" onClick={onSelectAll}>Все проверки</button> : null}
    {tools.length ? <ol className="tool-list">{tools.filter(tool => !selectedId || tool.id === selectedId).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id.localeCompare(left.id)).map(tool => {
      const decision = snapshot?.decisions?.find(item => item.tool_run_id === tool.id && item.status === 'open');
      return <li className="tool-entry" key={tool.id} data-tool-id={tool.id} data-tool-status={tool.status}>
        <div className="attempt-heading"><h4>{operations.find(operation => operation.id === tool.operation_id)?.result ?? tool.operation_id} · v{tool.snapshot_version}</h4>
          <span className={'task-status status-' + tool.status}>{statusLabels[tool.status]}</span></div>
        {tool.qa_cycle_id ? <p className="field-hint">Цикл QA · итерация {snapshot?.quality_cycles?.find(cycle => cycle.id === tool.qa_cycle_id)?.iteration ?? 'неизвестна'}</p> : null}
        {candidate && tool.snapshot_version !== candidate.revision ? <p className="field-hint">Исторический результат версии {tool.snapshot_version}; текущий кандидат — v{candidate.revision}.</p> : null}
        <dl className="candidate-metadata">
          <div><dt>Код завершения</dt><dd>{tool.exit_code ?? 'Неизвестен'}</dd></div>
          <div><dt>PID корня дерева</dt><dd>{tool.process_id ?? 'Неизвестен'}</dd></div>
          <div><dt>Изоляция</dt><dd>{tool.isolation_level ?? 'process_only'} · требуется {tool.required_isolation ?? 'process_only'}</dd></div>
          <div><dt>Создана</dt><dd><time dateTime={tool.created_at}>{formatTime(tool.created_at, true)}</time></dd></div>
          <div><dt>Начало</dt><dd>{tool.started_at ? <time dateTime={tool.started_at}>{formatTime(tool.started_at, true)}</time> : 'Не начата'}</dd></div>
          <div><dt>Завершение</dt><dd>{tool.finished_at ? <time dateTime={tool.finished_at}>{formatTime(tool.finished_at, true)}</time> : 'Исход ещё неизвестен'}</dd></div>
          <div><dt>Manifest версии</dt><dd><button type="button" className="document-link" data-artifact-id={tool.manifest_artifact_id}
            onClick={() => onSelectArtifact(tool.manifest_artifact_id)}>Manifest · v{tool.snapshot_version}</button></dd></div>
        </dl>
        {tool.error_message || tool.error_code ? <p className="attempt-error" role="status">{tool.error_code ? tool.error_code + ' · ' : ''}{tool.error_message}</p> : null}
        {tool.status === 'uncertain' ? <p className="tool-isolation">Исход локального процесса неизвестен. Проверьте, что процесс остановлен, и сохраните объяснение в решении автора. Автоматического повтора нет.</p> : null}
        {decision ? <button type="button" className="document-link" data-decision-id={decision.id} onClick={() => onSelectDecision(decision.id)}>Открыть решение автора</button> : null}
        <details><summary>Команды, stdout и stderr</summary>
          <h5>Команды</h5><ArtifactText content={JSON.stringify(tool.commands ?? [], null, 2)} />
          <h5>stdout</h5><ArtifactText content={tool.stdout ?? ''} /><h5>stderr</h5><ArtifactText content={tool.stderr ?? ''} />
        </details>
        <details><summary>Отчёт, хэши и параметры версии</summary>
          {tool.report != null ? <ArtifactText content={JSON.stringify(tool.report, null, 2)} /> : <p className="field-hint">Отчёт ещё не сохранён.</p>}
          <dl className="candidate-metadata">
            <div><dt>ID проверки</dt><dd><code>{tool.id}</code></dd></div><div><dt>ID кандидата</dt><dd><code>{tool.workspace_id}</code></dd></div>
            <div><dt>Версия профиля</dt><dd>{tool.profile_version}</dd></div><div><dt>Лимиты</dt><dd>{tool.timeout_seconds ?? 180} с · {tool.output_limit_bytes ?? 262144} байт вывода</dd></div>
            {([['Дерево файлов', tool.tree_hash], ['Manifest', tool.manifest_hash], ['Профиль', tool.profile_hash],
              ['Внешние проверки', tool.acceptance_suite_hash], ['Технический каркас', tool.template_hash]] as const).map(([label, hash]) => <div key={label}><dt>{label} · SHA-256</dt><dd><code>{hash}</code></dd></div>)}
          </dl>
        </details>
      </li>;
    })}</ol> : awaitingToolEvent ? null : <p className="field-hint">Проверки ещё не запускались. Команда выполняется только после нажатия кнопки.</p>}
  </section>;
}
