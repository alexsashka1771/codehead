import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventsPage, ProjectView, RunView, Snapshot, ToolRunView } from '../../packages/contracts';
import { normalizeSnapshot, projectHistory } from '../../apps/frontend/src/state/projection';
import { cancelOpenRuns, captureSettled, commandHeaders, waitForSceneReady } from './helpers';

test.skip(process.env.CODEHEAD_E2E_WITH_WORKER !== '1', 'Use --with-worker for the real isolated Runner.');

async function readSnapshot(request: APIRequestContext, id: string): Promise<Snapshot> {
  const response = await request.get(`/api/runs/${id}/snapshot`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createReadyCandidate(request: APIRequestContext) {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  await expect.poll(async () => {
    const response = await request.get('/api/projects');
    expect(response.ok()).toBe(true);
    const histories = await Promise.all((await response.json() as ProjectView[]).map(async project => {
      const runs = await request.get(`/api/projects/${project.id}/runs`);
      expect(runs.ok()).toBe(true);
      return runs.json() as Promise<RunView[]>;
    }));
    return histories.flat().every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status));
  }, { timeout: 20_000 }).toBe(true);
  const created = await request.post('/api/projects', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { name: 'Runner clinic ' + randomUUID().slice(0, 6), description: 'Синтетические врачи, пациенты и запись на приём.' },
  });
  expect(created.status()).toBe(201);
  const project: ProjectView = await created.json();
  const started = await request.post(`/api/projects/${project.id}/runs`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { mode: 'test' },
  });
  expect(started.status()).toBe(201);
  const run: RunView = await started.json();
  await expect.poll(async () => (await readSnapshot(request, run.id)).decisions?.filter(decision => decision.status === 'open').length,
    { timeout: 30_000 }).toBe(1);
  const before = await readSnapshot(request, run.id);
  const decision = before.decisions!.find(item => item.status === 'open')!;
  const approved = await request.post(`/api/decisions/${decision.id}/resolve`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { version: decision.version, choice: 'approve', comment: '' },
  });
  expect(approved.ok()).toBe(true);
  await expect.poll(async () => (await readSnapshot(request, run.id)).candidate?.status, { timeout: 30_000 }).toBe('ready');
  await expect.poll(async () => (await readSnapshot(request, run.id)).run.status, { timeout: 15_000 }).toBe('blocked');
  await expect.poll(async () => {
    const response = await request.get('/api/capabilities');
    expect(response.ok()).toBe(true);
    return (await response.json()).capabilities.find((item: { id: string }) => item.id === 'runner')?.status;
  }, { timeout: 15_000 }).toBe('available');
  return { project, run, initial: await readSnapshot(request, run.id) };
}

