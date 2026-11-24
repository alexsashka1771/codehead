import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRunView, ArtifactContent, DecisionView, DomainEvent, EventsPage, ProjectView, RunView, Snapshot } from '../../packages/contracts';
import { normalizeSnapshot, projectHistory } from '../../apps/frontend/src/state/projection';
import { cancelOpenRuns, captureSettled, commandHeaders, openProjectControls, waitForSceneReady } from './helpers';

test.skip(process.env.CODEHEAD_E2E_WITH_WORKER !== '1', 'Use --with-worker to start the isolated test worker.');

async function createProject(request: APIRequestContext) {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  await expect.poll(async () => {
    const projectsResponse = await request.get('/api/projects');
    expect(projectsResponse.ok()).toBe(true);
    const projects = await projectsResponse.json() as ProjectView[];
    const responses = await Promise.all(projects.map(project => request.get(`/api/projects/${project.id}/runs`)));
    const histories: RunView[][] = [];
    for (const response of responses) { expect(response.ok()).toBe(true); histories.push(await response.json()); }
    return histories.flat().every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status));
  }, { timeout: 15_000 }).toBe(true);
  const response = await request.post('/api/projects', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { name: 'Worker clinic ' + randomUUID().slice(0, 6),
      description: 'Синтетические врачи, пациенты и запись на приём. Проверка настоящего тестового workflow.' },
  });
  expect(response.status()).toBe(201);
  return { project: await response.json() as ProjectView, headers };
}

