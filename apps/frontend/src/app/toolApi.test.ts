import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('reads abortable tools and posts the exact authenticated, idempotent command', async () => {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push([path, init]);
    return new Response(JSON.stringify(path === '/api/session' ? { command_token: 'session-token' } : []));
  }));
  const { api } = await import('./api');
  expect(api).toHaveProperty('tools'); expect(api).toHaveProperty('queueTool');
  const controller = new AbortController();
  await api.tools('run /one', controller.signal);
  const command = { operation_id: 'validate_backend' as const, workspace_id: 'candidate-one', snapshot_version: 3 };
  await api.queueTool('run /one', command, 'same-key');
  expect(calls[0][0]).toBe('/api/runs/run%20%2Fone/tools');
  controller.abort(); expect(calls[0][1].signal!.aborted).toBe(true);
  const [path, init] = calls.at(-1)!;
  expect(path).toBe('/api/runs/run%20%2Fone/tools/commands');
  expect(JSON.parse(init.body as string)).toEqual(command);
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Idempotency-Key')).toBe('same-key');
  expect(new Headers(init.headers).get('X-CodeHead-Token')).toBe('session-token');
});
