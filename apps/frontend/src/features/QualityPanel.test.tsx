import { renderToStaticMarkup } from 'react-dom/server';
import { Children, isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { QualityPanel, QualityReportView } from './QualityPanel';
import { makeBug, makeQualitySnapshot, makeTestReport } from '../state/qualityFixtures';
import { CandidatePanel } from './CandidatePanel';
import { ArtifactBrowser, AttemptList } from './WorkerDetails';
import { Inspector } from './Inspector';

const callbacks = { onSelectArtifact() {}, onSelectTool() {}, onSelectTask() {} };
function findButton(node: ReactNode, label: string): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
  if (node.type === 'button' && renderToStaticMarkup(node).includes(label)) return node.props.onClick;
  for (const child of Children.toArray(node.props.children)) {
    const action = findButton(child, label);
    if (action) return action;
  }
}
describe('QA audit interface', () => {
  it('opens the selected real ToolRun from a role artifact source link', () => {
    const snapshot = makeQualitySnapshot(); const id = snapshot.tool_runs![1].id;
    const markup = renderToStaticMarkup(<Inspector snapshot={snapshot} events={[]} capabilities={null} loading={false}
      expanded onExpandedChange={() => {}} connected pending={false} onResolve={async () => true} toolRequest={{ runId: snapshot.run.id, id }} />);
    expect(markup).toContain('data-tool-id="' + id + '"'); expect(markup.match(/class="tool-entry"/g)).toHaveLength(1);
  });
  it('orders historical QA cycles and offers real source/tool/repair links', () => {
    const snapshot = makeQualitySnapshot(2); snapshot.quality_cycles!.reverse();
    const markup = renderToStaticMarkup(<QualityPanel snapshot={snapshot} {...callbacks} />);
    expect(markup.indexOf('Первичная проверка')).toBeLessThan(markup.indexOf('Исправление 1'));
    expect(markup).toContain('data-tool-id="tool-0-1"'); expect(markup).toContain('data-task-id="task-repair-1"');
    expect(markup).toContain('TestReport'); expect(markup).toContain('Bug'); expect(markup).toContain('v3'); expect(markup).toContain('v4');
    expect(markup).toContain('не подтверждает Live');
  });
  it('leads failed history with the latest checked version and opens its report from unsorted cycles', () => {
    const snapshot = makeQualitySnapshot(3); const [initial, repair, latest] = snapshot.quality_cycles!;
    snapshot.quality_cycles = [repair, latest, initial]; snapshot.candidate!.revision = 99;
    const onSelectArtifact = vi.fn();
    const panel = QualityPanel({ snapshot, ...callbacks, onSelectArtifact });
    const markup = renderToStaticMarkup(panel);
    const summary = markup.match(/<section[^>]*aria-label="Последняя проверка"[^>]*>(.*?)<\/section>/)?.[1];
    expect(summary).toBeDefined(); expect(summary).toContain('v5'); expect(summary).toContain('Проверки пройдены');
    expect(markup.indexOf('Последняя проверка')).toBeLessThan(markup.indexOf('Первичная проверка'));
    expect(markup.indexOf('Первичная проверка')).toBeLessThan(markup.indexOf('Исправление 1'));
    expect(markup.indexOf('Исправление 1')).toBeLessThan(markup.indexOf('Исправление 2'));
    expect(summary).toContain('data-artifact-id="report-2"'); expect(summary).not.toContain('v99');
    const openReport = findButton(panel, 'Открыть отчёт QA');
    expect(openReport).toBeDefined(); openReport!(); expect(onSelectArtifact).toHaveBeenCalledExactlyOnceWith('report-2');
  });
  it('shows the latest ongoing QA state without borrowing an earlier report or successful tool outcome', () => {
    const snapshot = makeQualitySnapshot(2); snapshot.quality_cycles![0].status = 'passed';
    const latest = snapshot.quality_cycles![1]; latest.status = 'analyzing'; latest.report_artifact_id = null;
    const markup = renderToStaticMarkup(<QualityPanel snapshot={snapshot} {...callbacks} />);
    const summary = markup.match(/<section[^>]*aria-label="Последняя проверка"[^>]*>(.*?)<\/section>/)?.[1];
    expect(summary).toBeDefined(); expect(summary).toContain('v4'); expect(summary).toContain('QA анализирует');
    expect(summary).toContain('Отчёт QA ещё не сохранён.'); expect(summary).not.toContain('Проверки пройдены');
    expect(summary).not.toContain('data-artifact-id='); expect(summary).not.toContain('Открыть отчёт QA');
  });
  it('labels unverified UI/preview and proposals without colouring them passed', () => {
    const cycle = makeQualitySnapshot().quality_cycles![0];
    const markup = renderToStaticMarkup(<QualityReportView document={{ kind: 'test_report', cycle, value: makeTestReport(cycle) }} {...callbacks} />);
    expect(markup).toContain('Не проверено'); expect(markup).toContain('REQ-006'); expect(markup).toContain('REQ-008');
    expect(markup).toContain('Предложенные тесты'); expect(markup).toContain('не выполнялись');
    expect(markup).toMatch(/data-requirement-id="REQ-006"[^>]*data-requirement-status="not_verified"/);
  });
  it('shows historical Bug resolution from a later report without rewriting its open artifact', () => {
    const snapshot = makeQualitySnapshot(2); const cycle = snapshot.quality_cycles![0]; const bug = makeBug(cycle);
    const markup = renderToStaticMarkup(<QualityReportView document={{ kind: 'bug', cycle, value: bug }} resolvedBy={snapshot.quality_cycles![1]} {...callbacks} />);
    expect(markup).toContain('Исправлен в итерации 1'); expect(markup).toContain('open'); expect(bug.status).toBe('open');
  });
  it('distinguishes trusted test injection from template and repair iteration from attempt number', () => {
    const snapshot = makeQualitySnapshot(2); const file = snapshot.candidate!.files[0]; file.producer_id = null;
    const source = snapshot.artifacts.find(a => a.id === file.artifact_id)!; source.provenance!.producer_id = null;
    const candidate = renderToStaticMarkup(<CandidatePanel snapshot={snapshot} onSelectArtifact={() => {}} onSelectAttempt={() => {}} />);
    const artifacts = renderToStaticMarkup(<ArtifactBrowser artifacts={[source]} selectedId={null} onSelect={() => {}} />);
    expect(candidate).toContain('Доверенная тестовая инъекция'); expect(artifacts).toContain('Доверенная тестовая инъекция');
    const attempts = renderToStaticMarkup(<AttemptList attempts={snapshot.agent_runs!} tasks={snapshot.tasks} artifacts={snapshot.artifacts} />);
    expect(attempts).toContain('Итерация исправления 1'); expect(attempts).toContain('Попытка 1');
  });
  it('adds a keyboard labelled QA tab and a truthful empty legacy state', () => {
    const markup = renderToStaticMarkup(<Inspector snapshot={null} events={[]} capabilities={null} loading={false}
      expanded onExpandedChange={() => {}} connected pending={false} onResolve={async () => true} />);
    expect(markup).toContain('aria-label="Качество QA"');
    const empty = renderToStaticMarkup(<QualityPanel snapshot={null} {...callbacks} />);
    expect(empty).toContain('QA-циклов пока нет');
  });
});
