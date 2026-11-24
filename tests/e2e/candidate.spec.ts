import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { ArtifactContent, CandidateView, DomainEvent, EventsPage, ProjectView, RunView, Snapshot } from '../../packages/contracts';
import { hydrateSnapshot, normalizeSnapshot, projectHistory } from '../../apps/frontend/src/state/projection';
import { cancelOpenRuns, captureSettled, commandHeaders, openProjectControls, waitForSceneReady } from './helpers';

test.skip(process.env.CODEHEAD_E2E_WITH_WORKER !== '1', 'Use --with-worker for the isolated candidate workflow.');

async function snapshot(request: APIRequestContext, id: string): Promise<Snapshot> {
  const response = await request.get(`/api/runs/${id}/snapshot`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createCandidateRun(page: Page, request: APIRequestContext, fallback: boolean) {
  const headers = await commandHeaders(request);
  await cancelOpenRuns(request, headers);
  await expect.poll(async () => {
    const projectsResponse = await request.get('/api/projects');
    expect(projectsResponse.ok()).toBe(true);
    const projects: ProjectView[] = await projectsResponse.json();
    const histories = await Promise.all(projects.map(async project => {
      const response = await request.get(`/api/projects/${project.id}/runs`);
      expect(response.ok()).toBe(true);
      return response.json() as Promise<RunView[]>;
    }));
    return histories.flat().every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status));
  }, { timeout: 20_000 }).toBe(true);
  const projectResponse = await request.post('/api/projects', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { name: 'Candidate clinic ' + randomUUID().slice(0, 6), description: 'Синтетические врачи, пациенты и запись на приём.' },
  });
  expect(projectResponse.status()).toBe(201);
  const project: ProjectView = await projectResponse.json();
  await page.goto(`/?project=${project.id}`);
  if (fallback) await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
  else await waitForSceneReady(page);
  await openProjectControls(page);
  const start = page.getByRole('button', { name: 'Запустить тест', exact: true });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  const created = page.waitForResponse(response => response.url().endsWith(`/api/projects/${project.id}/runs`) && response.request().method() === 'POST');
  await start.focus(); await page.keyboard.press('Enter');
  const runResponse = await created;
  expect(runResponse.status()).toBe(201);
  const run: RunView = await runResponse.json();
  expect(run).toMatchObject({ mode: 'test', workflow_version: 'clinic-v2', profile_version: 'clinic_demo/v1' });
  await expect.poll(async () => (await snapshot(request, run.id)).decisions?.filter(item => item.status === 'open').length,
    { timeout: 30_000, intervals: [100, 250, 500] }).toBe(1);
  const before = await snapshot(request, run.id);
  const ctoAttempt = before.agent_runs!.find(attempt => before.tasks.find(task => task.id === attempt.task_id)?.role === 'cto')!;
  await page.getByRole('tab', { name: 'Решения автора', exact: true }).click();
  const card = page.locator(`.worker-data .decision-card[data-decision-id="${before.decisions![0].id}"]`);
  await expect(card).toContainText('Backend и Frontend');
  const approve = card.getByRole('button', { name: 'Принять архитектуру', exact: true });
  await approve.focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await snapshot(request, run.id)).candidate?.status,
    { timeout: 30_000, intervals: [100, 250, 500] }).toBe('ready');
  await expect.poll(async () => (await snapshot(request, run.id)).run.status, { timeout: 15_000 }).toBe('blocked');
  return { project, run, before, ctoAttempt, after: await snapshot(request, run.id) };
}

