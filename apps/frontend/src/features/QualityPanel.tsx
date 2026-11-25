import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ArtifactView, QualityCycleView, Snapshot } from '../../../../packages/contracts';
import { requirementLabels, type QualityDocument } from '../state/qualityContent';
import { useBugResolution, useQualityDocument } from '../state/useQualityDocument';
import { formatTime } from './roles';
import { testScenarioLabels } from './RunPanel';
interface Props { snapshot: Snapshot | null; onSelectArtifact: (id: string) => void; onSelectTool: (id: string) => void; onSelectTask: (id: string) => void }
const cycleLabels: Record<QualityCycleView['status'], string> = { created: 'В очереди', testing: 'Проверки выполняются', analyzing: 'QA анализирует',
  passed: 'Проверки пройдены', failed: 'Проверки не пройдены', blocked: 'Проверка заблокирована', cancelled: 'Отменено' };
const operationLabels = { validate_backend: 'Python', test_backend: 'HTTP', build_frontend: 'Сборка интерфейса' };
const checkLabels = { passed: 'Пройдено', failed: 'Не пройдено', not_verified: 'Не проверено' };
const toolLabels = { created: 'В очереди', running: 'Выполняется', succeeded: 'Пройдено', failed: 'Ошибка', cancelled: 'Отменено', uncertain: 'Исход неизвестен', timed_out: 'Таймаут' };
export function QualityPanel({ snapshot, ...callbacks }: Props) {
  const cycles = [...(snapshot?.quality_cycles ?? [])].sort((left, right) => left.iteration - right.iteration);
  if (!snapshot || !cycles.length) return <div className="empty-state"><div><h3>QA-циклов пока нет</h3>
    <p>{snapshot && snapshot.run.workflow_version !== 'clinic-v3' ? 'Эта версия процесса не выполняет QA автоматически. Результаты ручных проверок сохранены во вкладке «Проверки».'
      : 'После сохранения кандидата worker запустит Python, HTTP и сборку, затем QA составит отчёт по фактическим результатам.'}</p></div></div>;
  const latest = cycles[cycles.length - 1];
  return <section className="quality-panel" aria-label="Качество кандидата" data-run-id={snapshot.run.id}>
    <h3>QA · история проверок</h3><p className="field-hint">Статус «Проверки пройдены» подтверждает завершённые проверки выбранной версии. Он не подтверждает Live, полную приёмку продукта или готовность preview.</p>
    <section className="quality-latest" aria-label="Последняя проверка">
      <div className="attempt-heading"><h4>Последняя проверка · v{latest.revision}</h4>
        <span className={'quality-status status-' + latest.status}>{cycleLabels[latest.status]}</span></div>
      {latest.report_artifact_id ? <div className="quality-links"><button type="button" className="button secondary" data-artifact-id={latest.report_artifact_id}
        onClick={() => callbacks.onSelectArtifact(latest.report_artifact_id!)}>Открыть отчёт QA · v{latest.revision}</button></div>
        : <p className="field-hint">Отчёт QA ещё не сохранён.</p>}
    </section>
    {snapshot.run.injection_done ? <p className="field-hint">Доверенная тестовая инъекция · {testScenarioLabels[snapshot.run.test_scenario ?? 'standard']}.
      {snapshot.artifacts.filter(a => a.artifact_type === 'test_injection').map(a => <button key={a.id} type="button" className="document-link" data-artifact-id={a.id} onClick={() => callbacks.onSelectArtifact(a.id)}>Источник тестовой ошибки</button>)}</p> : null}
    <ol className="quality-cycles">{cycles.map(cycle => <CycleRow key={snapshot.run.id + ':' + cycle.id} snapshot={snapshot} cycle={cycle} {...callbacks} />)}</ol>
  </section>;
}
function CycleRow({ snapshot, cycle, onSelectArtifact, onSelectTool, onSelectTask }: Props & { snapshot: Snapshot; cycle: QualityCycleView }) {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const selected = snapshot.artifacts.find(artifact => artifact.id === documentId);
  return <li className="quality-cycle" data-cycle-id={cycle.id} data-cycle-iteration={cycle.iteration} data-cycle-status={cycle.status}>
    <div className="attempt-heading"><h4>{cycle.iteration === 0 ? 'Первичная проверка' : 'Исправление ' + cycle.iteration} · v{cycle.revision}</h4>
      <span className={'quality-status status-' + cycle.status}>{cycleLabels[cycle.status]}</span></div>
    <p className="field-hint">Итерация {cycle.iteration} · <time dateTime={cycle.created_at}>{formatTime(cycle.created_at, true)}</time>{cycle.finished_at ? ' · завершена ' + formatTime(cycle.finished_at, true) : ''}</p>
    {cycle.blocked_reason ? <p className="attempt-error" role="status">{cycle.blocked_reason}</p> : null}
    <ul className="quality-tools">{cycle.tool_run_ids.map(id => { const tool = snapshot.tool_runs?.find(item => item.id === id); return tool ? <li key={id}>
      <button type="button" className="document-link" data-tool-id={id} onClick={() => onSelectTool(id)}>{operationLabels[tool.operation_id]} · v{tool.snapshot_version}</button>
      <span className={'quality-status status-' + tool.status}>{toolLabels[tool.status]}</span>
    </li> : null; })}</ul>
    <div className="quality-links">
      {cycle.report_artifact_id ? <><button type="button" className="button secondary" aria-expanded={documentId === cycle.report_artifact_id}
        onClick={() => setDocumentId(documentId === cycle.report_artifact_id ? null : cycle.report_artifact_id!)}>Показать отчёт QA · итерация {cycle.iteration}</button>
        <button type="button" className="document-link" data-artifact-id={cycle.report_artifact_id} onClick={() => onSelectArtifact(cycle.report_artifact_id!)}>Источник TestReport · итерация {cycle.iteration}</button></> : <p className="field-hint">Отчёт QA ещё не сохранён.</p>}
      {cycle.bug_artifact_ids?.map((id, index) => <button type="button" key={id} className="document-link" data-artifact-id={id} onClick={() => onSelectArtifact(id)}>Bug {index + 1} · итерация {cycle.iteration}</button>)}
      {cycle.repair_task_id ? <button type="button" className="document-link" data-task-id={cycle.repair_task_id} onClick={() => onSelectTask(cycle.repair_task_id!)}>Задача исправления · итерация {cycle.iteration + 1}</button> : null}
      {cycle.followup_task_id ? <button type="button" className="document-link" data-task-id={cycle.followup_task_id} onClick={() => onSelectTask(cycle.followup_task_id!)}>Повторная QA · итерация {cycle.iteration + 1}</button> : null}
    </div>
    {selected ? <QualityArtifactDocument key={selected.id} artifact={selected} snapshot={snapshot} onSelectArtifact={onSelectArtifact} onSelectTool={onSelectTool} /> : null}
    <details className="quality-pins"><summary>Версия, хэши и источники цикла</summary><QualityPins cycle={cycle} onSelectArtifact={onSelectArtifact} />
      <button type="button" className="document-link" data-task-id={cycle.task_id} onClick={() => onSelectTask(cycle.task_id)}>Задача QA · итерация {cycle.iteration}</button>
      <ul className="input-versions">{cycle.tool_report_artifact_ids?.map(id => <li key={id}><button type="button" className="document-link" data-artifact-id={id} onClick={() => onSelectArtifact(id)}>ToolReport · {snapshot.tool_runs?.find(t => t.id === snapshot.artifacts.find(a => a.id === id)?.provenance?.producer_id)?.operation_id ?? id}</button></li>)}</ul>
    </details>
  </li>;
}
function QualityPins({ cycle, onSelectArtifact }: { cycle: QualityCycleView; onSelectArtifact: (id: string) => void }) {
  return <dl className="candidate-metadata"><div><dt>Manifest · v{cycle.revision}</dt><dd><button type="button" className="document-link" data-artifact-id={cycle.manifest_artifact_id} onClick={() => onSelectArtifact(cycle.manifest_artifact_id)}>Источник manifest</button></dd></div>
    {[[ 'ID цикла', cycle.id ], [ 'ID кандидата', cycle.candidate_id ], [ 'Профиль', cycle.profile_version ], [ 'Хэш профиля', cycle.profile_hash ],
      [ 'Внешние проверки', cycle.acceptance_suite_hash ], [ 'Каркас', cycle.template_hash ], [ 'Дерево файлов', cycle.tree_hash ], [ 'Manifest SHA-256', cycle.manifest_hash ]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
  </dl>;
}
export function QualityArtifactDocument({ snapshot, artifact, onSelectArtifact, onSelectTool }: {
  snapshot: Snapshot; artifact: ArtifactView; onSelectArtifact: (id: string) => void; onSelectTool: (id: string) => void;
}) {
  const resource = useQualityDocument(snapshot, artifact);
  const resolution = useBugResolution(snapshot, artifact);
  return <section className="quality-document" aria-label={'Документ QA ' + artifact.id}>
    <p className="document-path">{artifact.relative_path}</p><code className="document-hash">SHA-256 {artifact.content_hash}</code>
    {resource.loading ? <p role="status" className="field-hint">Проверяем хэш и ссылки документа QA…</p> : null}
    {resource.error ? <div className="resource-error" role="alert"><p>{resource.error}</p><button type="button" className="button secondary" onClick={resource.retry}><RefreshCw size={14} />Повторить загрузку</button></div> : null}
    {resource.data ? <QualityReportView document={resource.data} resolvedBy={resolution.data} onSelectArtifact={onSelectArtifact} onSelectTool={onSelectTool} /> : null}
    {artifact.artifact_type === 'bug' && resolution.loading ? <p role="status" className="field-hint">Проверяем связь с последующим отчётом…</p> : null}
    {artifact.artifact_type === 'bug' && resolution.error ? <p role="alert" className="resource-error">Не удалось проверить исправление Bug. {resolution.error}</p> : null}
  </section>;
}
export function QualityReportView({ document, onSelectArtifact, onSelectTool, resolvedBy }: { document: QualityDocument;
  onSelectArtifact: (id: string) => void; onSelectTool: (id: string) => void; resolvedBy?: QualityCycleView | null }) {
  const { cycle } = document;
  return <div className="quality-report-view"><h4>{document.kind === 'test_report' ? 'TestReport' : document.kind === 'bug' ? 'Bug' : 'ToolReport'} · итерация {cycle.iteration} · v{cycle.revision}</h4>
    {document.kind === 'test_report' ? <>
      <p className={'quality-status status-' + document.value.status}>{cycleLabels[document.value.status]}</p>
      <p className="field-hint">Карта фактических проверок. Сборка интерфейса не подтверждает его поведение; preview ещё не проверен.</p>
      <ul className="requirement-map">{document.value.requirements.map(check => <li key={check.requirement_id} data-requirement-id={check.requirement_id} data-requirement-status={check.status}>
        <div><strong>{check.requirement_id} · {requirementLabels[check.requirement_id]}</strong><span className={'quality-status status-' + check.status}>{checkLabels[check.status]}</span></div>
        <div className="quality-links">{check.tool_run_ids.map(id => <button type="button" key={id} className="document-link" data-tool-id={id} onClick={() => onSelectTool(id)}>Источник проверки</button>)}</div>
      </li>)}</ul>
      <h5>Предложенные тесты</h5><p className="field-hint">Это предложения QA; они не выполнялись и не входят в результат проверок.</p>
      {document.value.proposed_tests.length ? <ul className="quality-proposals">{document.value.proposed_tests.map((test, index) => <li key={index}><strong>{test.title}</strong><span className="field-hint">{test.requirement_ids.join(', ')} · Предложено</span></li>)}</ul> : <p className="field-hint">Дополнительные тесты не предложены.</p>}
      {document.value.resolves_bug_ids?.length ? <p>Исправленные Bug: {document.value.resolves_bug_ids.map(id => <button key={id} type="button" className="document-link" data-artifact-id={id} onClick={() => onSelectArtifact(id)}>Источник Bug</button>)}</p> : null}
    </> : document.kind === 'bug' ? <>
      <p className={'quality-status status-' + (resolvedBy ? 'passed' : 'failed')}>{resolvedBy ? 'Исправлен в итерации ' + resolvedBy.iteration : 'Зафиксирован дефект'}</p>
      <p>{document.value.summary}</p><p className="field-hint">Требования: {document.value.requirement_ids.join(', ')}. Исходный неизменяемый Bug хранит статус open.</p>
      <div className="quality-links">{document.value.tool_run_ids.map(id => <button type="button" key={id} className="document-link" data-tool-id={id} onClick={() => onSelectTool(id)}>Проверка, выявившая Bug</button>)}</div>
      {resolvedBy?.report_artifact_id ? <button type="button" className="document-link" data-artifact-id={resolvedBy.report_artifact_id} onClick={() => onSelectArtifact(resolvedBy.report_artifact_id!)}>Отчёт, подтверждающий исправление</button> : null}
    </> : <>
      <p className="field-hint">{String(document.value.operation_id)} · {String(document.value.status)} · код завершения {document.value.exit_code == null ? 'неизвестен' : String(document.value.exit_code)}</p>
      <pre className="artifact-content" tabIndex={0}>{String(document.value.diagnostic_excerpt)}</pre>
      <button type="button" className="document-link" data-tool-id={String(document.value.tool_run_id)} onClick={() => onSelectTool(String(document.value.tool_run_id))}>Полный вывод ToolRun</button>
    </>}
    <details className="quality-pins"><summary>Закреплённые хэши отчёта</summary><QualityPins cycle={cycle} onSelectArtifact={onSelectArtifact} /></details>
  </div>;
}
