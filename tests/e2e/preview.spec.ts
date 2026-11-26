import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import type { DomainEvent, EventsPage, PreviewView, ProjectView, RunView, Snapshot } from '../../packages/contracts';
import { normalizeSnapshot, projectHistory } from '../../apps/frontend/src/state/projection';
import { cancelOpenRuns, commandHeaders, openProjectControls, waitForSceneReady } from './helpers';

test.skip(process.env.CODEHEAD_E2E_WITH_WORKER !== '1', 'Use --with-worker for the real Clinic preview.');

async function snapshot(request: APIRequestContext, runId: string): Promise<Snapshot> {
  const response = await request.get(`/api/runs/${runId}/snapshot`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function preview(request: APIRequestContext, runId: string): Promise<PreviewView> {
  const response = await request.get(`/api/runs/${runId}/preview`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function completedRun(request: APIRequestContext) {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  const created = await request.post('/api/projects', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { name: 'Preview Clinic Demo', description: 'Учебный запуск с синтетическими данными.' },
  });
  expect(created.status()).toBe(201);
  const project: ProjectView = await created.json();
  const response = await request.post(`/api/projects/${project.id}/runs`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { mode: 'test' },
  });
  expect(response.status()).toBe(201);
  const run: RunView = await response.json();
  expect(run.workflow_version).toBe('clinic-v4');
  await expect.poll(async () => (await snapshot(request, run.id)).decisions?.find(
    value => value.kind === 'architecture_approval' && value.status === 'open',
  )?.id, { timeout: 45_000, intervals: [250, 500, 1000] }).toBeTruthy();
  const decision = (await snapshot(request, run.id)).decisions!.find(value => value.status === 'open')!;
  const approval = await request.post(`/api/decisions/${decision.id}/resolve`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { version: decision.version, choice: 'approve' },
  });
  expect(approval.ok()).toBe(true);
  await expect.poll(async () => {
    const current = await snapshot(request, run.id);
    return [current.run.status, current.delivery?.status, current.usage?.request_count];
  }, { timeout: 300_000, intervals: [500, 1000, 2000] }).toEqual(['succeeded', 'ready', 7]);
  return { project, run, headers };
}

async function assertHistory(request: APIRequestContext, final: Snapshot) {
  const events: DomainEvent[] = [];
  let cursor = 0;
  while (cursor < final.last_event_seq) {
    const response = await request.get(`/api/runs/${final.run.id}/events?after_seq=${cursor}&limit=11`);
    expect(response.ok()).toBe(true);
    const page: EventsPage = await response.json();
    const prefix = page.events.filter(event => event.seq <= final.last_event_seq);
    expect(prefix.length).toBeGreaterThan(0);
    for (const event of prefix) {
      events.push(event);
      projectHistory(events, event.seq);
    }
    cursor = prefix.at(-1)!.seq;
  }
  expect(normalizeSnapshot(projectHistory(events, cursor))).toEqual(normalizeSnapshot(final));
}

async function openPreview(page: Page) {
  const tab = page.getByRole('tab', { name: 'Preview', exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel');
}

async function addSyntheticDirectoryEntries(clinic: FrameLocator) {
  await clinic.getByRole('button', { name: 'Врачи', exact: true }).click();
  await clinic.getByRole('button', { name: 'Добавить врача' }).click();
  await clinic.getByLabel('Имя врача').fill('Учебный врач');
  await clinic.getByLabel('Специальность').fill('Терапевт');
  await clinic.getByRole('button', { name: 'Сохранить врача' }).click();
  await expect(clinic.getByText('Учебный врач', { exact: true })).toBeVisible();
  await clinic.getByRole('button', { name: 'Пациенты', exact: true }).click();
  for (const name of ['Учебный пациент А', 'Учебный пациент Б']) {
    await clinic.getByRole('button', { name: 'Добавить пациента' }).click();
    await clinic.getByLabel('Имя пациента').fill(name);
    await clinic.getByRole('button', { name: 'Сохранить пациента' }).click();
    await expect(clinic.getByText(name, { exact: true })).toBeVisible();
  }
}

test('opens the real versioned package explicitly and runs Clinic forms in a sandboxed frame', async ({ page, request }, testInfo) => {
  test.setTimeout(420_000);
  const { project, run, headers } = await completedRun(request);
  const initial = await snapshot(request, run.id);
  await assertHistory(request, initial);
  expect((await preview(request, run.id)).preview_sessions).toEqual([]);
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  await waitForSceneReady(page);
  let panel = await openPreview(page);
  const frame = page.locator('iframe[title="Clinic Demo · Preview"]');
  await expect(frame).toHaveCount(0);
  const archive = initial.delivery!;
  const downloaded = page.waitForEvent('download');
  await panel.getByRole('link', { name: 'Скачать ZIP', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(archive.package_archive_hash);
  expect((await snapshot(request, run.id)).last_event_seq).toBe(initial.last_event_seq);

  await panel.getByRole('button', { name: 'Запустить preview', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Открыть', exact: true })).toBeEnabled({ timeout: 45_000 });
  await expect(frame).toHaveCount(0);
  const live = await preview(request, run.id);
  expect(live.access.status).toBe('available');
  expect(live.access.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  await panel.getByRole('button', { name: 'Открыть', exact: true }).click();
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
  const clinic = frame.contentFrame();
  await expect(clinic.getByRole('heading', { name: 'Журнал приёмов', exact: true })).toBeVisible({ timeout: 15_000 });
  const boundary = await clinic.locator('body').evaluate(async () => {
    let canReadParent = true;
    try { void window.parent.document.title; } catch { canReadParent = false; }
    return { ownOrigin: self.origin, canReadParent };
  });
  expect(boundary).toEqual({ ownOrigin: 'null', canReadParent: false });
  const bootstrap = await request.get('/api/session', { headers: { Origin: live.access.origin! } });
  expect(bootstrap.status()).toBe(403);
  const forbidden = await request.post(`/api/runs/${run.id}/preview/commands`, {
    headers: { ...headers, Origin: live.access.origin!, 'Idempotency-Key': randomUUID() },
    data: {
      command: 'stop', package_id: archive.id,
      expected_version: live.access.version, preview_session_id: live.access.preview_session_id,
    },
  });
  expect(forbidden.status()).toBe(403);

  await addSyntheticDirectoryEntries(clinic);
  await clinic.getByRole('button', { name: 'Журнал приёмов', exact: true }).click();
  await clinic.getByRole('button', { name: 'Новая запись', exact: true }).click();
  const slot = await clinic.getByLabel('Дата и время').inputValue();
  const first = clinic.getByRole('dialog');
  await first.getByLabel('Врач', { exact: true }).selectOption({ label: 'Учебный врач · Терапевт' });
  await first.getByLabel('Пациент', { exact: true }).selectOption({ label: 'Учебный пациент А' });
  await first.getByRole('button', { name: 'Сохранить запись', exact: true }).click();
  await expect(clinic.getByText('Новая запись сохранена.', { exact: true })).toBeVisible();
  await clinic.getByRole('button', { name: 'Новая запись', exact: true }).click();
  const second = clinic.getByRole('dialog');
  await second.getByLabel('Врач', { exact: true }).selectOption({ label: 'Учебный врач · Терапевт' });
  await second.getByLabel('Пациент', { exact: true }).selectOption({ label: 'Учебный пациент Б' });
  await second.getByLabel('Дата и время').fill(slot);
  const conflict = page.waitForResponse(result => result.url().endsWith('/api/appointments') && result.request().method() === 'POST');
  await second.getByRole('button', { name: 'Сохранить запись', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(second.getByText('Этот слот уже занят', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Закрыть форму' }).click();
  await page.screenshot({ path: testInfo.outputPath('preview-1366.png') });

  const stable = await snapshot(request, run.id);
  await page.reload();
  panel = await openPreview(page);
  await expect(panel.getByRole('button', { name: 'Открыть', exact: true })).toBeEnabled();
  await expect(frame).toHaveCount(0);
  expect((await snapshot(request, run.id)).last_event_seq).toBe(stable.last_event_seq);

  await panel.getByRole('button', { name: 'Остановить preview', exact: true }).click();
  await expect.poll(async () => (await preview(request, run.id)).preview_sessions?.at(-1)?.status,
    { timeout: 30_000 }).toBe('stopped');
  await assertHistory(request, await snapshot(request, run.id));
  expect((await preview(request, run.id)).access.origin).toBeNull();

  await page.setViewportSize({ width: 430, height: 932 });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      return type.includes('webgl') ? null : Reflect.apply(getContext, this, [type, ...args]);
    } as typeof getContext;
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  panel = await openPreview(page);
  const restart = panel.getByRole('button', { name: 'Запустить preview', exact: true });
  await restart.focus();
  await page.keyboard.press('Enter');
  const open = panel.getByRole('button', { name: 'Открыть', exact: true });
  await expect(open).toBeEnabled({ timeout: 45_000 });
  await open.focus();
  await page.keyboard.press('Enter');
  await clinic.getByRole('button', { name: 'Пациенты', exact: true }).click();
  await expect(clinic.getByText('Учебный пациент А', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('preview-fallback-430.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Остановить preview', exact: true }).click();
  await expect(frame).toHaveCount(0);
  await expect.poll(async () => (await preview(request, run.id)).preview_sessions?.at(-1)?.status,
    { timeout: 30_000 }).toBe('stopped');
  await openProjectControls(page);
  await expect(page.getByLabel('Сохранённый запуск')).toHaveValue(run.id);
});
