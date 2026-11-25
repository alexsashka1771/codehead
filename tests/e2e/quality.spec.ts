import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactContent, DomainEvent, EventsPage, ProjectView, RunView, Snapshot } from '../../packages/contracts';
import { hydrateSnapshot, normalizeSnapshot, projectHistory } from '../../apps/frontend/src/state/projection';
import { validateQualityArtifactContent } from '../../apps/frontend/src/state/qualityContent';
import { cancelOpenRuns, captureSettled, commandHeaders, openProjectControls, waitForSceneReady } from './helpers';

test.skip(process.env.CODEHEAD_E2E_WITH_WORKER !== '1', 'Use --with-worker for real QA and repair execution.');

async function snapshot(request: APIRequestContext, runId: string): Promise<Snapshot> {
  const response = await request.get(`/api/runs/${runId}/snapshot`);
  expect(response.ok()).toBe(true); return response.json();
}
async function createQualityRun(request: APIRequestContext, scenario: 'standard' | 'repair_success') {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  const created = await request.post('/api/projects', { headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { name: 'QA clinic ' + randomUUID().slice(0, 6), description: 'Синтетические данные для реальной QA и ограниченного исправления.' } });
  expect(created.status()).toBe(201); const project: ProjectView = await created.json();
  const started = await request.post(`/api/projects/${project.id}/runs`, { headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { mode: 'test', test_scenario: scenario } });
  expect(started.status()).toBe(201); const run: RunView = await started.json();
  expect(run).toMatchObject({ workflow_version: 'clinic-v3', test_scenario: scenario, injection_done: false });
  await expect.poll(async () => (await snapshot(request, run.id)).decisions?.find(d => d.kind === 'architecture_approval' && d.status === 'open')?.id,
    { timeout: 40_000, intervals: [250, 500, 1000] }).toBeTruthy();
  const before = await snapshot(request, run.id);
  const decision = before.decisions!.find(d => d.status === 'open')!;
  const approved = await request.post(`/api/decisions/${decision.id}/resolve`, { headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { version: decision.version, choice: 'approve', comment: '' } });
  expect(approved.ok()).toBe(true);
  const count = scenario === 'repair_success' ? 2 : 1;
  await expect.poll(async () => {
    const current = await snapshot(request, run.id);
    return current.quality_cycles?.length === count && current.quality_cycles[count - 1].status === 'passed' && current.run.status === 'blocked';
  }, { timeout: 400_000, intervals: [500, 1000, 2000] }).toBe(true);
  return { project, run, final: await snapshot(request, run.id) };
}
async function assertRealHistory(request: APIRequestContext, final: Snapshot) {
  const events: DomainEvent[] = []; let cursor = 0; let pages = 0;
  while (cursor < final.last_event_seq) {
    const response = await request.get(`/api/runs/${final.run.id}/events?after_seq=${cursor}&limit=7`);
    expect(response.ok()).toBe(true); const result: EventsPage = await response.json();
    const prefix = result.events.filter(event => event.seq <= final.last_event_seq);
    expect(prefix.length).toBeGreaterThan(0); events.push(...prefix); cursor = prefix.at(-1)!.seq; pages++;
    hydrateSnapshot(projectHistory(events, cursor));
  }
  expect(pages).toBeGreaterThan(2);
  expect(normalizeSnapshot(projectHistory(events, final.last_event_seq))).toEqual(normalizeSnapshot(final));
  for (const cycle of final.quality_cycles!) {
    expect(cycle.tool_run_ids).toHaveLength(3);
    const tools = final.tool_runs!.filter(tool => cycle.tool_run_ids.includes(tool.id));
    expect(new Set(tools.map(tool => tool.operation_id)).size).toBe(3);
    for (const tool of tools) {
      expect(tool.qa_cycle_id).toBe(cycle.id); expect(tool.commands!.length).toBeGreaterThan(0);
      expect(tool.exit_code).toBe(tool.status === 'succeeded' ? 0 : 1); expect(tool.manifest_hash).toBe(cycle.manifest_hash);
    }
    for (const id of [...cycle.tool_report_artifact_ids!, cycle.report_artifact_id!, ...cycle.bug_artifact_ids!]) {
      const artifact = final.artifacts.find(item => item.id === id)!;
      const response = await request.get(`/api/artifacts/${id}/content`); expect(response.ok()).toBe(true);
      const content: ArtifactContent = await response.json();
      expect(createHash('sha256').update(content.content).digest('hex')).toBe(artifact.content_hash);
      expect((await validateQualityArtifactContent(final, artifact, content)).cycle.id).toBe(cycle.id);
    }
  }
}
async function openQuality(page: Page) {
  const tools = page.getByRole('tab', { name: 'Проверки', exact: true }); await tools.focus(); await page.keyboard.press('ArrowRight');
  const quality = page.getByRole('tab', { name: 'Качество QA', exact: true });
  await expect(quality).toBeFocused(); await expect(quality).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel'); await expect(panel).toBeVisible(); return panel;
}