async function openCandidate(page: Page) {
  const tab = page.getByRole('tab', { name: 'Кандидат Clinic Demo', exact: true });
  await tab.focus(); await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Сохранённый кандидат', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

for (const fallback of [false, true]) {
  test(`persists both source areas, immutable provenance and reload${fallback ? ' without WebGL at 430px' : ''}`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    if (fallback) {
      await page.setViewportSize({ width: 430, height: 932 });
      await page.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
          return type.includes('webgl') ? null : Reflect.apply(original, this, [type, ...args]);
        } as typeof original;
      });
    }
    const { run, before, ctoAttempt, after } = await createCandidateRun(page, request, fallback);
    const candidate = after.candidate!;
    expect(after.agent_runs).toHaveLength(5);
    const roles = after.agent_runs!.map(attempt => after.tasks.find(task => task.id === attempt.task_id)!.role).sort();
    expect(roles).toEqual(['architect', 'backend', 'cto', 'frontend', 'product_manager']);
    expect(after.agent_runs!.find(attempt => attempt.id === ctoAttempt.id)).toEqual(ctoAttempt);
    expect(after.agent_runs!.every(attempt => attempt.status === 'succeeded' && attempt.provider === 'test')).toBe(true);
    expect(after.usage).toMatchObject({ source: 'test', request_count: 5, cost_usd: 0 });
    expect(after.run.blocked_reason).toMatch(/QA.*preview/iu);
    expect(hydrateSnapshot(after).candidate).toEqual(candidate);
    expect(candidate.revision).toBe(3);
    const sources = candidate.files.filter(file => file.origin === 'test_injected');
    expect(sources).toHaveLength(6);
    expect(sources.filter(file => file.relative_path.startsWith('backend/'))).toHaveLength(3);
    expect(sources.filter(file => file.relative_path.startsWith('frontend/'))).toHaveLength(3);
    expect(candidate.files.some(file => file.origin === 'template')).toBe(true);
    const originals = new Map(before.artifacts.map(artifact => [artifact.id, artifact]));
    for (const artifact of after.artifacts) if (originals.has(artifact.id)) expect(artifact).toEqual(originals.get(artifact.id));

    const candidateResponse = await request.get(`/api/runs/${run.id}/candidate`);
    expect(candidateResponse.ok()).toBe(true);
    expect(await candidateResponse.json() as CandidateView).toEqual(candidate);
    const artifactsResponse = await request.get(`/api/runs/${run.id}/artifacts`);
    expect(artifactsResponse.ok()).toBe(true);
    expect(await artifactsResponse.json()).toEqual(after.artifacts);
    const manifestResponse = await request.get(`/api/artifacts/${candidate.manifest_artifact_id}/content`);
    expect(manifestResponse.ok()).toBe(true);
    expect(manifestResponse.headers()['x-content-type-options']).toBe('nosniff');
    const manifest: ArtifactContent = await manifestResponse.json();
    expect(createHash('sha256').update(manifest.content, 'utf8').digest('hex')).toBe(candidate.manifest_hash);
    expect(Buffer.byteLength(manifest.content, 'utf8')).toBe(candidate.manifest_byte_size);
    expect(JSON.parse(manifest.content)).toMatchObject({ candidate_id: candidate.id, revision: 3, files: candidate.files });
    const manifestArtifacts = after.artifacts.filter(item => item.artifact_type === 'candidate_manifest').sort((a, b) => a.version - b.version);
    expect(manifestArtifacts.map(item => item.version)).toEqual([1, 2, 3]);
    for (const [index, artifact] of manifestArtifacts.entries()) {
      expect(artifact.provenance!.parent_artifact_id).toBe(index ? manifestArtifacts[index - 1].id : null);
    }
    const sourceTexts = new Map<string, string>();
    for (const file of sources) {
      const response = await request.get(`/api/artifacts/${file.artifact_id}/content`);
      expect(response.ok()).toBe(true);
      const content: ArtifactContent = await response.json();
      expect(content.artifact_id).toBe(file.artifact_id);
      expect(createHash('sha256').update(content.content, 'utf8').digest('hex')).toBe(file.content_hash);
      expect(Buffer.byteLength(content.content, 'utf8')).toBe(file.byte_size);
      expect(content.content.trim().length).toBeGreaterThan(100);
      sourceTexts.set(file.artifact_id, content.content);
      const producer = after.agent_runs!.find(attempt => attempt.id === file.producer_id)!;
      expect(after.tasks.find(task => task.id === producer.task_id)!.role).toBe(file.producer_role);
      if (file.parent_artifact_id) {
        const parent = after.artifacts.find(artifact => artifact.id === file.parent_artifact_id)!;
        expect(parent.content_hash).toBe(file.parent_hash);
        expect(parent.relative_path).toBe(file.relative_path);
        expect(parent.version).toBeLessThan(file.version);
      } else expect(file.parent_hash).toBeNull();
    }
    const events: DomainEvent[] = [];
    let cursor = 0;
    for (;;) {
      const response = await request.get(`/api/runs/${run.id}/events?after_seq=${cursor}&limit=5`);
      expect(response.ok()).toBe(true);
      const eventPage: EventsPage = await response.json();
      events.push(...eventPage.events); cursor = eventPage.next_after_seq;
      if (!eventPage.has_more) break;
    }
    expect(normalizeSnapshot(projectHistory(events, after.last_event_seq))).toEqual(normalizeSnapshot(after));
    const manifests = events.flatMap(event => event.event_type === 'workflow.updated' && event.payload.candidate ? [event.payload.candidate] : []);
    expect(new Set(manifests.map(item => item.revision))).toEqual(new Set([1, 2, 3]));
    for (const historical of manifests) for (const file of historical.files) {
      const artifact = after.artifacts.find(item => item.id === file.artifact_id)!;
      expect(artifact.content_hash).toBe(file.content_hash);
      expect(artifact.version).toBe(file.version);
    }

    let panel = await openCandidate(page);
    await expect(panel).toHaveAttribute('data-candidate-revision', '3');
    await expect(panel).toContainText('QA и preview пока недоступны');
    await expect(panel.locator('[data-candidate-file]')).toHaveCount(candidate.files.length);
    expect(await panel.locator('iframe').count()).toBe(0);
    for (const area of ['backend/', 'frontend/']) {
      const file = sources.find(item => item.relative_path.startsWith(area))!;
      await panel.locator(`button[data-artifact-id="${file.artifact_id}"]`).click();
      const text = page.locator('.artifact-document .artifact-content');
      await expect(text).toHaveText(sourceTexts.get(file.artifact_id)!);
      await expect(page.locator('.document-provenance')).toContainText('ТЕСТ · заглушка');
      panel = await openCandidate(page);
    }
    const produced = sources[0];
    const fileRow = panel.locator(`[data-candidate-file="${produced.relative_path}"]`);
    await fileRow.getByText('Происхождение файла', { exact: true }).click();
    await fileRow.locator(`button[data-attempt-id="${produced.producer_id}"]`).click();
    await expect(page.locator('.worker-data .attempt-entry')).toHaveCount(1);
    await expect(page.locator('.worker-data .attempt-entry')).toHaveAttribute('data-attempt-id', produced.producer_id!);
    panel = await openCandidate(page);
    await panel.locator(`button[data-artifact-id="${candidate.manifest_artifact_id}"]`).click();
    await expect(page.locator('.artifact-document .artifact-content')).toHaveText(manifest.content);
    panel = await openCandidate(page);
    if (!fallback) await captureSettled(page, testInfo.outputPath('candidate-1366.png'));
    else {
      await expect(page.getByRole('tab', { name: 'Кандидат Clinic Demo' })).toBeInViewport({ ratio: 0.9 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('candidate-fallback-430.png'), fullPage: true });
    }
    await page.reload();
    if (fallback) await expect(page.getByRole('heading', { name: '3D-сцена недоступна' })).toBeVisible();
    else await waitForSceneReady(page);
    panel = await openCandidate(page);
    await expect(panel).toHaveAttribute('data-candidate-id', candidate.id);
    await expect(panel).toHaveAttribute('data-candidate-revision', String(candidate.revision));
    await panel.getByText('Хэши SHA-256 профиля и версии', { exact: true }).click();
    await expect(panel).toContainText(candidate.tree_hash);
    const reloaded = await snapshot(request, run.id);
    expect(reloaded.candidate).toEqual(candidate);
    expect(reloaded.agent_runs).toEqual(after.agent_runs);
    expect(reloaded.last_event_seq).toBe(after.last_event_seq);
  });
}

