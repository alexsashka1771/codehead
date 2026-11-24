import type { Snapshot } from '../../../../packages/contracts';
import { formatTime, roleDetails } from './roles';
import { InputVersions } from './WorkerDetails';

const statusLabels = { assembling: 'Собирается', materializing: 'Материализуется', ready: 'Файлы сохранены', blocked: 'Материализация заблокирована', conflict: 'Конфликт основы' };

export function CandidatePanel({ snapshot, onSelectArtifact, onSelectAttempt }: {
  snapshot: Snapshot | null; onSelectArtifact: (id: string) => void; onSelectAttempt: (id: string) => void;
}) {
  const candidate = snapshot?.candidate;
  if (!candidate) return <div className="empty-state"><div><h3>Кандидат ещё не создан</h3><p>{snapshot?.run.workflow_version === 'clinic-v1'
    ? 'Запуск clinic-v1 сохраняет прежнюю границу PM → Architect → CTO. Исходный код кандидата в этой версии не создаётся.'
    : 'После принятия архитектуры Backend и Frontend сохранят исходные файлы и manifest кандидата.'}</p></div></div>;
  const artifactLink = (id: string, label: string) => <button type="button" className="document-link" data-artifact-id={id}
    onClick={() => onSelectArtifact(id)}>{label}</button>;
  return <section className="candidate-panel" aria-label="Сохранённый кандидат" data-candidate-id={candidate.id} data-candidate-revision={candidate.revision}>
    <div className="decision-heading"><h3>Clinic Demo · версия {candidate.revision}</h3><span className="quiet-label">{statusLabels[candidate.status]}</span></div>
    <p className="field-hint">QA, Runner и preview пока недоступны. Файлы доступны для просмотра; приложение из этой панели не запускается.</p>
    {candidate.blocked_reason ? <p className="attempt-error" role="status">{candidate.blocked_reason}</p> : null}
    <dl className="candidate-metadata">
      <div><dt>Профиль</dt><dd>{candidate.profile_version}</dd></div>
      <div><dt>ID кандидата</dt><dd><code>{candidate.id}</code></dd></div>
      <div><dt>Сохранён</dt><dd><time dateTime={candidate.updated_at}>{formatTime(candidate.updated_at, true)}</time></dd></div>
      <div><dt>Workspace версии</dt><dd><code>{candidate.workspace_path ?? 'Ещё не материализован'}</code></dd></div>
      <div><dt>Manifest</dt><dd>{artifactLink(candidate.manifest_artifact_id, 'Manifest кандидата · v' + candidate.revision)}{candidate.manifest_byte_size != null ? ' · ' + candidate.manifest_byte_size + ' байт' : ''}</dd></div>
    </dl>
    <details className="candidate-hashes"><summary>Хэши SHA-256 профиля и версии</summary><dl className="candidate-metadata">
      {[[ 'Профиль', candidate.profile_hash ], [ 'Внешние проверки', candidate.acceptance_suite_hash ],
        [ 'Технический каркас', candidate.template_hash ], [ 'Дерево файлов', candidate.tree_hash ],
        [ 'Manifest', candidate.manifest_hash ]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value ?? 'Неизвестно'}</code></dd></div>)}
    </dl></details>
    <h4>Исходный код · {candidate.files.length} файлов</h4>
    <ul className="candidate-files">{[...candidate.files].sort((a, b) => a.relative_path.localeCompare(b.relative_path, 'en')).map(file => <li key={file.artifact_id} data-candidate-file={file.relative_path}>
      <div className="candidate-file-heading">{artifactLink(file.artifact_id, file.relative_path)}<span className="quiet-label">v{file.version} · {file.byte_size} байт</span></div>
      <p className="field-hint">{file.origin === 'test_injected' ? 'ТЕСТ · заглушка · test_injected' : file.origin === 'template' ? 'Технический каркас · template' : 'Генерация · generated'} · {file.media_type}</p>
      <code className="document-hash">SHA-256 {file.content_hash}</code>
      <details><summary>Происхождение файла</summary><dl className="candidate-metadata">
        <div><dt>Производитель</dt><dd>{file.producer_id ? <button type="button" className="document-link" data-attempt-id={file.producer_id}
          onClick={() => onSelectAttempt(file.producer_id!)}>{file.producer_role ? roleDetails[file.producer_role].name : 'Роль неизвестна'} · {file.producer_id}</button> : 'Технический каркас'}</dd></div>
        <div><dt>Источник</dt><dd>{file.source}</dd></div>
        <div><dt>Родительская версия</dt><dd>{file.parent_artifact_id ? artifactLink(file.parent_artifact_id, file.parent_artifact_id) : 'Первый файл'}</dd></div>
        {file.parent_hash ? <div><dt>Хэш основы</dt><dd><code>{file.parent_hash}</code></dd></div> : null}
        <div><dt>Нормализация</dt><dd>{file.normalization_version ?? 'Неизвестно'}</dd></div>
      </dl><h4>Входные версии</h4><InputVersions versions={file.input_versions ?? {}} artifacts={snapshot?.artifacts} onSelectArtifact={onSelectArtifact} /></details>
    </li>)}</ul>
  </section>;
}
