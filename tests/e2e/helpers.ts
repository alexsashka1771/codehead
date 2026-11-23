import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ProjectView, RunView } from '../../packages/contracts';

export async function waitForSceneReady(page: Page, view: 'factory' | 'preview' = 'factory') {
  const stage = page.locator(view === 'factory' ? '.scene-canvas' : '.animation-stage');
  // This marker follows native shader preparation and the first successful scene draw.
  await expect(stage).toHaveAttribute('data-scene-state', 'ready', { timeout: 30_000 });
}

export async function openProjectControls(page: Page) {
  const toggle = page.getByRole('button', { name: 'Управление проектом', exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

export async function openTaskData(page: Page) {
  await page.getByRole('tab', { name: 'Очередь задач', exact: true }).click();
}

export async function captureSettled(page: Page, path: string) {
  await waitForSceneReady(page);
  await page.locator('.topbar').hover({ position: { x: 4, y: 4 } });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map(animation => animation.finished));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path, fullPage: true });
}

export async function commandHeaders(request: APIRequestContext) {
  const session = await request.get('/api/session');
  expect(session.status()).toBe(200);
  return { 'X-CodeHead-Client': 'browser', 'X-CodeHead-Token': (await session.json()).command_token as string };
}

export async function cancelOpenRuns(request: APIRequestContext, headers: Record<string, string>) {
  // The test launcher provides a new schema, never the user's development database.
  const projects = await request.get('/api/projects');
  expect(projects.ok()).toBe(true);
  for (const project of await projects.json() as ProjectView[]) {
    const response = await request.get(`/api/projects/${project.id}/runs`);
    expect(response.ok()).toBe(true);
    for (const run of await response.json() as RunView[]) {
      if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) {
        const cancelled = await request.post(`/api/runs/${run.id}/commands`, {
          headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'cancel' },
        });
        expect(cancelled.ok()).toBe(true);
      }
    }
  }
}

export async function createRun(request: APIRequestContext) {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  const projectResponse = await request.post('/api/projects', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { name: `Browser check ${randomUUID().slice(0, 6)}`, description: 'Synthetic doctors, patients and appointments.' },
  });
  expect(projectResponse.status()).toBe(201);
  const project: ProjectView = await projectResponse.json();
  const runResponse = await request.post(`/api/projects/${project.id}/runs`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: {},
  });
  expect(runResponse.status()).toBe(201);
  return { project, run: await runResponse.json() as RunView, headers };
}