test('seeded candidate snapshots equal paginated event prefixes across parallel and paused workflows', async ({ request }) => {
  test.setTimeout(240_000);
  const scenario = fc.record({
    parallel: fc.constantFrom(1, 2),
    pauseAt: fc.constantFrom('before_cto', 'engineers'),
    pageSizes: fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 2, maxLength: 5 }),
    revisions: fc.subarray([1, 2], { minLength: 1, maxLength: 2 }),
  });
  await fc.assert(fc.asyncProperty(scenario, async ({ parallel, pauseAt, pageSizes, revisions }) => {
    const headers = await commandHeaders(request);
    await cancelOpenRuns(request, headers);
    await expect.poll(async () => {
      const response = await request.get('/api/projects');
      expect(response.ok()).toBe(true);
      const projects: ProjectView[] = await response.json();
      const histories = await Promise.all(projects.map(async project => {
        const history = await request.get(`/api/projects/${project.id}/runs`);
        expect(history.ok()).toBe(true);
        return history.json() as Promise<RunView[]>;
      }));
      return histories.flat().every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status));
    }, { timeout: 20_000 }).toBe(true);
    const projectResponse = await request.post('/api/projects', {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { name: 'Seeded candidate ' + randomUUID().slice(0, 6), description: 'Синтетические данные для проверки candidate projection.' },
    });
    expect(projectResponse.status()).toBe(201);
    const project: ProjectView = await projectResponse.json();
    const runResponse = await request.post(`/api/projects/${project.id}/runs`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { mode: 'test', limits: { max_parallel_tasks: parallel } },
    });
    expect(runResponse.status()).toBe(201);
    const run: RunView = await runResponse.json();
    const knownArtifacts = new Map<string, Snapshot['artifacts'][number]>();
    const knownManifests = new Map<number, { id: string; hash: string | null | undefined; files: CandidateView['files'] }>();
    const verifiedContents = new Set<string>();
    let sampledPrefixes = 0;

    async function assertPrefix(saved: Snapshot) {
      const events: DomainEvent[] = [];
      let cursor = 0;
      let pageIndex = sampledPrefixes;
      while (cursor < saved.last_event_seq) {
        const response = await request.get(`/api/runs/${run.id}/events?after_seq=${cursor}&limit=${pageSizes[pageIndex++ % pageSizes.length]}`);
        expect(response.ok()).toBe(true);
        const eventPage: EventsPage = await response.json();
        const prefix = eventPage.events.filter(event => event.seq <= saved.last_event_seq);
        expect(prefix.length).toBeGreaterThan(0);
        events.push(...prefix);
        cursor = prefix.at(-1)!.seq;
      }
      expect(events.map(event => event.seq)).toEqual(Array.from({ length: saved.last_event_seq }, (_, index) => index + 1));
      expect(normalizeSnapshot(projectHistory(events, saved.last_event_seq))).toEqual(normalizeSnapshot(saved));
      for (const [id, previous] of knownArtifacts) expect(saved.artifacts.find(item => item.id === id)).toEqual(previous);
      for (const artifact of saved.artifacts) knownArtifacts.set(artifact.id, structuredClone(artifact));
      if (saved.candidate) {
        const candidate = saved.candidate;
        sampledPrefixes++;
        expect(candidate.files.length).toBeGreaterThan(0);
        expect(hydrateSnapshot(saved).candidate).toEqual(candidate);
        const immutable = { id: candidate.manifest_artifact_id, hash: candidate.manifest_hash, files: candidate.files };
        if (knownManifests.has(candidate.revision)) expect(immutable).toEqual(knownManifests.get(candidate.revision));
        knownManifests.set(candidate.revision, structuredClone(immutable));
        const chain = saved.artifacts.filter(item => item.artifact_type === 'candidate_manifest').sort((a, b) => a.version - b.version);
        for (const [index, artifact] of chain.entries()) {
          expect(artifact.version).toBe(index + 1);
          expect(artifact.provenance!.parent_artifact_id).toBe(index ? chain[index - 1].id : null);
          if (!verifiedContents.has(artifact.id)) {
            const response = await request.get(`/api/artifacts/${artifact.id}/content`);
            expect(response.ok()).toBe(true);
            const content: ArtifactContent = await response.json();
            expect(createHash('sha256').update(content.content, 'utf8').digest('hex')).toBe(artifact.content_hash);
            expect(Buffer.byteLength(content.content, 'utf8')).toBe(artifact.byte_size);
            expect(JSON.parse(content.content)).toMatchObject({ candidate_id: candidate.id, run_id: run.id, revision: artifact.version });
            verifiedContents.add(artifact.id);
          }
        }
      }
    }

    async function command(value: 'pause' | 'resume' | 'cancel') {
      const response = await request.post(`/api/runs/${run.id}/commands`, {
        headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { command: value },
      });
      expect(response.ok()).toBe(true);
    }
    if (pauseAt === 'before_cto') {
      await command('pause');
      await expect.poll(async () => (await snapshot(request, run.id)).run.status, { timeout: 20_000 }).toBe('paused');
      await assertPrefix(await snapshot(request, run.id));
      await command('resume');
    }
    await expect.poll(async () => (await snapshot(request, run.id)).decisions?.filter(item => item.status === 'open').length,
      { timeout: 30_000, intervals: [100, 250, 500] }).toBe(1);
    const reviewed = await snapshot(request, run.id);
    await assertPrefix(reviewed);
    const decision = reviewed.decisions![0];
    const approval = await request.post(`/api/decisions/${decision.id}/resolve`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { version: decision.version, choice: 'approve', comment: '' },
    });
    expect(approval.ok()).toBe(true);
    if (pauseAt === 'engineers') {
      await expect.poll(async () => {
        const saved = await snapshot(request, run.id);
        return saved.run.status === 'running' && saved.tasks.some(task => ['backend', 'frontend'].includes(task.role) && task.status === 'running');
      }, { timeout: 20_000, intervals: [50, 100] }).toBe(true);
      await command('pause');
      await expect.poll(async () => (await snapshot(request, run.id)).run.status, { timeout: 20_000 }).toBe('paused');
      await assertPrefix(await snapshot(request, run.id));
      await command('resume');
    }
    for (const revision of revisions) {
      let saved!: Snapshot;
      await expect.poll(async () => {
        saved = await snapshot(request, run.id);
        return saved.candidate?.revision ?? 0;
      }, { timeout: 30_000, intervals: [100, 250] }).toBeGreaterThanOrEqual(revision);
      await assertPrefix(saved);
    }
    await expect.poll(async () => (await snapshot(request, run.id)).candidate?.status,
      { timeout: 30_000, intervals: [100, 250, 500] }).toBe('ready');
    const final = await snapshot(request, run.id);
    await assertPrefix(final);
    expect(sampledPrefixes).toBeGreaterThanOrEqual(2);
    expect(final.candidate!.files.filter(file => file.origin === 'test_injected')).toHaveLength(6);
    const dispatched = final.agent_runs!.filter(attempt => attempt.parameters.dispatched === true);
    const undispatched = final.agent_runs!.filter(attempt => attempt.parameters.dispatched !== true);
    expect(dispatched).toHaveLength(5);
    expect(dispatched.every(attempt => attempt.status === 'succeeded' && attempt.started_at !== null)).toBe(true);
    expect(dispatched.map(attempt => final.tasks.find(task => task.id === attempt.task_id)!.role).sort())
      .toEqual(['architect', 'backend', 'cto', 'frontend', 'product_manager']);
    for (const attempt of undispatched) {
      expect(attempt).toMatchObject({ status: 'cancelled', started_at: null, provider_request_id: null, stop_reason: null,
        parameters: { dispatched: false } });
      expect(final.artifacts.some(artifact => artifact.provenance?.producer_id === attempt.id)).toBe(false);
      expect(final.candidate!.files.some(file => file.producer_id === attempt.id)).toBe(false);
    }
    expect(final.usage?.request_count).toBe(5);
    const ctoTask = final.tasks.find(task => task.role === 'cto')!;
    expect(dispatched.filter(attempt => attempt.task_id === ctoTask.id)).toHaveLength(1);
    await command('cancel');
    const cancelled = await snapshot(request, run.id);
    await assertPrefix(cancelled);
    expect(cancelled.candidate).toEqual(final.candidate);
  }), { seed: 20261124, numRuns: 8, endOnFailure: true, verbose: true });
});
