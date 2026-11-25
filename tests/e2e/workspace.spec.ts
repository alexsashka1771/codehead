import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { cancelOpenRuns, commandHeaders, createRun, openProjectControls, openTaskData, captureSettled, waitForSceneReady } from './helpers';

test('reconnects while usage request is still pending', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  let releaseUsage!: () => void;
  const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
  await page.route('**/usage', async (route) => { await usageGate; await route.continue(); });
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    (window as any).__runSockets = [];
    (window as any).WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes('/api/runs/')) (window as any).__runSockets.push(this);
      }
    };
  });
  try {
    await page.goto(`/?project=${project.id}&run=${run.id}`);
    await expect(page.getByText('События подключены', { exact: true })).toBeVisible();
    // Keep usage suspended while isolating reconnect from first-use software shader compilation.
    await waitForSceneReady(page);
    await page.evaluate(() => (window as any).__runSockets.at(-1).close());
    await expect.poll(() => page.evaluate(() => (window as any).__runSockets.length), { timeout: 5_000 }).toBeGreaterThan(1);
    await expect(page.getByText('События подключены', { exact: true })).toBeVisible();
  } finally { releaseUsage(); }
});

test('creates a project, preserves history and controls its saved run', async ({ page, request }, testInfo) => {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  const name = `Учебная клиника ${randomUUID().slice(0, 6)}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект', exact: true }).click();
  await page.getByLabel('Название проекта').fill(name);
  await page.getByLabel('Что нужно создать').fill('Учебное приложение для врачей, условных пациентов и записи на приём.');
  await page.getByRole('button', { name: 'Создать проект', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  const projectId = new URL(page.url()).searchParams.get('project');
  const response = await request.post(`/api/projects/${projectId}/runs`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { mode: 'live' },
  });
  expect(response.status()).toBe(201);
  const savedRun = await response.json();
  await page.goto(`/?project=${projectId}&run=${savedRun.id}`);
  await expect(page.getByText('События подключены', { exact: true })).toBeVisible();
  await openTaskData(page);
  await expect(page.locator('.task-table tbody tr')).toHaveCount(7);
  const persistedUrl = page.url();
  const runId = new URL(persistedUrl).searchParams.get('run');
  expect(runId).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await openTaskData(page);
  await expect(page.locator('.task-table tbody tr')).toHaveCount(7);
  await expect(page).toHaveURL(persistedUrl);
  await page.getByRole('button', { name: 'Выбрать роль: Backend Engineer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Backend Engineer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ночная тема', exact: true }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'night');
  await page.reload();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'night');
  await openProjectControls(page);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Пауза', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await openTaskData(page);
  await expect(page.locator('.task-table .status-cancelled')).toHaveCount(7);
  await page.getByRole('tab', { name: /Журнал событий/ }).click();
  await expect(page.locator('.event-list li')).toHaveCount(11);
  await page.getByRole('tab', { name: /Артефакты/ }).click();
  await expect(page.getByRole('heading', { name: 'Результатов пока нет' })).toBeVisible();
  await page.getByRole('tab', { name: /Возможности/ }).click();
  await expect(page.locator('.capability-row').filter({ hasText: 'Генерация приложения' })).toContainText('Отключено');
  const snapshot = await (await request.get(`/api/runs/${runId}/snapshot`)).json();
  expect(snapshot.run.status).toBe('cancelled');
  expect(snapshot.last_event_seq).toBe(11);
  expect(snapshot.tasks.every((task: { status: string }) => task.status === 'cancelled')).toBe(true);
  await captureSettled(page, testInfo.outputPath('saved-run-night.png'));
});

test('keeps HTML controls usable when WebGL is unavailable', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type.includes('webgl')) return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Выбрать роль:/ })).toHaveCount(7);
  await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'QA Engineer', exact: true })).toBeVisible();
  await openProjectControls(page);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Продолжить', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await openTaskData(page);
  await expect(page.locator('.task-table .status-cancelled')).toHaveCount(7);
});

test('shows every zone and role in the overview at desktop and compact widths', async ({ page, request }, testInfo) => {
  const { project, run } = await createRun(request);
  for (const [width, height] of [[1366, 768], [1920, 1080], [430, 932]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/?project=${project.id}&run=${run.id}`);
    await waitForSceneReady(page);
    await expect(page.locator('.zone-pin')).toHaveCount(10);
    await page.getByRole('button', { name: 'Сбросить вид', exact: true }).click();
    await expect(page.locator('.avatar-label')).toHaveCount(1);
    for (const pin of await page.locator('.zone-pin').all()) await expect(pin).toBeInViewport();
    await expect(page.getByRole('button', { name: /^Выбрать роль:/ })).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureSettled(page, testInfo.outputPath(`factory-${width}.png`));
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: 'Дневная тема', exact: true }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'day');
  await waitForSceneReady(page);
  await expect(page.locator('.zone-pin')).toHaveCount(10);
  await captureSettled(page, testInfo.outputPath('factory-day-1366.png'));
  await page.getByRole('button', { name: 'Ночная тема', exact: true }).click();
  await openProjectControls(page);
  await captureSettled(page, testInfo.outputPath('project-panel-1366.png'));
  await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
  await captureSettled(page, testInfo.outputPath('role-panel-1366.png'));
  await openTaskData(page);
  await page.setViewportSize({ width: 430, height: 932 });
  await captureSettled(page, testInfo.outputPath('data-panel-430.png'));
  await openProjectControls(page);
  await captureSettled(page, testInfo.outputPath('project-panel-430.png'));
  await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
  await captureSettled(page, testInfo.outputPath('role-panel-430.png'));
});

