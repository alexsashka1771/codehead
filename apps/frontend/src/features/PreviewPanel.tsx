import { Download, Monitor, Play, Square, X } from 'lucide-react';
import type { DeliveryView, PreviewSessionView, Snapshot } from '../../../../packages/contracts';
import { deliveryArchiveUrl } from '../app/api';
import { usePreview } from '../state/usePreview';
import { formatTime } from './roles';

const deliveryLabels: Record<DeliveryView['status'], string> = {
  created: 'Ожидает публикации', publishing: 'Фиксируется пакет', smoking: 'Идёт smoke-проверка',
  analyzing: 'DevOps проверяет результаты', ready: 'Пакет проверен', failed: 'Ошибка доставки',
  blocked: 'Доставка заблокирована', cancelled: 'Доставка отменена',
};
const sessionLabels: Record<PreviewSessionView['status'], string> = {
  created: 'В очереди', starting: 'Запускается', ready: 'Доступ проверяется', stopping: 'Останавливается',
  stopped: 'Остановлен', failed: 'Ошибка preview', uncertain: 'Исход неизвестен',
};

interface Props {
  snapshot: Snapshot | null;
  connected: boolean;
  availabilityReason?: string | null;
  onSelectArtifact: (id: string) => void;
  onSelectTool: (id: string) => void;
}

