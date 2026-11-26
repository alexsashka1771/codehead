import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('separates the no-store preview GET, authenticated commands and the same-origin archive link', async () => {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push([path, init]);
    return new Response(JSON.stringify(path === '/api/session' ? { command_token: 'session-token' } : {}));
  }));
  const { api, deliveryArchiveUrl, startParameters } = await import('./api');
  expect(api).toHaveProperty('preview');
  expect(api).toHaveProperty('commandPreview');
  const controller = new AbortController();
  await api.preview('run /one', controller.signal);
  const command = { command: 'stop' as const, package_id: 'package-one', preview_session_id: 'preview-one', expected_version: 3 };
  await api.commandPreview('run /one', command, 'same-key');
  expect(deliveryArchiveUrl('run /one', 'package/one')).toBe('/api/runs/run%20%2Fone/delivery/package%2Fone/archive');
  expect(startParameters.workflow_version).toBe('clinic-v4');
  expect(calls[0][0]).toBe('/api/runs/run%20%2Fone/preview');
  expect(calls[0][1]).toMatchObject({ cache: 'no-store' });
  expect(calls[0][1].headers).toBeUndefined();
  controller.abort(); expect(calls[0][1].signal!.aborted).toBe(true);
  const [path, init] = calls.at(-1)!;
  expect(path).toBe('/api/runs/run%20%2Fone/preview/commands');
  expect(init.method).toBe('POST'); expect(JSON.parse(init.body as string)).toEqual(command);
  expect(new Headers(init.headers).get('Idempotency-Key')).toBe('same-key');
  expect(new Headers(init.headers).get('X-CodeHead-Token')).toBe('session-token');
});
