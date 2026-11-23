import { test, expect, type Page } from '@playwright/test';
import { createRun, waitForSceneReady } from './helpers';

async function settleComposition(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished));
  });
}

test('orbits the real camera and keeps projected pins attached to the scene', async ({ page }) => {
  await page.goto('/');
  await waitForSceneReady(page);
  await expect(page.locator('.zone-pin')).toHaveCount(10);
  const hidePanel = page.getByRole('button', { name: 'Скрыть управление', exact: true });
  if (await hidePanel.isVisible()) await hidePanel.click();
  await settleComposition(page);
  const pin = page.getByRole('button', { name: 'Осмотреть зону: Архитектура', exact: true });
  const original = await pin.boundingBox();
  const canvas = await page.locator('.scene-canvas canvas').boundingBox();
  expect(original).not.toBeNull();
  expect(canvas).not.toBeNull();
  await page.mouse.move(canvas!.x + canvas!.width * 0.7, canvas!.y + canvas!.height * 0.14);
  await page.mouse.down();
  await page.mouse.move(canvas!.x + canvas!.width * 0.49, canvas!.y + canvas!.height * 0.27, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const moved = await pin.boundingBox();
    return Math.hypot(moved!.x - original!.x, moved!.y - original!.y);
  }).toBeGreaterThan(8);
  await expect(page.getByRole('button', { name: 'Выбрать роль: Product Manager', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Сбросить вид', exact: true }).click();
  await expect.poll(async () => {
    const reset = await pin.boundingBox();
    return Math.hypot(reset!.x - original!.x, reset!.y - original!.y);
  }).toBeLessThan(1);
});

test('previews real joint animation, pauses it and returns to the selected role', async ({ page, request }) => {
  const { project, run } = await createRun(request);
  await page.goto(`/?view=animations&role=backend&project=${project.id}&run=${run.id}`);
  await expect(page.getByRole('heading', { name: 'Предпросмотр анимации модели', exact: true })).toBeVisible();
  await expect(page.locator('.run-mode')).toHaveCount(0);
  await waitForSceneReady(page, 'preview');
  const canvas = page.locator('.animation-stage canvas');
  await expect(canvas).toBeVisible();
  const rest = await canvas.screenshot();
  await page.getByRole('button', { name: 'Работа', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Пауза', exact: true })).toBeVisible();
  await expect.poll(async () => (await canvas.screenshot()).equals(rest), { timeout: 4_000 }).toBe(false);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const paused = await canvas.screenshot();
  await page.waitForTimeout(250);
  expect((await canvas.screenshot()).equals(paused)).toBe(true);
  await page.getByRole('link', { name: 'Вернуться к фабрике', exact: true }).click();
  await expect(page).toHaveURL(/role=backend/);
  expect(new URL(page.url()).searchParams.has('view')).toBe(false);
  expect(new URL(page.url()).searchParams.get('project')).toBe(project.id);
  expect(new URL(page.url()).searchParams.get('run')).toBe(run.id);
  await expect(page.getByRole('button', { name: 'Выбрать роль: Backend Engineer', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('focuses the actual model after a pan without changing projection scale', async ({ page }) => {
  await page.goto('/');
  await waitForSceneReady(page);
  await expect(page.locator('.zone-pin')).toHaveCount(10);
  const hidePanel = page.getByRole('button', { name: 'Скрыть управление', exact: true });
  if (await hidePanel.isVisible()) await hidePanel.click();
  await settleComposition(page);
  await page.getByRole('button', { name: 'Приблизить', exact: true }).click();
  const canvas = await page.locator('.scene-canvas canvas').boundingBox();
  expect(canvas).not.toBeNull();
  const a = page.getByRole('button', { name: 'Осмотреть зону: Архитектура', exact: true });
  const b = page.getByRole('button', { name: 'Осмотреть зону: Продукт', exact: true });
  const distance = async () => {
    const left = await a.boundingBox();
    const right = await b.boundingBox();
    return Math.hypot(left!.x - right!.x, left!.y - right!.y);
  };
  const originalDistance = await distance();
  await page.mouse.move(canvas!.x + canvas!.width * 0.55, canvas!.y + canvas!.height * 0.14);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(canvas!.x + canvas!.width * 0.8, canvas!.y + canvas!.height * 0.36, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.getByRole('button', { name: 'Показать выбранную роль', exact: true }).click();
  await expect.poll(async () => {
    const head = await page.locator('.avatar-label').boundingBox();
    return Math.hypot(head!.x + head!.width / 2 - canvas!.x - canvas!.width / 2,
      head!.y + head!.height / 2 - canvas!.y - canvas!.height / 2);
  }).toBeLessThan(1);
  expect(await distance()).toBeCloseTo(originalDistance, 0);
});

test('magnifies projected scene objects and restores the fitted view', async ({ page }) => {
  await page.goto('/');
  await waitForSceneReady(page);
  const pin = page.getByRole('button', { name: 'Осмотреть зону: Архитектура', exact: true });
  await expect(pin).toBeVisible();
  await settleComposition(page);
  const original = await pin.boundingBox();
  const canvas = await page.locator('.scene-canvas canvas').boundingBox();
  expect(original).not.toBeNull();
  expect(canvas).not.toBeNull();
  const center = { x: canvas!.x + canvas!.width / 2, y: canvas!.y + canvas!.height / 2 };
  const initialRadius = Math.hypot(original!.x + original!.width / 2 - center.x, original!.y + original!.height / 2 - center.y);
  await page.getByRole('button', { name: 'Приблизить', exact: true }).click();
  await expect.poll(async () => {
    const box = await pin.boundingBox();
    return Math.hypot(box!.x + box!.width / 2 - center.x, box!.y + box!.height / 2 - center.y);
  }).toBeGreaterThan(initialRadius * 1.1);
  await page.getByRole('button', { name: 'Сбросить вид', exact: true }).click();
  await expect.poll(async () => {
    const box = await pin.boundingBox();
    return Math.hypot(box!.x - original!.x, box!.y - original!.y);
  }).toBeLessThan(1);
});

test('keeps role controls after losing an established WebGL context', async ({ page }) => {
  await page.goto('/');
  await waitForSceneReady(page);
  const canvas = page.locator('.scene-canvas canvas');
  await expect(page.locator('.zone-pin')).toHaveCount(10);
  await canvas.evaluate(element => {
    const context = (element as HTMLCanvasElement).getContext('webgl2');
    const extension = context?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('The browser test environment must support WEBGL_lose_context.');
    extension.loseContext();
  });
  await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать роль: QA Engineer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'QA Engineer', exact: true })).toBeVisible();
});

test('renders the factory without renderer errors', async ({ page }) => {
  const errors: string[] = [];
  const shaderErrors: string[] = [];
  const shadowWarnings: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') shaderErrors.push(message.text());
    if (message.type() === 'warning' && message.text().includes('ShadowMap')) shadowWarnings.push(message.text());
  });
  await page.goto('/');
  await waitForSceneReady(page);
  await expect(page.locator('.scene-canvas canvas')).toBeVisible();
  await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toHaveCount(0);
  await expect(page.locator('.world-labels')).toBeVisible();
  expect(errors).toEqual([]);
  expect(shaderErrors).toEqual([]);
  expect(shadowWarnings).toEqual([]);
});

test('keeps the physical shadow map stable when only the viewing camera moves', async ({ page }) => {
  let fiberUrl = '';
  page.on('request', request => { if (request.url().includes('/@react-three_fiber.js')) fiberUrl = request.url(); });
  await page.goto('/');
  await waitForSceneReady(page);
  await expect(page.locator('.zone-pin')).toHaveCount(10);
  await expect.poll(() => page.evaluate(async url => {
    const { _roots } = await import(url);
    const state = _roots.get(document.querySelector('canvas')).store.getState();
    return !!state.scene.environment && !state.gl.shadowMap.needsUpdate;
  }, fiberUrl)).toBe(true);
  await page.evaluate(async url => {
    const { _roots } = await import(url);
    const state = _roots.get(document.querySelector('canvas')).store.getState();
    (window as any).__physicalShadowDraws = 0;
    state.scene.traverse((object: any) => {
      if (!object.isMesh) return;
      const original = object.onBeforeShadow;
      object.onBeforeShadow = function (...args: unknown[]) {
        (window as any).__physicalShadowDraws++;
        original.apply(this, args);
      };
    });
  }, fiberUrl);
  const canvas = await page.locator('.scene-canvas canvas').boundingBox();
  await page.mouse.move(canvas!.x + canvas!.width * 0.65, canvas!.y + canvas!.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(canvas!.x + canvas!.width * 0.48, canvas!.y + canvas!.height * 0.28, { steps: 2 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__physicalShadowDraws)).toBe(0);
});