export function PreviewPanel({ snapshot, connected, availabilityReason, onSelectArtifact, onSelectTool }: Props) {
  const preview = usePreview(snapshot, connected);
  const delivery = snapshot?.delivery;
  const session = preview.session;
  if (!snapshot || !delivery) {
    const reason = !snapshot ? 'Выберите сохранённый запуск.'
      : snapshot.run.workflow_version !== 'clinic-v4'
        ? `История ${snapshot.run.workflow_version} сохранена. Пакет и локальный preview доступны в новых тестовых запусках clinic-v4.`
        : snapshot.run.mode !== 'test' ? 'Локальная доставка доступна для тестового кандидата.'
          : snapshot.run.blocked_reason ?? 'Пакет появится после успешного цикла QA.';
    return <section className="empty-state" aria-label="Пакет и локальный preview"><Monitor size={26} aria-hidden="true" />
      <div><h3>Пакет и локальный preview</h3><p>{reason}</p></div>
    </section>;
  }

  const downloadable = delivery.status === 'ready' && snapshot.run.status === 'succeeded';
  const ready = preview.openedOrigin || preview.canOpen;
  const status = ready ? preview.openedOrigin ? 'Открыт' : 'Готов к открытию'
    : session?.status === 'ready' && !preview.checking ? 'Доступ утрачен'
      : session ? sessionLabels[session.status] : 'Не запущен';
  const openLabel = preview.openedOrigin ? 'Закрыть' : 'Открыть';
  const artifacts = [
    ['Отчёт QA', delivery.qa_report_artifact_id], ['Отчёт smoke', delivery.smoke_report_artifact_id],
    ['Пакет DevOps', delivery.deployment_package_artifact_id], ['Runbook', delivery.runbook_artifact_id],
  ];
  const tools = [
    ['Проверка сборки', delivery.build_tool_run_id], ['Проверка smoke', delivery.smoke_tool_run_id],
    ['Запуск сессии', session?.start_tool_run_id], ['Остановка сессии', session?.stop_tool_run_id],
  ];

  return <section className="preview-panel" aria-label="Пакет и локальный preview" data-run-id={snapshot.run.id}
    data-package-id={delivery.id} data-delivery-status={delivery.status} data-preview-status={session?.status} data-preview-version={session?.version}>
    <div className="preview-grid">
      <section className="preview-package">
        <div className="preview-heading"><h3>Пакет Clinic Demo · v{delivery.revision}</h3>
          <span className="preview-indicator" data-state={delivery.status}>{deliveryLabels[delivery.status]}</span></div>
        {delivery.package_file_count != null ? <p className="preview-meta">Генерация {delivery.package_generation} · {delivery.package_file_count} файлов
          {delivery.package_archive_byte_size != null ? ` · ZIP ${delivery.package_archive_byte_size.toLocaleString('ru-RU')} байт` : ''}</p> : null}
        {delivery.blocked_reason ? <p className="attempt-error" role="status">{delivery.blocked_reason}</p> : null}
        {downloadable ? <a className="button secondary preview-download" href={deliveryArchiveUrl(snapshot.run.id, delivery.id)} download>
          <Download size={15} aria-hidden="true" />Скачать ZIP</a> : null}
      </section>
      <section className="preview-runtime">
        <div className="preview-heading"><h3>Локальный preview</h3>
          <span className="preview-indicator" role="status" data-state={ready ? 'ready' : session?.status === 'ready' ? 'unavailable' : session?.status}>{status}</span></div>
        {session ? <p className="preview-meta">Версия сессии {session.version}{session.ready_at ? <> · запуск <time dateTime={session.ready_at}>{formatTime(session.ready_at, true)}</time></> : null}</p> : null}
        {downloadable ? <div className="preview-actions">
          {preview.canStop || session && ['created', 'starting', 'ready', 'stopping'].includes(session.status)
            ? <button type="button" className="button secondary" disabled={!preview.canStop} onClick={() => void preview.command('stop')}>
              <Square size={14} aria-hidden="true" />Остановить preview</button>
            : <button type="button" className="button secondary" disabled={!preview.canStart || Boolean(availabilityReason)} onClick={() => void preview.command('start')}>
              <Play size={14} aria-hidden="true" />Запустить preview</button>}
          {session?.status === 'ready' ? <button type="button" className={`button ${preview.openedOrigin ? 'secondary' : 'primary'}`}
            disabled={!preview.openedOrigin && !preview.canOpen} onClick={preview.openedOrigin ? preview.close : () => void preview.open()}>
            {preview.openedOrigin ? <X size={16} aria-hidden="true" /> : <Monitor size={16} aria-hidden="true" />}{openLabel}
          </button> : null}
        </div> : null}
        {preview.commandPhase ? <p className="field-hint" role="status">{preview.commandPhase === 'sending' ? 'Сохраняем команду…' : 'Команда принята. Ожидаем событие сервера.'}</p> : null}
        {preview.commandError ? <p className="attempt-error" role="alert">{preview.commandError}</p> : null}
        {session?.error_message || session?.error_code ? <p className="attempt-error" role="status">{session.error_message ?? session.error_code}</p> : null}
        {!connected && downloadable ? <p className="field-hint" role="status">Соединение с журналом восстанавливается.</p> : null}
        {connected && availabilityReason && !session ? <p className="field-hint" role="status">{availabilityReason}</p> : null}
        {preview.accessReason && session?.status === 'ready' ? <p className="field-hint" role="status">{preview.accessReason}</p> : null}
      </section>
    </div>
    {preview.openedOrigin ? <iframe className="preview-frame" title="Clinic Demo · Preview" src={preview.openedOrigin}
      sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" /> : null}
    <div className="preview-evidence">
      <div className="preview-sources" role="group" aria-label="Источники доставки">
        {artifacts.map(([label, id]) => id ? <button type="button" className="document-link" key={id} data-artifact-id={id}
          onClick={() => onSelectArtifact(id)}>{label}</button> : null)}
        {tools.map(([label, id]) => id ? <button type="button" className="document-link" key={id} data-tool-id={id}
          onClick={() => onSelectTool(id)}>{label}</button> : null)}
      </div>
      {delivery.package_archive_hash ? <details className="preview-hashes"><summary>Контрольные суммы</summary>
        <dl className="candidate-metadata">
          <div><dt>ZIP · SHA-256</dt><dd><code>{delivery.package_archive_hash}</code></dd></div>
          <div><dt>Дерево пакета · SHA-256</dt><dd><code>{delivery.package_tree_hash}</code></dd></div>
          <div><dt>Manifest пакета · SHA-256</dt><dd><code>{delivery.package_manifest_hash}</code></dd></div>
        </dl>
      </details> : null}
      <p className="field-hint">Тестовый кандидат · loopback · изоляция process_only</p>
    </div>
  </section>;
}
