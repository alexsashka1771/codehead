import { useRef, useState } from 'react';
import { Boxes, ChevronDown, ChevronUp, FileBox, GitBranch, History, List, ListChecks, ScrollText, Terminal } from 'lucide-react';
import type { CapabilitiesResponse, DomainEvent, Snapshot } from '../../../../packages/contracts';
import { formatTime, roleDetails, taskLabels } from './roles';
import { ArtifactBrowser, AttemptList, DecisionCard, type ResolveDecision } from './WorkerDetails';
import { CandidatePanel } from './CandidatePanel';
import { ToolRunsPanel, type QueueTool } from './ToolRunsPanel';
export { CandidatePanel } from './CandidatePanel';
export { ToolRunsPanel } from './ToolRunsPanel';

type Tab = 'tasks' | 'events' | 'candidate' | 'tools' | 'artifacts' | 'attempts' | 'decisions' | 'capabilities';
interface Props {
  snapshot: Snapshot | null; events: DomainEvent[]; capabilities: CapabilitiesResponse | null; loading: boolean;
  expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  connected: boolean; pending: boolean; onResolve: ResolveDecision;
  onQueueTool?: QueueTool;
  awaitingToolEvent?: boolean;
}
const eventNames: Record<string, string> = {
  'run.created': 'Создан запуск', 'task.queued': 'Задача поставлена в очередь', 'run.paused': 'Запуск приостановлен',
  'run.pausing': 'Запрошена пауза', 'run.resumed': 'Запуск возобновлён', 'run.cancelled': 'Запуск отменён',
  'workflow.updated': 'Обновлён процесс',
};
const capabilityNames: Record<string, string> = { persistence: 'Сохранение состояния', event_stream: 'Поток событий', worker: 'Исполнение задач', test_execution: 'Тестовое исполнение', first_roles: 'PM → Architect → CTO', live_generation: 'Генерация приложения', replay: 'Воспроизведение запусков', runner: 'Проверки и локальный запуск' };
const capabilityStatus = { available: 'Доступно', planned: 'Планируется', disabled: 'Отключено', degraded: 'Ограничено' };

