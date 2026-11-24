import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const invalidToken = { code: 'invalid_command_token', message: 'Token expired', correlation_id: 'test-correlation', retriable: true };

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('command authentication transport', () => {
  it('provides abortable read-only candidate and artifact-list endpoints scoped to the selected run', async () => {
    const paths: string[] = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      paths.push(path); signals.push(options.signal as AbortSignal);
      expect(options.method).toBeUndefined();
      return json(path.endsWith('/candidate') ? null : []);
    }));
    const { api } = await import('./api');
    expect(api).toHaveProperty('candidate');
    expect(api).toHaveProperty('artifacts');
    const controller = new AbortController();
    await api.candidate('run/one', controller.signal);
    await api.artifacts('run/one', controller.signal);
    controller.abort();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(paths).toEqual(['/api/runs/run%2Fone/candidate', '/api/runs/run%2Fone/artifacts']);
  });

  it('starts test execution only through an explicit mode and keeps live as the default', async () => {
    const modes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/session') return json({ command_token: 'memory-token' });
      modes.push(JSON.parse(options.body as string).mode);
      return json({ id: 'saved-run' });
    }));
    const { api } = await import('./api');
    await api.start('project-one', 'live-key');
    await api.start('project-one', 'test-key', 'test');
    expect(modes).toEqual(['live', 'test']);
  });

  it('resolves the reviewed decision version using the shared command token and original receipt key', async () => {
    const mutations: { path: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/session') return json({ command_token: 'memory-token' });
      mutations.push({ path, options });
      return json({ id: 'run-one' });
    }));
    const { api } = await import('./api');
    await api.resolveDecision('decision/one', { version: 3, choice: 'approve', comment: '' }, 'decision-intent');
    const [{ path, options }] = mutations;
    expect(path).toBe('/api/decisions/decision%2Fone/resolve');
    expect(JSON.parse(options.body as string)).toEqual({ version: 3, choice: 'approve', comment: '' });
    expect(new Headers(options.headers).get('X-CodeHead-Token')).toBe('memory-token');
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe('decision-intent');
  });

  it('aborts immutable trace and content reads when their selection is cancelled', async () => {
    const signals: AbortSignal[] = [];
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      paths.push(path); signals.push(options.signal as AbortSignal);
      return json({});
    }));
    const { api } = await import('./api');
    const controller = new AbortController();
    await api.attemptTrace('attempt/one', controller.signal);
    await api.artifactContent('artifact/one', controller.signal);
    controller.abort();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(paths).toEqual(['/api/agent-runs/attempt%2Fone/trace', '/api/artifacts/artifact%2Fone/content']);
  });

  it('obtains a session token once in memory and includes it on every mutation', async () => {
    const requests: { path: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      requests.push({ path, options });
      return path === '/api/session' ? json({ command_token: 'fresh-memory-token' }) : json({ id: 'saved' });
    }));
    const { api } = await import('./api');
    await api.createProject({ name: 'Clinic', description: 'A clinic project' }, 'project-key');
    await api.start('project-one', 'start-key');
    await api.command('run-one', 'pause', 'pause-key');
    const sessionRequests = requests.filter(({ path }) => path === '/api/session');
    expect(sessionRequests).toHaveLength(1);
    expect(sessionRequests[0].options.cache).toBe('no-store');
    const mutations = requests.filter(({ options }) => options.method === 'POST');
    expect(mutations).toHaveLength(3);
    for (const { path, options } of mutations) {
      const headers = new Headers(options.headers);
      expect(headers.get('X-CodeHead-Token')).toBe('fresh-memory-token');
      expect(headers.get('X-CodeHead-Client')).toBe('browser');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(path).not.toContain('fresh-memory-token');
      expect(options.body).not.toContain('fresh-memory-token');
    }
    expect(mutations.map(({ options }) => new Headers(options.headers).get('Idempotency-Key'))).toEqual(['project-key', 'start-key', 'pause-key']);
  });

  it('refreshes an expired token and retries the identical POST only once', async () => {
    let sessionCount = 0;
    const mutations: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/session') return json({ command_token: ++sessionCount === 1 ? 'before-restart' : 'after-restart' });
      mutations.push(options);
      return new Headers(options.headers).get('X-CodeHead-Token') === 'after-restart' ? json({ id: 'same-run' }) : json(invalidToken, 403);
    }));
    const { api } = await import('./api');
    await expect(api.start('project-one', 'original-intent')).resolves.toEqual({ id: 'same-run' });
    expect(sessionCount).toBe(2);
    expect(mutations).toHaveLength(2);
    expect(mutations[1].method).toBe(mutations[0].method);
    expect(mutations[1].body).toBe(mutations[0].body);
    expect(mutations.map(({ headers }) => new Headers(headers).get('Idempotency-Key'))).toEqual(['original-intent', 'original-intent']);
    expect(mutations.map(({ headers }) => new Headers(headers).get('X-CodeHead-Token'))).toEqual(['before-restart', 'after-restart']);
  });

  it('stops after a second invalid-token response instead of retrying forever', async () => {
    let sessionCount = 0;
    let mutationCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/session') return json({ command_token: `token-${++sessionCount}` });
      mutationCount += 1;
      return json(invalidToken, 403);
    }));
    const { api } = await import('./api');
    await expect(api.command('run-one', 'cancel', 'cancel-key')).rejects.toMatchObject({ status: 403, problem: invalidToken });
    expect(sessionCount).toBe(2);
    expect(mutationCount).toBe(2);
  });

  it('does not refresh authentication for an unrelated forbidden command', async () => {
    let sessionCount = 0;
    let mutationCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/session') { sessionCount += 1; return json({ command_token: 'valid-token' }); }
      mutationCount += 1;
      return json({ ...invalidToken, code: 'origin_forbidden' }, 403);
    }));
    const { api } = await import('./api');
    await expect(api.start('project-one', 'start-key')).rejects.toMatchObject({ status: 403, problem: { code: 'origin_forbidden' } });
    expect(sessionCount).toBe(1);
    expect(mutationCount).toBe(1);
  });

  it('does not send commands after session failure and can recover on the next attempt', async () => {
    let sessionCount = 0;
    let mutationCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/session') return ++sessionCount === 1
        ? json({ code: 'unavailable', message: 'Session unavailable', correlation_id: 'test', retriable: true }, 503)
        : json({ command_token: 'recovered' });
      mutationCount += 1;
      return json({ id: 'run-after-recovery' });
    }));
    const { api } = await import('./api');
    await expect(api.start('project-one', 'retained-intent')).rejects.toMatchObject({ status: 503 });
    expect(mutationCount).toBe(0);
    await expect(api.start('project-one', 'retained-intent')).resolves.toEqual({ id: 'run-after-recovery' });
    expect(sessionCount).toBe(2);
    expect(mutationCount).toBe(1);
  });
});