test('preserves real repair history, immutable evidence, report sources and task links after reload', async ({ page, request }, testInfo) => {
  test.setTimeout(480_000);
  const { project, run, final } = await createQualityRun(request, 'repair_success');
  expect(final.run.injection_done).toBe(true); expect(final.usage?.request_count).toBe(8);
  expect(final.quality_cycles!.map(cycle => [cycle.iteration, cycle.status])).toEqual([[0, 'failed'], [1, 'passed']]);
  expect(final.tool_runs!.filter(tool => tool.status === 'failed')).toHaveLength(1);
  await assertRealHistory(request, final);
  await page.goto(`/?project=${project.id}&run=${run.id}`); await waitForSceneReady(page);
  let panel = await openQuality(page); await expect(panel.locator('.quality-cycle')).toHaveCount(2);
  await expect(panel).toContainText('Доверенная тестовая инъекция'); await expect(panel).toContainText('не подтверждает Live');
  await captureSettled(page, testInfo.outputPath('quality-history-1366.png'));
  const initial = final.quality_cycles![0]; const repaired = final.quality_cycles![1];
  const http = final.tool_runs!.find(tool => tool.qa_cycle_id === initial.id && tool.operation_id === 'test_backend')!;
  await panel.locator(`[data-cycle-id="${initial.id}"] [data-tool-id="${http.id}"]`).click();
  await expect(page.locator(`.tool-entry[data-tool-id="${http.id}"]`)).toHaveAttribute('data-tool-status', 'failed');
  await expect(page.locator('.tool-entry')).toHaveCount(1);
  panel = await openQuality(page);
  await panel.getByRole('button', { name: 'Показать отчёт QA · итерация 1', exact: true }).click();
  const report = panel.locator('.quality-report-view'); await expect(report).toContainText('Предложенные тесты');
  for (const requirement of ['REQ-006', 'REQ-008']) await expect(report.locator(`[data-requirement-id="${requirement}"]`)).toHaveAttribute('data-requirement-status', 'not_verified');
  await expect(report).toContainText('не выполнялись');
  await panel.getByRole('button', { name: 'Источник TestReport · итерация 1', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Артефакты', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.quality-document .quality-report-view')).toContainText('TestReport · итерация 1');
  panel = await openQuality(page);
  await panel.getByRole('button', { name: 'Bug 1 · итерация 0', exact: true }).click();
  const bug = page.locator('.quality-document'); await expect(bug).toContainText('Исправлен в итерации 1'); await expect(bug).toContainText('статус open');
  await bug.getByRole('button', { name: 'Проверка, выявившая Bug', exact: true }).click();
  await expect(page.locator(`.tool-entry[data-tool-id="${http.id}"]`)).toHaveAttribute('data-tool-status', 'failed');
  panel = await openQuality(page);
  await panel.getByRole('button', { name: 'Задача исправления · итерация 1', exact: true }).click();
  await expect(page.locator(`tr[data-task-id="${initial.repair_task_id}"]`)).toContainText('Исправление Backend');
  panel = await openQuality(page);
  await panel.getByRole('button', { name: 'Повторная QA · итерация 1', exact: true }).click();
  await expect(page.locator(`tr[data-task-id="${initial.followup_task_id}"]`)).toContainText('итерация исправления 1');
  await page.reload(); await waitForSceneReady(page); panel = await openQuality(page);
  await expect(panel.locator(`[data-cycle-id="${repaired.id}"]`)).toHaveAttribute('data-cycle-status', 'passed');
  await expect(panel.locator(`[data-cycle-id="${initial.id}"]`)).toHaveAttribute('data-cycle-status', 'failed');
  await openProjectControls(page);
  const selection = page.getByLabel('Сохранённый запуск'); await expect(selection).toHaveValue(run.id);
  // A cancelled independent run proves selection changes never reuse another run's QA evidence.
  const headers = await commandHeaders(request);
  const cancelled = await request.post(`/api/runs/${run.id}/commands`, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'cancel' } });
  expect(cancelled.ok()).toBe(true);
  await expect.poll(async () => (await snapshot(request, run.id)).run.status, { timeout: 20_000 }).toBe('cancelled');
  const nextResponse = await request.post(`/api/projects/${project.id}/runs`, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { mode: 'live' } });
  expect(nextResponse.status()).toBe(201); const next: RunView = await nextResponse.json();
  await page.reload(); await waitForSceneReady(page); await openProjectControls(page);
  await page.getByLabel('Сохранённый запуск').selectOption(next.id); panel = await openQuality(page);
  await expect(page.getByText('QA-циклов пока нет', { exact: true })).toBeVisible();
  await openProjectControls(page); await page.getByLabel('Сохранённый запуск').selectOption(run.id); panel = await openQuality(page);
  await expect(panel.locator('.quality-cycle')).toHaveCount(2);
});