async function snapshot(request: APIRequestContext, runId: string): Promise<Snapshot> {
  const response = await request.get(`/api/runs/${runId}/snapshot`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function startTest(page: Page, projectId: string, fallback = false, settleUi = true): Promise<RunView> {
  await page.goto(`/?project=${projectId}`);
  if (fallback) await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  else await waitForSceneReady(page);
  await openProjectControls(page);
  const start = page.getByRole('button', { name: 'Запустить тест', exact: true });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}/runs`)
    && response.request().method() === 'POST');
  await start.focus(); await page.keyboard.press('Enter');
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const run = await response.json() as RunView;
  expect(run.mode).toBe('test');
  if (settleUi) {
    await expect(page.getByRole('status', { name: 'Режим запуска', exact: true })).toHaveText('ТЕСТ · заглушка');
    await expect(page.getByText('События подключены', { exact: true })).toBeVisible();
  }
  return run;
}

async function waitForDecision(request: APIRequestContext, runId: string): Promise<Snapshot> {
  await expect.poll(async () => (await snapshot(request, runId)).decisions?.filter(decision => decision.status === 'open').length,
    { timeout: 30_000, intervals: [100, 250, 500] }).toBe(1);
  return snapshot(request, runId);
}

async function openDecision(page: Page, decision: DecisionView) {
  const tab = page.getByRole('tab', { name: 'Решения автора', exact: true });
  await tab.focus(); await page.keyboard.press('Enter');
  const card = page.locator(`.worker-data .decision-card[data-decision-id="${decision.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-decision-version', String(decision.version));
  return card;
}

test('persists first-role documents and decision; candidate approval does not call CTO again', async ({ page, request }, testInfo) => {
  const { project, headers } = await createProject(request);
  const run = await startTest(page, project.id);
  const before = await waitForDecision(request, run.id);
  expect(before.run.status).toBe('blocked');
  expect(before.tasks.find(task => task.role === 'cto')?.status).toBe('waiting_for_decision');
  expect(before.agent_runs).toHaveLength(3);
  expect(before.agent_runs?.every(attempt => attempt.status === 'succeeded')).toBe(true);
  expect(before.artifacts.map(artifact => artifact.artifact_type)).toEqual(expect.arrayContaining(['requirements', 'architecture', 'api_contract', 'decision']));
  expect(before.artifacts.every(artifact => artifact.provenance?.origin === 'test')).toBe(true);
  expect(before.usage).toMatchObject({ source: 'test', request_count: 3, cost_usd: 0 });

  const decision = before.decisions![0];
  const stale = await request.post(`/api/decisions/${decision.id}/resolve`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { version: decision.version + 1, choice: 'approve', comment: '' },
  });
  expect(stale.status()).toBe(409);
  expect((await snapshot(request, run.id)).decisions![0]).toEqual(decision);

  const requirements = before.artifacts.find(artifact => artifact.artifact_type === 'requirements')!;
  const contentResponse = await request.get(`/api/artifacts/${requirements.id}/content`);
  expect(contentResponse.ok()).toBe(true);
  const content: ArtifactContent = await contentResponse.json();
  expect(content.artifact_id).toBe(requirements.id);
  expect(createHash('sha256').update(content.content, 'utf8').digest('hex')).toBe(requirements.content_hash);
  expect(Buffer.byteLength(content.content, 'utf8')).toBe(content.byte_size);
  await page.getByRole('tab', { name: 'Артефакты', exact: true }).click();
  await page.locator(`.inspector-content .artifact-select[data-artifact-id="${requirements.id}"]`).click();
  await expect(page.locator('.artifact-document .artifact-content')).toContainText(project.name);
  await expect(page.locator('.document-provenance')).toContainText('ТЕСТ · заглушка');

  await page.getByRole('button', { name: 'Выбрать роль: CTO', exact: true }).click();
  await expect(page.locator('.role-inspector .attempt-entry')).toHaveCount(1);
  await page.locator('.role-inspector').getByRole('button', { name: 'Открыть trace', exact: true }).click();
  await expect(page.locator('.role-inspector .trace-content')).toContainText(project.name);
  await page.keyboard.press('Escape');
  await openDecision(page, decision);
  await captureSettled(page, testInfo.outputPath('worker-decision-1366.png'));
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(page.getByRole('status', { name: 'Режим запуска', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Решения автора', exact: true })).toBeInViewport({ ratio: 0.95 });
  await expect(page.getByRole('button', { name: 'Принять архитектуру', exact: true })).toBeInViewport({ ratio: 0.95 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await captureSettled(page, testInfo.outputPath('worker-decision-430.png'));
  await page.setViewportSize({ width: 1366, height: 768 });
  const card = await openDecision(page, decision);
  await card.getByRole('button', { name: 'Принять архитектуру', exact: true }).click();
  await expect.poll(async () => (await snapshot(request, run.id)).tasks.find(task => task.role === 'cto')?.status,
    { timeout: 15_000 }).toBe('succeeded');
  await expect.poll(async () => (await snapshot(request, run.id)).candidate?.status,
    { timeout: 30_000 }).toBe('ready');
  await expect.poll(async () => (await snapshot(request, run.id)).run.status, { timeout: 15_000 }).toBe('blocked');
  const after = await snapshot(request, run.id);
  expect(after.run.status).toBe('blocked');
  expect(after.run.blocked_reason).toMatch(/QA.*preview/iu);
  expect(after.decisions![0]).toMatchObject({ status: 'resolved', choice: 'approve', version: decision.version + 1 });
  expect(after.agent_runs).toHaveLength(5);
  for (const attempt of before.agent_runs!) expect(after.agent_runs!.find(item => item.id === attempt.id)).toEqual(attempt);
  expect(after.usage?.request_count).toBe(5);
  const attemptsResponse = await request.get(`/api/runs/${run.id}/agent-runs`);
  expect(attemptsResponse.ok()).toBe(true);
  expect(await attemptsResponse.json() as AgentRunView[]).toHaveLength(5);

  const events: DomainEvent[] = [];
  let cursor = 0;
  for (;;) {
    const response = await request.get(`/api/runs/${run.id}/events?after_seq=${cursor}&limit=5`);
    expect(response.ok()).toBe(true);
    const page: EventsPage = await response.json();
    events.push(...page.events); cursor = page.next_after_seq;
    if (!page.has_more) break;
  }
  expect(normalizeSnapshot(projectHistory(events, after.last_event_seq))).toEqual(normalizeSnapshot(after));
});

test('pauses an in-flight test and cancels only after its known outcome', async ({ page, request }) => {
  const { project, headers } = await createProject(request);
  const run = await startTest(page, project.id, false, false);
  await expect.poll(async () => (await snapshot(request, run.id)).agent_runs?.some(attempt => attempt.status === 'running'),
    { timeout: 15_000, intervals: [50, 100] }).toBe(true);
  const pause = await request.post(`/api/runs/${run.id}/commands`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'pause' },
  });
  expect(pause.ok()).toBe(true);
  expect((await pause.json() as RunView).status).toBe('pausing');
  await openProjectControls(page);
  await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeEnabled({ timeout: 15_000 });
  const paused = await snapshot(request, run.id);
  expect(paused.run.status).toBe('paused');
  expect(paused.agent_runs?.some(attempt => attempt.status === 'running')).toBe(false);
  const resume = await request.post(`/api/runs/${run.id}/commands`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'resume' },
  });
  expect(resume.ok()).toBe(true);
  await expect.poll(async () => (await snapshot(request, run.id)).agent_runs?.some(attempt => attempt.status === 'running'),
    { timeout: 15_000, intervals: [50, 100] }).toBe(true);
  const cancel = await request.post(`/api/runs/${run.id}/commands`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'cancel' },
  });
  expect(cancel.ok()).toBe(true);
  const requested = await cancel.json() as RunView;
  expect(requested.cancel_requested).toBe(true);
  expect(requested.status).not.toBe('cancelled');
  await expect.poll(async () => (await snapshot(request, run.id)).run.status, { timeout: 15_000 }).toBe('cancelled');
  const cancelled = await snapshot(request, run.id);
  expect(cancelled.agent_runs?.some(attempt => ['running', 'uncertain'].includes(attempt.status))).toBe(false);
  expect(cancelled.tasks.every(task => ['succeeded', 'cancelled'].includes(task.status))).toBe(true);
});

test('keeps documents and a keyboard decision usable without WebGL', async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type.includes('webgl')) return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  const { project } = await createProject(request);
  const run = await startTest(page, project.id, true);
  const completed = await waitForDecision(request, run.id);
  const decision = completed.decisions![0];
  const card = await openDecision(page, decision);
  const document = completed.artifacts.find(artifact => artifact.id === decision.artifact_ids[0])!;
  await card.locator(`button[data-artifact-id="${document.id}"]`).click();
  await expect(page.locator('.artifact-document .artifact-content')).toContainText(project.name);
  const current = await openDecision(page, decision);
  await current.getByLabel('Комментарий к решению (необязательно)').fill('Нужна дополнительная проверка архитектуры.');
  await current.getByRole('button', { name: 'Отклонить архитектуру', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await snapshot(request, run.id)).decisions![0].choice).toBe('reject');
  const rejected = await snapshot(request, run.id);
  expect(rejected.run.status).toBe('blocked');
  expect(rejected.tasks.find(task => task.role === 'cto')?.status).toBe('blocked');
  await openProjectControls(page);
  await expect(page.getByRole('combobox', { name: 'Сохранённый запуск', exact: true })).toContainText('ТЕСТ / заглушка');
  await expect(page.getByRole('status', { name: 'Режим запуска', exact: true })).toHaveText('ТЕСТ · заглушка');
});
