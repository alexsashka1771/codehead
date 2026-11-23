import { useState } from 'react';
import { FileText, RefreshCw, ScrollText } from 'lucide-react';
import type { AgentRunView, ArtifactView, AttemptTrace, DecisionResolution, DecisionView, TaskView } from '../../../../packages/contracts';
import { api } from '../app/api';
import { useImmutableResource } from '../state/useImmutableResource';
import { formatTime, roleDetails } from './roles';

export type ResolveDecision = (decision: DecisionView, choice: DecisionResolution['choice'], comment: string) => Promise<boolean>;
export const attemptLabels: Record<AgentRunView['status'], string> = {
  created: 'Подготовлена', running: 'Выполняется', succeeded: 'Ответ принят', failed: 'Ошибка',
  cancelled: 'Отменена', uncertain: 'Исход неизвестен',
};
const choiceLabels: Record<DecisionResolution['choice'], string> = {
  approve: 'Принять архитектуру', reject: 'Отклонить архитектуру',
  confirm_failed: 'Подтвердить известный отказ', retry_with_risk: 'Повторить с риском',
};
const resolvedLabels: Record<string, string> = {
  approve: 'Архитектура принята', reject: 'Архитектура отклонена',
  confirm_failed: 'Известный отказ подтверждён', retry_with_risk: 'Повтор с риском согласован',
};
const artifactLabels: Record<string, string> = {
  requirements: 'Требования', architecture: 'Архитектура', api_contract: 'Контракт API', decision: 'Оценка CTO',
};
function artifactLabel(artifact: ArtifactView) { return artifactLabels[artifact.artifact_type] ?? artifact.relative_path; }

export function InputVersions({ versions, artifacts = [], onSelectArtifact }: {
  versions: Record<string, number>; artifacts?: ArtifactView[]; onSelectArtifact?: (id: string) => void;
}) {
  const inputs = Object.entries(versions);
  return inputs.length ? <ul className="input-versions">{inputs.map(([id, version]) => {
    const artifact = artifacts.find(item => (item.id === id || item.artifact_type === id) && item.version === version);
    return <li key={id}>{artifact && onSelectArtifact ? <button type="button" className="document-link" data-artifact-id={artifact.id}
      title={artifact.relative_path} onClick={() => onSelectArtifact(artifact.id)}>{artifactLabel(artifact)} · v{version}</button>
      : <><span>{id}</span><strong>v{version}</strong></>}</li>;
  })}</ul> : <p className="field-hint">Входные артефакты не использовались.</p>;
}

export function ArtifactText({ content }: { content: string }) {
  return <pre className="artifact-content" tabIndex={0}>{content}</pre>;
}

export function TraceText({ trace }: { trace: AttemptTrace }) {
  return <div className="trace-content">
    <p className="field-hint">Trace с удалёнными секретами · {trace.redaction_version} · stop reason: {trace.stop_reason ?? 'неизвестно'}</p>
    <h4>Prompt</h4>{trace.prompt != null ? <ArtifactText content={trace.prompt} /> : <p className="field-hint">Prompt недоступен.</p>}
    <h4>Ответ до разбора</h4>{trace.raw_response != null ? <ArtifactText content={trace.raw_response} /> : <p className="field-hint">Ответ недоступен.</p>}
    <details><summary>Параметры и входные версии</summary><ArtifactText content={JSON.stringify({ parameters: trace.parameters, input_versions: trace.input_versions }, null, 2)} /></details>
  </div>;
}