export function Inspector({ snapshot, events, capabilities, loading, expanded, onExpandedChange: setExpanded, connected, pending, onResolve, onQueueTool, awaitingToolEvent = false }: Props) {
  const [tab, setTab] = useState<Tab>('tasks');
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const tasks = snapshot?.tasks ?? [];
  const [artifactSelection, setArtifactSelection] = useState<{ runId: string; id: string } | null>(null);
  const [attemptSelection, setAttemptSelection] = useState<{ runId: string; id: string } | null>(null);
  const selectedArtifactId = artifactSelection?.runId === snapshot?.run.id ? artifactSelection?.id ?? null : null;
  const selectedAttemptId = attemptSelection?.runId === snapshot?.run.id ? attemptSelection?.id ?? null : null;
  const artifacts = snapshot?.artifacts ?? [];
  const attempts = snapshot?.agent_runs ?? [];
  const decisions = snapshot?.decisions ?? [];
  function selectArtifact(id: string) { if (!snapshot) return; setArtifactSelection({ runId: snapshot.run.id, id }); setTab('artifacts'); setExpanded(true); }
  function selectAttempt(id: string) { if (!snapshot) return; setAttemptSelection({ runId: snapshot.run.id, id }); setTab('attempts'); setExpanded(true); }
  const [decisionSelection, setDecisionSelection] = useState<{ runId: string; id: string } | null>(null);
  const selectedDecisionId = decisionSelection?.runId === snapshot?.run.id ? decisionSelection?.id ?? null : null;
  function selectDecision(id: string) { if (!snapshot) return; setDecisionSelection({ runId: snapshot.run.id, id }); setTab('decisions'); setExpanded(true); }
  const tabs = [
    { id: 'tasks' as const, label: 'Очередь задач', short: 'Очередь', count: tasks.length, icon: List },
    { id: 'events' as const, label: 'Журнал событий', short: 'События', count: events.length, icon: ScrollText },
    { id: 'candidate' as const, label: 'Кандидат Clinic Demo', short: 'Версия', count: snapshot?.candidate?.revision, icon: GitBranch },
    { id: 'tools' as const, label: 'Проверки', short: 'Проверки', count: snapshot?.tool_runs?.length ?? 0, icon: Terminal },
    { id: 'artifacts' as const, label: 'Артефакты', short: 'Файлы', count: snapshot?.artifacts.length ?? 0, icon: FileBox },
    { id: 'attempts' as const, label: 'Попытки ролей', short: 'Попытки', count: attempts.length, icon: History },
    { id: 'decisions' as const, label: 'Решения автора', short: 'Решения', count: decisions.filter(decision => decision.status === 'open').length, icon: ListChecks },
    { id: 'capabilities' as const, label: 'Возможности', short: 'Система', icon: Boxes },
  ];
  return <section className={`inspector ${expanded ? 'expanded' : ''}`} aria-label="Данные запуска">
    <div className="inspector-bar"><div className="inspector-tabs" role="tablist" aria-label="Данные запуска">{tabs.map(({ id, label, short, count, icon: Icon }, index) => <button key={id} ref={(element) => { tabButtons.current[index] = element; }} id={`tab-${id}`} role="tab" aria-label={label} title={label} tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls="inspector-content" className={`inspector-tab ${tab === id && expanded ? 'active' : ''}`} onClick={() => { setTab(id); setExpanded(true); }} onKeyDown={(event) => {
      const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (target !== null) { event.preventDefault(); setTab(tabs[target].id); setExpanded(true); tabButtons.current[target]?.focus(); }
    }}><Icon size={15} /><span>{short}</span>{count != null ? <span className="tab-count">{count}</span> : null}</button>)}</div><button className="icon-button" aria-label={expanded ? 'Свернуть панель данных' : 'Развернуть панель данных'} aria-controls="inspector-content" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</button></div>
    <div hidden={!expanded} className="inspector-content" id="inspector-content" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
      {tab === 'tasks' ? tasks.length ? <table className="task-table"><thead><tr><th>Задача</th><th>Роль</th><th>Зависимости</th><th>Состояние</th></tr></thead><tbody>{tasks.map((task, index) => <tr key={task.id}><td><span className="task-number">{String(index + 1).padStart(2, '0')}</span>{roleDetails[task.role].task}</td><td>{roleDetails[task.role].name}</td><td><span className="dependencies">{task.dependencies.length ? <><GitBranch size={12} />{task.dependencies.map((id) => { const dependency = tasks.find((item) => item.id === id); return dependency ? roleDetails[dependency.role].short : id.slice(0, 8); }).join(' + ')}</> : 'Начало процесса'}</span></td><td><span className={`task-status status-${task.status}`}><span aria-hidden="true" />{taskLabels[task.status]}</span></td></tr>)}</tbody></table> : <EmptyState icon={<List size={26} />} title={loading ? 'Загружаем очередь…' : 'Очередь ещё не создана'} text="Создайте проект и нажмите «Запустить». Здесь появятся реальные задачи и их зависимости." /> : null}
      {tab === 'events' ? events.length ? <ol className="event-list">{events.map((event) => <li key={event.event_id}><span className="event-seq">#{String(event.seq).padStart(3, '0')}</span><time dateTime={event.occurred_at}>{formatTime(event.occurred_at)}</time><span className="event-message">{eventNames[event.event_type ?? ''] ?? event.event_type}{event.event_type === 'task.queued' ? <span className="event-role">{roleDetails[event.payload.task.role].name}</span> : event.event_type === 'workflow.updated' ? <span className="event-role">{event.payload.action}</span> : null}</span><code>{event.event_type}</code></li>)}</ol> : <EmptyState icon={<ScrollText size={26} />} title={loading ? 'Загружаем историю…' : 'В журнале пока пусто'} text="Здесь появятся события, сохранённые сервером. История останется после обновления страницы." /> : null}
      {tab === 'artifacts' ? artifacts.length ? <ArtifactBrowser artifacts={artifacts} selectedId={expanded ? selectedArtifactId : null} onSelect={selectArtifact} /> : <EmptyState icon={<FileBox size={26} />} title="Результатов пока нет" text="После тестового выполнения первых ролей здесь появятся неизменяемые документы с указанным источником." /> : null}
      {tab === 'candidate' ? <CandidatePanel snapshot={snapshot} onSelectArtifact={selectArtifact} onSelectAttempt={selectAttempt} /> : null}
      {tab === 'tools' ? <ToolRunsPanel snapshot={snapshot} capabilities={capabilities} connected={connected} pending={pending || !onQueueTool} awaitingToolEvent={awaitingToolEvent}
        onQueue={onQueueTool ?? (async () => false)} onSelectArtifact={selectArtifact} onSelectDecision={selectDecision} /> : null}
      {tab === 'attempts' ? attempts.length ? <div className="worker-data"><AttemptList key={snapshot?.run.id + ':' + selectedAttemptId} attempts={selectedAttemptId ? attempts.filter(attempt => attempt.id === selectedAttemptId) : attempts} artifacts={artifacts} tasks={tasks} onSelectArtifact={selectArtifact} active={expanded} />{selectedAttemptId ? <button type="button" className="button text" onClick={() => setAttemptSelection(null)}>Все попытки</button> : null}</div> : <EmptyState icon={<History size={26} />} title="Попыток пока нет" text="Worker сохраняет каждую попытку, её входы и результат. Live-провайдер пока недоступен." /> : null}
      {tab === 'decisions' ? decisions.length ? <div className="worker-data">{(selectedDecisionId ? decisions.filter(decision => decision.id === selectedDecisionId) : decisions).map(decision => <DecisionCard key={decision.id + ':' + decision.version}
        decision={decision} sourceEnabled={snapshot?.run.workflow_version === 'clinic-v2'} artifacts={artifacts} pending={pending} connected={connected} onResolve={onResolve} onSelectArtifact={selectArtifact} />)}
        {selectedDecisionId ? <button type="button" className="button text" onClick={() => setDecisionSelection(null)}>Все решения</button> : null}</div>
        : <EmptyState icon={<ListChecks size={26} />} title="Решений пока нет" text="После оценки CTO здесь можно прочитать документы и принять или отклонить архитектуру." /> : null}
      {tab === 'capabilities' ? <div className="capability-list">{capabilities?.capabilities.length ? capabilities.capabilities.map((capability) => <div className="capability-row" key={capability.id}><strong>{capabilityNames[capability.id] ?? capability.id}</strong><span className={`capability-status ${capability.status}`}>{capabilityStatus[capability.status]}</span><p>{capability.reason ?? 'Подключено к текущему серверу.'}</p></div>) : <EmptyState icon={<Boxes size={26} />} title="Нет данных о возможностях" text="Восстановите соединение с сервером, чтобы получить актуальный список." />}</div> : null}
    </div>
  </section>;
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="empty-state">{icon}<div><h3>{title}</h3><p>{text}</p></div></div>;
}