test('keeps a newly created project when an older project list arrives', async ({ page }) => {
  let releaseProjects!: () => void;
  const projectsGate = new Promise<void>((resolve) => { releaseProjects = resolve; });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    await projectsGate;
    await route.fulfill({ response, body });
  });
  const name = `Сохранённый проект ${randomUUID().slice(0, 6)}`;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Новый проект', exact: true }).click();
    await page.getByLabel('Название проекта').fill(name);
    await page.getByLabel('Что нужно создать').fill('Синтетические данные, врачи и запись на приём.');
    await page.getByRole('button', { name: 'Создать проект', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const createdUrl = page.url();
    releaseProjects();
    await expect(page.getByTitle('Переподключиться к серверу')).toBeEnabled();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page).toHaveURL(createdUrl);
    await expect(page.getByLabel('Выбрать проект')).toContainText(name);
  } finally { releaseProjects(); }
});

test('keeps a newly started run when an older run list arrives after refresh', async ({ page, request }) => {
  test.skip(process.env.CODEHEAD_E2E_WITH_WORKER !== '1', 'Starting a test requires the ready QA worker.');
  const { project, run, headers } = await createRun(request);
  const cancelled = await request.post(`/api/runs/${run.id}/commands`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'cancel' },
  });
  expect(cancelled.ok()).toBe(true);
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  await openProjectControls(page);
  await expect(page.getByRole('button', { name: 'Запустить тест', exact: true })).toBeEnabled();
  let releaseStart!: () => void;
  let releaseHistory!: () => void;
  let sawStart!: () => void;
  let sawHistory!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const startSeen = new Promise<void>((resolve) => { sawStart = resolve; });
  const historySeen = new Promise<void>((resolve) => { sawHistory = resolve; });
  await page.route(`**/api/projects/${project.id}/runs`, async (route) => {
    if (route.request().method() === 'POST') {
      sawStart();
      await startGate;
      return route.continue();
    }
    const response = await route.fetch();
    const body = await response.text();
    sawHistory();
    await historyGate;
    await route.fulfill({ response, body });
  });
  try {
    await page.getByRole('button', { name: 'Запустить тест', exact: true }).click();
    await startSeen;
    await page.getByTitle('Переподключиться к серверу').click();
    await historySeen;
    releaseStart();
    await expect.poll(() => new URL(page.url()).searchParams.get('run')).not.toBe(run.id);
    await expect(page.getByText('События подключены', { exact: true })).toBeVisible();
    const createdUrl = page.url();
    releaseHistory();
    await expect(page.getByText('Загружаем запуски…', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(createdUrl);
    await expect(page.locator('.task-table tbody tr')).toHaveCount(7);
  } finally { releaseStart(); releaseHistory(); }
});
