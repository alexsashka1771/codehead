import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionView } from '../../../../packages/contracts';
import { RunPanel } from './RunPanel';
import { ArtifactBrowser, AttemptList, DecisionCard, ArtifactText, TraceText } from './WorkerDetails';
import { makeWorkerSnapshot } from '../state/workerFixtures';
import { makeCandidateSnapshot } from '../state/candidateFixtures';

describe('worker controls and audit content', () => {
  it('explains the QA boundary after approving a v3 architecture', () => {
    const snapshot = makeWorkerSnapshot();
    const markup = renderToStaticMarkup(<DecisionCard decision={snapshot.decisions![0]} artifacts={snapshot.artifacts}
      pending={false} connected sourceEnabled qualityEnabled onResolve={async () => true} onSelectArtifact={() => {}} />);
    expect(markup).toContain('QA'); expect(markup).not.toContain('QA и preview пока недоступны');
  });
  it('offers labelled scenarios and explains v3 real QA without enabling Live', () => {
    const snapshot = makeCandidateSnapshot(); snapshot.run.workflow_version = 'clinic-v3';
    const markup = renderToStaticMarkup(<RunPanel run={snapshot.run} runs={[snapshot.run]} snapshot={snapshot}
      loading={false} pending={null} hasProject connected usage={snapshot.usage!} testAvailable
      onSelectRun={() => {}} onStart={() => {}} onStartTest={() => {}} onCommand={() => {}} />);
    expect(markup).toContain('Сценарий теста'); expect(markup).toContain('repair_success'); expect(markup).toContain('repair_blocked');
    expect(markup).toContain('реальные проверки Python'); expect(markup).toContain('до двух исправлений');
    expect(markup).not.toContain('QA и preview пока недоступны');
    expect(markup).toMatch(/disabled=""[^>]*>.*?Запустить<\/button>/);
  });
  it('explains the five-role candidate workflow for v2 while retaining the three-role legacy boundary', () => {
    const render = (snapshot: ReturnType<typeof makeCandidateSnapshot>) => renderToStaticMarkup(<RunPanel run={snapshot.run}
      runs={[snapshot.run]} snapshot={snapshot} loading={false} pending={null} hasProject connected usage={snapshot.usage!} testAvailable
      onSelectRun={() => {}} onStart={() => {}} onStartTest={() => {}} onCommand={() => {}} />);
    const markup = render(makeCandidateSnapshot());
    expect(markup).toContain('Backend');
    expect(markup).toContain('Frontend');
    expect(render(makeWorkerSnapshot())).toContain('PM → Architect → CTO.');
  });

  it('explains architecture approval using the selected v2 run without claiming the legacy boundary', () => {
    const snapshot = makeWorkerSnapshot();
    const markup = renderToStaticMarkup(<DecisionCard decision={snapshot.decisions![0]} artifacts={snapshot.artifacts}
      pending={false} connected sourceEnabled onResolve={async () => true} onSelectArtifact={() => {}} />);
    expect(markup).toContain('Backend');
    expect(markup).toContain('Frontend');
    expect(markup).not.toContain('Разработка Clinic Demo на следующем этапе пока недоступна.');
  });

  it('labels source code and manifest by purpose while retaining their exact immutable relative paths', () => {
    const snapshot = makeCandidateSnapshot();
    const source = snapshot.artifacts.find(artifact => artifact.id === snapshot.candidate!.files[0].artifact_id)!;
    const manifest = snapshot.artifacts.find(artifact => artifact.id === snapshot.candidate!.manifest_artifact_id)!;
    const markup = renderToStaticMarkup(<ArtifactBrowser artifacts={[source, manifest]} selectedId={null} onSelect={() => {}} />);
    expect(markup).toContain('Исходный код');
    expect(markup).toContain('Manifest кандидата');
    expect(markup).toContain(source.relative_path);
    expect(markup).toContain(manifest.relative_path);
    expect(markup).toContain('aria-label="Исходный код · ' + source.relative_path + ' · v' + source.version + '"');
  });

  it('offers an explicit test action and labels zero cost as a test source', () => {
    const snapshot = makeWorkerSnapshot();
    const markup = renderToStaticMarkup(<RunPanel run={snapshot.run} runs={[snapshot.run]} snapshot={snapshot}
      loading={false} pending={null} hasProject connected usage={snapshot.usage!} testAvailable
      onSelectRun={() => {}} onStart={() => {}} onStartTest={() => {}} onCommand={() => {}} />);
    expect(markup).toContain('Запустить тест');
    expect(markup).toContain('ТЕСТ · заглушка');
    expect(markup).toContain('Тестовый источник');
    expect(markup).toContain('$0.0000');
  });

  it('renders unknown live cost without claiming zero external spending', () => {
    const snapshot = makeWorkerSnapshot();
    snapshot.run.mode = 'live';
    const markup = renderToStaticMarkup(<RunPanel run={snapshot.run} runs={[snapshot.run]} snapshot={null}
      loading={false} pending={null} hasProject connected usage={null} testAvailable
      onSelectRun={() => {}} onStart={() => {}} onStartTest={() => {}} onCommand={() => {}} />);
    expect(markup).toContain('неизвестны');
    expect(markup).not.toContain('$0.0000');
  });

  it('shows a pending cancellation without offering another control command', () => {
    const snapshot = makeWorkerSnapshot();
    snapshot.run.status = 'running'; snapshot.run.blocked_reason = null; snapshot.run.cancel_requested = true;
    const markup = renderToStaticMarkup(<RunPanel run={snapshot.run} runs={[snapshot.run]} snapshot={snapshot}
      loading={false} pending={null} hasProject connected usage={snapshot.usage!} testAvailable
      onSelectRun={() => {}} onStart={() => {}} onStartTest={() => {}} onCommand={() => {}} />);
    expect(markup).toContain('Отмена запрошена');
    expect(markup).not.toContain('>Пауза</button>');
    expect(markup).not.toContain('Отменить запуск');
  });

  it('escapes artifact and trace content instead of parsing executable markup', () => {
    const content = '<script>alert("artifact")</script><img src=x onerror=alert(1)>';
    const artifact = renderToStaticMarkup(<ArtifactText content={content} />);
    const trace = renderToStaticMarkup(<TraceText trace={{ attempt_id: 'attempt-one', prompt: content,
      raw_response: content, parameters: {}, input_versions: {}, stop_reason: 'completed', redaction_version: 'v1' }} />);
    for (const markup of [artifact, trace]) {
      expect(markup).not.toContain('<script>');
      expect(markup).not.toContain('<img');
      expect(markup).toContain('&lt;script&gt;');
    }
  });

  it('explains missing trace text without fabricating an empty successful response', () => {
    const markup = renderToStaticMarkup(<TraceText trace={{ attempt_id: 'attempt-one', prompt: null,
      raw_response: null, parameters: {}, input_versions: {}, stop_reason: null, redaction_version: 'v1' }} />);
    expect(markup).toContain('Prompt недоступен');
    expect(markup).toContain('Ответ недоступен');
  });

  it('keeps an uncertain retry disabled until its risks and explanation are acknowledged', () => {
    const decision: DecisionView = { ...makeWorkerSnapshot().decisions![0], kind: 'uncertain_outcome',
      choices: ['confirm_failed', 'retry_with_risk'], title: 'Неизвестный исход', artifact_ids: [] };
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} artifacts={[]} pending={false}
      connected onResolve={() => Promise.resolve(true)} onSelectArtifact={() => {}} />);
    expect(markup).toContain('дублирующий вызов');
    expect(markup).toContain('минимум 10 символов');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toMatch(/disabled=""[^>]*>[^<]*Повторить с риском/);
  });

  it('identifies the role and persisted invocation times in the attempt audit', () => {
    const snapshot = makeWorkerSnapshot();
    const markup = renderToStaticMarkup(<AttemptList attempts={snapshot.agent_runs!} artifacts={snapshot.artifacts} tasks={snapshot.tasks} />);
    expect(markup).toContain('CTO · Попытка 1');
    expect(markup).toContain('Начало вызова');
    expect(markup).toContain('Завершение');
    expect(markup).toContain('2026-11-24T10:00:01.123456Z');
  });

  it('offers a fresh file proposal for a conflict without claiming architecture approval', () => {
    const decision: DecisionView = { ...makeWorkerSnapshot().decisions![0], kind: 'file_conflict',
      choices: ['retry_files', 'reject'], title: 'Основа файлов изменилась', artifact_ids: [] };
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} artifacts={[]} pending={false}
      connected onResolve={() => Promise.resolve(true)} onSelectArtifact={() => {}} />);
    expect(markup).toContain('Предложить файлы заново');
    expect(markup).toContain('Отклонить набор файлов');
    expect(markup).toContain('актуальную основу');
    expect(markup).not.toContain('Принятие завершит оценку CTO');
  });

  it('reports a rejected file batch as a file decision', () => {
    const decision: DecisionView = { ...makeWorkerSnapshot().decisions![0], kind: 'file_conflict',
      status: 'resolved', choice: 'reject', title: 'Основа файлов изменилась', artifact_ids: [] };
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} artifacts={[]} pending={false}
      connected onResolve={() => Promise.resolve(true)} onSelectArtifact={() => {}} />);
    expect(markup).toContain('Набор файлов отклонён');
    expect(markup).not.toContain('Архитектура отклонена');
  });

  it('identifies a document by its purpose while retaining its immutable storage path', () => {
    const artifact = { ...makeWorkerSnapshot().artifacts[0], relative_path: 'runs/run-id/artifacts/artifact-id.md' };
    const markup = renderToStaticMarkup(<ArtifactBrowser artifacts={[artifact]} selectedId={null} onSelect={() => {}} />);
    expect(markup).toContain('Оценка CTO');
    expect(markup).toContain(artifact.relative_path);
  });

  it('explains a nonblocking old-outcome reconciliation without offering another risky retry', () => {
    const decision = { ...makeWorkerSnapshot().decisions![0], blocking: false, kind: 'uncertain_outcome' as const,
      choices: ['confirm_failed'], title: 'Сверить предыдущую отправку', artifact_ids: [] };
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} artifacts={[]} pending={false}
      connected onResolve={() => Promise.resolve(true)} onSelectArtifact={() => {}} />);
    expect(markup).toContain('не останавливает новую работу');
    expect(markup).toContain('Пауза и отмена');
    expect(markup).not.toContain('Повторить с риском');
  });
});