function ResourceError({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="resource-error" role="alert"><p>{message}</p>{retry ?
    <button type="button" className="button secondary" onClick={retry}><RefreshCw size={14} />Повторить загрузку</button> : null}</div>;
}

export function ArtifactDocument({ artifact, artifacts = [] }: { artifact: ArtifactView; artifacts?: ArtifactView[] }) {
  const resource = useImmutableResource(artifact.id, api.artifactContent);
  const content = resource.data;
  const matches = content?.artifact_id === artifact.id && content.content_hash === artifact.content_hash;
  return <section className="artifact-document" aria-label={'Документ ' + artifactLabel(artifact) + ' версии ' + artifact.version}>
    <h3>{artifactLabel(artifact)}</h3><p className="document-path">{artifact.relative_path}</p>
    <p className="document-provenance">v{artifact.version} · {artifact.provenance?.origin === 'test' ? 'ТЕСТ · заглушка' : artifact.provenance?.origin ?? 'Источник неизвестен'} · {artifact.media_type ?? 'Тип неизвестен'}{artifact.byte_size != null ? ' · ' + artifact.byte_size + ' байт' : ''}</p>
    <code className="document-hash">SHA-256 {artifact.content_hash}</code>
    <details><summary>Происхождение и входные версии</summary><InputVersions versions={artifact.input_versions} artifacts={artifacts} />
      <dl className="attempt-metadata"><div><dt>Автор</dt><dd>{artifact.author_role ? roleDetails[artifact.author_role].name : 'Неизвестно'}</dd></div>
        <div><dt>Создан</dt><dd><time dateTime={artifact.created_at}>{formatTime(artifact.created_at, true)}</time></dd></div>
        <div><dt>Источник результата</dt><dd>{artifact.provenance?.producer_id ?? 'Неизвестно'}</dd></div></dl></details>
    {resource.loading ? <p role="status" className="field-hint">Загружаем неизменяемый документ…</p> : null}
    {resource.error ? <ResourceError message={resource.error} retry={resource.retry} /> : null}
    {content && !matches ? <ResourceError message="Ответ не соответствует выбранной версии документа. Обновите данные запуска." /> : null}
    {content && matches ? <ArtifactText content={content.content} /> : null}
  </section>;
}

export function ArtifactBrowser({ artifacts, selectedId, onSelect }: {
  artifacts: ArtifactView[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const selected = artifacts.find(artifact => artifact.id === selectedId);
  return <div className="artifact-browser"><ul className="artifact-list">{artifacts.map(artifact =>
    <li key={artifact.id}><button type="button" className="artifact-select" aria-pressed={artifact.id === selectedId} data-artifact-id={artifact.id}
      aria-label={artifactLabel(artifact) + ' · v' + artifact.version} onClick={() => onSelect(artifact.id)}><FileText size={16} /><span className="artifact-name"><strong>{artifactLabel(artifact)}</strong><small>{artifact.relative_path}</small></span><span>v{artifact.version}</span></button>
      <span className="document-origin">{artifact.provenance?.origin === 'test' ? 'ТЕСТ' : artifact.provenance?.origin ?? 'Источник неизвестен'}</span>
    </li>)}</ul>{selected ? <ArtifactDocument key={selected.id} artifact={selected} artifacts={artifacts} /> : null}</div>;
}

function AttemptTracePanel({ attempt }: { attempt: AgentRunView }) {
  const resource = useImmutableResource(attempt.id, api.attemptTrace, attempt.status + ':' + (attempt.finished_at ?? ''));
  return <section className="attempt-trace" aria-label="Trace попытки">
    {resource.loading ? <p role="status" className="field-hint">Загружаем trace…</p> : null}
    {resource.error ? <ResourceError message={resource.error} retry={resource.retry} /> : null}
    {resource.data?.attempt_id === attempt.id ? <TraceText trace={resource.data} />
      : resource.data ? <ResourceError message="Trace относится к другой попытке. Обновите данные запуска." /> : null}
  </section>;
}

export function AttemptList({ attempts, artifacts, tasks = [], onSelectArtifact, active = true }: {
  attempts: AgentRunView[]; artifacts: ArtifactView[]; tasks?: TaskView[]; onSelectArtifact?: (id: string) => void; active?: boolean;
}) {
  const [traceId, setTraceId] = useState<string | null>(null);
  return <ol className="attempt-list">{[...attempts].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.number - left.number).map(attempt => {
    const task = tasks.find(item => item.id === attempt.task_id);
    return (
    <li key={attempt.id} className="attempt-entry" data-attempt-id={attempt.id}>
      <div className="attempt-heading"><strong>{(task ? roleDetails[task.role].name + ' · ' : '') + 'Попытка ' + attempt.number}</strong><span className={'task-status status-' + attempt.status}>{attemptLabels[attempt.status]}</span></div>
      <p className="field-hint">{attempt.provider === 'test' ? 'ТЕСТ · заглушка' : attempt.provider} · {attempt.model ?? 'Модель неизвестна'}</p>
      <p className="field-hint"><time dateTime={attempt.created_at}>{formatTime(attempt.created_at, true)}</time> · {attempt.latency_ms != null ? `${Math.round(attempt.latency_ms)} мс` : 'Время неизвестно'} · {attempt.cost_usd != null ? `$${attempt.cost_usd.toFixed(4)}` : 'Стоимость неизвестна'}</p>
      {attempt.error_message ? <p className="attempt-error" role="status">{attempt.error_message}</p> : null}
      {attempt.status === 'uncertain' ? <p className="field-hint">Отправка могла выполниться. Автоматического повторного вызова нет.</p> : null}
      <details><summary>Входы и параметры</summary><InputVersions versions={attempt.input_versions} artifacts={artifacts} onSelectArtifact={onSelectArtifact} />
        <dl className="attempt-metadata"><div><dt>ID попытки</dt><dd><code>{attempt.id}</code></dd></div><div><dt>Fencing token</dt><dd>{attempt.fencing_token}</dd></div><div><dt>Stop reason</dt><dd>{attempt.stop_reason ?? 'Неизвестно'}</dd></div><div><dt>Provider request ID</dt><dd>{attempt.provider_request_id ?? 'Неизвестно'}</dd></div>
          <div><dt>Начало вызова</dt><dd>{attempt.started_at ? <time dateTime={attempt.started_at}>{formatTime(attempt.started_at, true)}</time> : 'Не начат'}</dd></div>
          <div><dt>Завершение</dt><dd>{attempt.finished_at ? <time dateTime={attempt.finished_at}>{formatTime(attempt.finished_at, true)}</time> : 'Исход ещё неизвестен'}</dd></div>
          {attempt.retry_of_attempt_id ? <div><dt>Повтор попытки</dt><dd><code>{attempt.retry_of_attempt_id}</code></dd></div> : null}
          <div><dt>Входные / выходные токены</dt><dd>{attempt.input_tokens ?? '—'} / {attempt.output_tokens ?? '—'}</dd></div></dl>
        <ArtifactText content={JSON.stringify(attempt.parameters, null, 2)} />
      </details>
      {attempt.trace_available ? <button type="button" className="button text" aria-expanded={traceId === attempt.id}
        onClick={() => setTraceId(traceId === attempt.id ? null : attempt.id)}><ScrollText size={14} />{traceId === attempt.id ? 'Скрыть trace' : 'Открыть trace'}</button>
        : <p className="field-hint">Trace этой попытки недоступен.</p>}
      {active && traceId === attempt.id ? <AttemptTracePanel key={attempt.id} attempt={attempt} /> : null}
    </li>);
  })}</ol>;
}

export function DecisionCard({ decision, artifacts, pending, connected, onResolve, onSelectArtifact }: {
  decision: DecisionView; artifacts: ArtifactView[]; pending: boolean; connected: boolean;
  onResolve: ResolveDecision; onSelectArtifact: (id: string) => void;
}) {
  const [comment, setComment] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const uncertain = decision.kind === 'uncertain_outcome';
  const explanationMissing = uncertain && comment.trim().length < 10;
  const open = decision.status === 'open';
  const reconciliation = decision.blocking === false;
  const choices = decision.choices.filter((choice): choice is DecisionResolution['choice'] => Object.hasOwn(choiceLabels, choice));
  return <section className="decision-card" aria-label={decision.title} data-decision-id={decision.id} data-decision-version={decision.version}>
    <div className="decision-heading"><h3>{decision.title}</h3><span className="quiet-label">v{decision.version} · {open ? 'Ждёт ответа' : 'Решено'}</span></div>
    <p className="decision-summary">{decision.summary}</p>
    {decision.artifact_ids.length ? <ul className="decision-documents">{decision.artifact_ids.map(id => {
      const artifact = artifacts.find(item => item.id === id);
      return <li key={id}><button type="button" className="document-link" data-artifact-id={id} title={artifact?.relative_path}
        onClick={() => onSelectArtifact(id)}><FileText size={14} />{artifact ? artifactLabel(artifact) + ' · v' + artifact.version : id}</button></li>;
    })}</ul> : null}
    {open ? <>
      {reconciliation ? <p className="decision-risk">Сверка предыдущей отправки не останавливает новую работу. Пауза и отмена ожидают известного исхода старой попытки. Подтверждайте отказ только при известном результате.</p>
        : uncertain ? <p className="decision-risk">Исход предыдущей отправки неизвестен. Повтор может создать дублирующий вызов и дополнительные расходы. Подтверждайте отказ только при известном результате.</p>
        : <p className="field-hint">Принятие завершит оценку CTO без нового вызова провайдера. Разработка Clinic Demo на следующем этапе пока недоступна.</p>}
      <label className="decision-comment"><span>{uncertain ? 'Объяснение · минимум 10 символов' : 'Комментарий к решению (необязательно)'}</span>
        <textarea value={comment} onChange={event => setComment(event.target.value)} rows={2} maxLength={4000} disabled={pending} />
      </label>
      {uncertain && choices.includes('retry_with_risk') ? <label className="decision-acknowledgement"><input type="checkbox" checked={riskAccepted}
        onChange={event => setRiskAccepted(event.target.checked)} disabled={pending} /><span>Понимаю риск дублирующего вызова и дополнительных расходов</span></label> : null}
      <div className="decision-actions">{choices.map(choice => <button key={choice} type="button"
        className={'button ' + (choice === 'approve' ? 'primary' : choice === 'reject' ? 'text danger' : 'secondary')}
        disabled={pending || !connected || explanationMissing || (choice === 'retry_with_risk' && !riskAccepted)}
        onClick={() => void onResolve(decision, choice, comment.trim())}>{choiceLabels[choice]}</button>)}</div>
      {!connected ? <p className="field-hint">Для ответа восстановите соединение с сервером.</p> : null}
      {pending ? <p role="status" className="field-hint">Сохраняем решение…</p> : null}
    </> : <><p className="decision-result" role="status">{resolvedLabels[decision.choice ?? ''] ?? decision.choice ?? 'Решение сохранено'}{decision.comment ? ' · ' + decision.comment : ''}</p>
      {decision.resolved_at ? <p className="field-hint">Сохранено <time dateTime={decision.resolved_at}>{formatTime(decision.resolved_at, true)}</time></p> : null}</>}
  </section>;
}
