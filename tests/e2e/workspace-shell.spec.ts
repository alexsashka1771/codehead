import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRun, waitForSceneReady } from './helpers';

test('keeps the persisted run mode visible with all panels closed', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  await expect(page.getByText('События подключены', { exact: true })).toBeVisible();
  const projectToggle = page.getByRole('button', { name: 'Управление проектом', exact: true });
  await projectToggle.click();
  await expect(page.locator('.control-rail')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.control-rail')).toBeHidden();
  await expect(page.locator('.role-inspector')).toBeHidden();
  await expect(page.locator('.inspector-content')).toBeHidden();
  const mode = page.getByRole('status', { name: 'Режим запуска', exact: true });
  await expect(mode).toBeVisible();
  await expect(mode).toHaveText(run.mode.toUpperCase());
});

for (const chosen of ['data', 'role'] as const) {
  test('preserves the initial ' + chosen + ' panel after a delayed empty project list', async ({ page }) => {
    let releaseProjects!: () => void;
    const gate = new Promise<void>(resolve => { releaseProjects = resolve; });
    await page.route('**/api/projects', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    try {
      await page.goto('/');
      await page.getByRole('button', { name: chosen === 'data' ? 'Данные запуска' : 'Карточка выбранной роли', exact: true }).click();
      const panel = page.locator(chosen === 'data' ? '.inspector-content' : '.role-inspector');
      await expect(panel).toBeVisible();
      releaseProjects();
      await expect(page.getByLabel('Выбрать проект')).toBeEnabled();
      await expect(page.locator('.control-rail')).toBeHidden();
      await expect(panel).toBeVisible();
    } finally { releaseProjects(); }
  });
}

test('dismisses a zone tooltip before closing the active panel', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.goto('/?project=' + project.id + '&run=' + run.id);
  await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
  await expect(page.locator('.role-inspector')).toBeVisible();
  await waitForSceneReady(page);
  await page.getByRole('button', { name: 'Осмотреть зону: Архитектура', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect(page.locator('.role-inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.role-inspector')).toBeHidden();
});

test('keeps a zone tooltip visible while its text is hovered', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.goto('/?project=' + project.id + '&run=' + run.id);
  await waitForSceneReady(page);
  await page.getByRole('button', { name: 'Осмотреть зону: Архитектура', exact: true }).hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await tooltip.hover({ timeout: 5_000 });
  await expect(tooltip).toBeVisible();
  await page.getByRole('button', { name: 'Новый проект', exact: true }).hover();
  await expect(tooltip).toBeHidden();
});

test('keeps a user-selected panel when a late project save finishes', async ({ page }) => {
  let releaseProject!: () => void;
  let sawProject!: () => void;
  const gate = new Promise<void>(resolve => { releaseProject = resolve; });
  const sent = new Promise<void>(resolve => { sawProject = resolve; });
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sawProject();
    await gate;
    await route.continue();
  });
  const name = 'Deferred project ' + randomUUID().slice(0, 6);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Новый проект', exact: true }).click();
    await page.getByLabel('Название проекта').fill(name);
    await page.getByLabel('Что нужно создать').fill('Synthetic doctors and appointments.');
    await page.getByRole('button', { name: 'Создать проект', exact: true }).click();
    await sent;
    await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
    await expect(page.locator('.control-rail')).toBeHidden();
    releaseProject();
    await expect(page.getByLabel('Выбрать проект')).toContainText(name);
    await expect(page.locator('.control-rail')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'QA Engineer', exact: true })).toBeVisible();
  } finally { releaseProject(); }
});

test('shows a failed start outside the collapsed project panel', async ({ page, request }) => {
  const { project, run, headers } = await createRun(request);
  const cancelled = await request.post('/api/runs/' + run.id + '/commands', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: 'cancel' },
  });
  expect(cancelled.ok()).toBe(true);
  await page.route('**/api/projects/' + project.id + '/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ code: 'worker_unavailable', message: 'Test start rejected.', retriable: true }) });
  });
  await page.goto('/?project=' + project.id + '&run=' + run.id);
  await page.getByRole('button', { name: 'Управление проектом', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.locator('.control-rail')).toBeHidden();
  await expect(page.getByRole('alert')).toContainText('Test start rejected.');
  await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('keeps the data tabs clickable when switching from project controls', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  await page.getByRole('button', { name: 'Управление проектом', exact: true }).click();
  await expect(page.locator('.control-rail')).toBeVisible();
  await page.getByRole('button', { name: 'Данные запуска', exact: true }).click();
  await expect(page.locator('.control-rail')).toBeHidden();
  await page.getByRole('tab', { name: 'Журнал событий', exact: true }).click();
  await expect(page.locator('.event-list li')).toHaveCount(8);
  await page.getByRole('button', { name: 'Управление проектом', exact: true }).click();
  await expect(page.locator('.inspector-content')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Пауза', exact: true })).toBeVisible();
});

test('opens project and role panels on demand and returns keyboard focus', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.goto(`/?project=${project.id}&run=${run.id}`);
  const projectToggle = page.getByRole('button', { name: 'Управление проектом', exact: true });
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.control-rail')).toBeHidden();
  await projectToggle.click();
  await expect(page.locator('.control-rail')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.control-rail')).toBeHidden();
  await expect(projectToggle).toBeFocused();
  const roleButton = page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true });
  await roleButton.click();
  await expect(page.getByRole('heading', { name: 'QA Engineer', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.role-inspector')).toBeHidden();
  await expect(roleButton).toBeFocused();
  await expect(page.locator('.scene-canvas canvas')).toBeVisible();
});

test('keeps an unfinished project form when its panel is closed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новый проект', exact: true }).click();
  await page.getByLabel('Название проекта').fill('Unfinished clinic');
  await page.getByLabel('Что нужно создать').fill('Synthetic appointments with doctors.');
  await page.getByRole('button', { name: 'Скрыть управление', exact: true }).click();
  await expect(page.getByLabel('Название проекта')).toBeHidden();
  await page.getByRole('button', { name: 'Управление проектом', exact: true }).click();
  await expect(page.getByLabel('Название проекта')).toHaveValue('Unfinished clinic');
  await expect(page.getByLabel('Что нужно создать')).toHaveValue('Synthetic appointments with doctors.');
});

test('shows zone names on hover and keyboard focus without permanent captions', async ({ page }) => {
  await page.goto('/');
  await waitForSceneReady(page);
  await expect(page.locator('.zone-pin')).toHaveCount(10);
  await expect(page.locator('.zone-tooltip')).toBeHidden();
  const zone = page.getByRole('button', { name: 'Осмотреть зону: Архитектура', exact: true });
  await zone.focus();
  await expect(page.getByRole('tooltip')).toContainText('Архитектура');
  await page.getByRole('button', { name: 'Новый проект', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toBeHidden();
  await zone.hover();
  await expect(page.getByRole('tooltip')).toContainText('Архитектура');
});