test('offers default v3 scenarios and keyboard QA evidence at 430px with HTML fallback', async ({ page, request }, testInfo) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 430, height: 932 });
  await page.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      return type.includes('webgl') ? null : Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  const { project, run, final } = await createQualityRun(request, 'standard');
  expect(final.usage?.request_count).toBe(6); expect(final.run.injection_done).toBe(false);
  await assertRealHistory(request, final);
  await page.goto(`/?project=${project.id}&run=${run.id}`); await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  await openProjectControls(page);
  const scenario = page.getByRole('combobox', { name: 'Сценарий теста', exact: true });
  await expect(scenario).toBeVisible({ timeout: 8_000 });
  await expect(scenario).toBeEnabled({ timeout: 8_000 });
  await scenario.focus({ timeout: 8_000 }); await page.keyboard.press('ArrowDown');
  await expect(scenario).toHaveValue('repair_success');
  await expect(page.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  const panel = await openQuality(page);
  const show = panel.getByRole('button', { name: 'Показать отчёт QA · итерация 0', exact: true }); await show.focus(); await page.keyboard.press('Enter');
  const report = panel.locator('.quality-report-view'); await expect(report).toContainText('Не проверено');
  await expect(report.locator('[data-requirement-id="REQ-006"]')).toHaveAttribute('data-requirement-status', 'not_verified');
  await expect(report.locator('[data-requirement-id="REQ-008"]')).toHaveAttribute('data-requirement-status', 'not_verified');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Качество QA', exact: true }).focus();
  await expect(page.getByRole('tab', { name: 'Качество QA', exact: true })).toBeInViewport({ ratio: .9 });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  await page.screenshot({ path: testInfo.outputPath('quality-fallback-430.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  await expect((await openQuality(page)).locator('.quality-cycle')).toHaveCount(1);
});