async function openChecks(page: Page) {
  const version = page.getByRole('tab', { name: 'Кандидат Clinic Demo', exact: true });
  await version.focus(); await page.keyboard.press('ArrowRight');
  const checks = page.getByRole('tab', { name: 'Проверки', exact: true });
  await expect(checks).toBeFocused();
  await expect(checks).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('region', { name: 'Проверки кандидата', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

for (const fallback of [false, true]) {
  test(`queues real Python checks and preserves audit results${fallback ? ' with keyboard at 430px without WebGL' : ' with the independent HTTP suite'}`, async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    if (fallback) {
      await page.setViewportSize({ width: 430, height: 932 });
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
          return type.includes('webgl') ? null : Reflect.apply(original, this, [type, ...args]);
        } as typeof original;
      });
    }
    const { project, run, initial } = await createReadyCandidate(request);
    await page.goto(`/?project=${project.id}&run=${run.id}`);
    if (fallback) await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
    else await waitForSceneReady(page);
    let panel = await openChecks(page);
    await expect(panel).toContainText('process_only');
    await expect(panel).toContainText('QA, DevOps и preview пока недоступны');
    const requests: { key: string | undefined; operation: string }[] = [];
    page.on('request', outgoing => {
      if (outgoing.method() === 'POST' && outgoing.url().endsWith(`/api/runs/${run.id}/tools/commands`)) {
        requests.push({ key: outgoing.headers()['idempotency-key'], operation: outgoing.postDataJSON().operation_id });
      }
    });
    const execute = async (buttonName: string, operation: ToolRunView['operation_id']) => {
      const button = panel.getByRole('button', { name: buttonName, exact: true });
      await expect(button).toBeEnabled({ timeout: 15_000 });
      const queued = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/runs/${run.id}/tools/commands`));
      const began = Date.now();
      await button.focus(); await page.keyboard.press('Enter');
      const receiptResponse = await queued;
      expect(receiptResponse.status()).toBe(202);
      expect(Date.now() - began).toBeLessThan(5000);
      const receipt: ToolRunView = await receiptResponse.json();
      expect(receipt).toMatchObject({ operation_id: operation, status: 'created', workspace_id: initial.candidate!.id,
        snapshot_version: initial.candidate!.revision, run_id: run.id, isolation_level: 'process_only' });
      await expect.poll(async () => (await readSnapshot(request, run.id)).tool_runs?.find(tool => tool.id === receipt.id)?.status,
        { timeout: 180_000, intervals: [250, 500, 1000] }).toBe('succeeded');
      const entry = panel.locator(`[data-tool-id="${receipt.id}"]`);
      await expect(entry).toHaveAttribute('data-tool-status', 'succeeded', { timeout: 15_000 });
      await entry.getByText('Команды, stdout и stderr', { exact: true }).click();
      return { receipt, entry };
    };
    const python = await execute('Проверить Python', 'validate_backend');
    await expect(python.entry).toContainText('Код завершения');
    if (!fallback) {
      const http = await execute('Проверить HTTP', 'test_backend');
      await expect(http.entry).toContainText('55 passed');
      await http.entry.getByText('Отчёт, хэши и параметры версии', { exact: true }).click();
      await expect(http.entry).toContainText('process_only');
    }
    const after = await readSnapshot(request, run.id);
    expect(after.tool_runs).toHaveLength(fallback ? 1 : 2);
    expect(after.run.status).toBe('blocked');
    expect(after.usage).toEqual(initial.usage);
    expect(after.candidate).toEqual(initial.candidate);
    for (const tool of after.tool_runs!) {
      expect(tool.exit_code).toBe(0); expect(tool.started_at).toBeTruthy(); expect(tool.finished_at).toBeTruthy();
      expect(tool.commands!.length).toBeGreaterThan(0);
      expect(tool.manifest_hash).toBe(initial.candidate!.manifest_hash);
      expect(tool.tree_hash).toBe(initial.candidate!.tree_hash);
      expect(tool.stdout).not.toContain('ТЕСТ · заглушка');
    }
    const list = await request.get(`/api/runs/${run.id}/tools`);
    expect(list.ok()).toBe(true); expect(await list.json()).toEqual(after.tool_runs);
    const prefix: DomainEvent[] = [];
    let cursor = 0;
    while (cursor < after.last_event_seq) {
      const response = await request.get(`/api/runs/${run.id}/events?after_seq=${cursor}&limit=5`);
      expect(response.ok()).toBe(true);
      const eventPage: EventsPage = await response.json();
      const bounded = eventPage.events.filter(event => event.seq <= after.last_event_seq);
      expect(bounded.length).toBeGreaterThan(0); prefix.push(...bounded); cursor = bounded.at(-1)!.seq;
    }
    expect(normalizeSnapshot(projectHistory(prefix, after.last_event_seq))).toEqual(normalizeSnapshot(after));
    expect(requests.map(item => item.operation)).toEqual(fallback ? ['validate_backend'] : ['validate_backend', 'test_backend']);
    expect(new Set(requests.map(item => item.key)).size).toBe(requests.length);
    expect(requests.every(item => typeof item.key === 'string' && item.key.length > 10)).toBe(true);
    if (fallback) {
      await expect(page.getByRole('tab', { name: 'Проверки', exact: true })).toBeInViewport({ ratio: 0.9 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('runner-fallback-430.png'), fullPage: true });
    } else await captureSettled(page, testInfo.outputPath('runner-1366.png'));
    await page.getByRole('button', { name: 'Свернуть панель данных', exact: true }).click();
    await page.reload();
    if (fallback) await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
    else await waitForSceneReady(page);
    panel = await openChecks(page);
    await expect(panel.locator('.tool-entry')).toHaveCount(fallback ? 1 : 2);
    await expect(panel.locator(`[data-tool-id="${python.receipt.id}"]`)).toHaveAttribute('data-tool-status', 'succeeded');
    const reloaded = await readSnapshot(request, run.id);
    expect(reloaded.tool_runs).toEqual(after.tool_runs);
    expect(reloaded.last_event_seq).toBe(after.last_event_seq);
    expect(requests).toHaveLength(fallback ? 1 : 2);
  });
}
