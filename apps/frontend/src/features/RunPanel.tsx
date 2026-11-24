import { CirclePause, FlaskConical, Pause, Play, Square, Unplug } from 'lucide-react';
import type { RunCommand, RunView, Snapshot, UsageSummary } from '../../../../packages/contracts';
import { formatTime, runLabels, terminalStatuses } from './roles';

interface Props {
  run: RunView | null; runs: RunView[]; snapshot: Snapshot | null; loading: boolean; pending: string | null;
  hasProject: boolean; connected: boolean; usage: UsageSummary | null;
  testAvailable?: boolean; testReason?: string | null;
  onSelectRun: (id: string) => void; onStart: () => void; onStartTest: () => void; onCommand: (command: RunCommand['command']) => void;
}

export function RunPanel({ run, runs, snapshot, loading, pending, hasProject, connected, usage, testAvailable = false, testReason,
  onSelectRun, onStart, onStartTest, onCommand }: Props) {
  const currentRun = snapshot?.run ?? run;
  const activeRun = runs.find((item) => !terminalStatuses.includes(item.id === currentRun?.id ? currentRun.status : item.status));
  const canPause = currentRun && ['created', 'running'].includes(currentRun.status) && !currentRun.cancel_requested;
  const canResume = currentRun?.status === 'paused' && !currentRun.cancel_requested;
  const canCancel = currentRun && !terminalStatuses.includes(currentRun.status) && !currentRun.cancel_requested;
  const startDisabled = !hasProject || loading || Boolean(pending) || Boolean(activeRun);
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const tokenTotal = inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null;
  const test = currentRun?.mode === 'test';
  return <>
    <section className="process-panel" aria-labelledby="process-title">
      <div className="section-title"><h2 id="process-title">Текущий процесс</h2>{currentRun ? <span className={'mode-label' + (test ? ' test-label' : '')}>{test ? 'ТЕСТ · заглушка' : currentRun.mode.toUpperCase()}</span> : null}</div>
      {runs.length ? <label className="run-picker"><span className="sr-only">Сохранённый запуск</span><select value={run?.id ?? ''} onChange={(event) => onSelectRun(event.target.value)} disabled={Boolean(pending)}>{runs.map((item) => <option value={item.id} key={item.id}>{formatTime(item.created_at, true)} · {runLabels[item.id === currentRun?.id ? currentRun.status : item.status]} · {item.mode === 'test' ? 'ТЕСТ / заглушка' : 'LIVE'}</option>)}</select></label> : null}
      <div className={`process-status status-${currentRun?.status ?? 'empty'}`} role="status">
        {currentRun?.status === 'paused' ? <CirclePause size={21} /> : <Unplug size={21} />}
        <div><strong>{loading ? 'Загружаем запуски…' : currentRun ? runLabels[currentRun.status] : 'Готов к первому запуску'}</strong><p>{currentRun?.blocked_reason ?? (currentRun?.cancel_requested ? 'Отмена запрошена. Ожидаем известного завершения текущей попытки.' : currentRun?.status === 'pausing' ? 'Ожидаем завершения текущей попытки перед паузой.' : currentRun?.status === 'cancelled' ? 'Запуск и его задачи сохранены в истории.' : currentRun?.status === 'paused' ? 'Очередь сохранена. Можно возобновить или отменить запуск.' : currentRun?.status === 'created' ? test ? 'Тестовая очередь сохранена в PostgreSQL и ожидает worker.' : 'Очередь сохранена в PostgreSQL. Live-провайдер недоступен.' : !currentRun ? 'Запуск создаст очередь из семи задач.' : 'Состояние получено с сервера.')}</p></div>
      </div>
      <div className="run-actions">
        <button type="button" className="button primary" onClick={onStart} disabled={startDisabled} title={activeRun ? 'Сначала отмените или завершите текущий запуск' : undefined}><Play size={15} fill="currentColor" />{pending === 'start' ? 'Создаём запуск…' : 'Запустить'}</button>
        <button type="button" className="button secondary" onClick={onStartTest} disabled={startDisabled || !testAvailable}
          title={!testAvailable ? testReason ?? 'Тестовый worker недоступен' : 'Тест реальной очереди с провайдером-заглушкой'}><FlaskConical size={15} />{pending === 'start-test' ? 'Создаём тест…' : 'Запустить тест'}</button>
        {canPause ? <button className="button secondary" type="button" disabled={Boolean(pending) || !connected} onClick={() => onCommand('pause')}><Pause size={15} />Пауза</button> : null}
        {canResume ? <button className="button secondary" type="button" disabled={Boolean(pending) || !connected} onClick={() => onCommand('resume')}><Play size={15} />Продолжить</button> : null}
        {canCancel ? <button className="button text danger" type="button" disabled={Boolean(pending) || !connected} onClick={() => onCommand('cancel')}><Square size={13} />Отменить запуск</button> : null}
      </div>
      <p className="execution-note">{test ? currentRun?.workflow_version === 'clinic-v2'
        ? 'Тестовый источник: пять ролей с заглушкой, без внешних LLM-вызовов. PM → Architect → CTO → Backend + Frontend. Исходный код кандидата сохраняется; QA, Runner и preview пока недоступны.'
        : 'Тестовый источник: детерминированные документы, без внешних LLM-вызовов. PM → Architect → CTO.'
        : 'Live-генерация пока недоступна: провайдер не подключён. Тест запускается отдельной кнопкой.'}{!testAvailable ? ' ' + (testReason ?? 'Тестовый worker сейчас недоступен.') : ''}</p>
      <details className="run-limits"><summary>Лимиты запуска</summary><dl><div><dt>Параллельные задачи</dt><dd>{currentRun?.limits.max_parallel_tasks ?? 2}</dd></div><div><dt>Циклы исправления</dt><dd>{currentRun?.limits.max_repair_iterations ?? 2}</dd></div><div><dt>Вызовы LLM</dt><dd>{currentRun?.limits.max_llm_calls ?? 64}</dd></div><div><dt>Время</dt><dd>{Math.round((currentRun?.limits.max_duration_seconds ?? 1800) / 60)} мин</dd></div><div><dt>Бюджет</dt><dd>{currentRun?.limits.max_cost_usd != null ? `$${currentRun.limits.max_cost_usd}` : 'Не задан'}</dd></div></dl></details>
    </section>
    <section className="usage-panel" aria-labelledby="usage-title"><div className="section-title"><h2 id="usage-title">Использование LLM</h2><span className="quiet-label">{usage?.source === 'test' ? 'Тестовый источник' : usage?.source === 'live' ? 'Live' : 'Неизвестно'}</span></div><dl className="usage-metrics"><div><dt>Запросы</dt><dd>{usage?.request_count ?? '—'}</dd></div><div><dt>Токены</dt><dd>{tokenTotal?.toLocaleString('ru-RU') ?? '—'}</dd></div><div><dt>Стоимость</dt><dd>{usage?.cost_usd != null ? `$${usage.cost_usd.toFixed(4)}` : '—'}</dd></div></dl><p className="field-hint">{usage?.model ? `${usage.provider ?? ''} · ${usage.model}` : 'Модель, токены и стоимость пока неизвестны.'}{usage?.source === 'test' ? ' Внешние токены и стоимость теста равны нулю.' : ''}</p></section>
  </>;
}
