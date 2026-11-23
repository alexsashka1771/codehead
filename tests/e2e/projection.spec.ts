import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { DomainEvent, EventsPage, Snapshot } from '../../packages/contracts';
import { normalizeSnapshot, projectHistory } from '../../apps/frontend/src/state/projection';
import { createRun } from './helpers';

test('PostgreSQL snapshot equals the event projection for generated command sequences', async ({ request }) => {
  test.setTimeout(90_000);
  const actions = fc.array(fc.constantFrom('toggle', 'duplicate', 'cancel'), { maxLength: 12 });
  await fc.assert(fc.asyncProperty(actions, async (sequence) => {
    const { run, headers } = await createRun(request);
    let paused = false;
    let cancelled = false;
    let previous: { key: string; command: string; response: unknown } | null = null;

    async function assertProjection() {
      const response = await request.get(`/api/runs/${run.id}/snapshot`);
      expect(response.ok()).toBe(true);
      const snapshot: Snapshot = await response.json();
      const events: DomainEvent[] = [];
      let cursor = 0;
      do {
        const result = await request.get(`/api/runs/${run.id}/events?after_seq=${cursor}&limit=3`);
        expect(result.ok()).toBe(true);
        const page: EventsPage = await result.json();
        events.push(...page.events);
        cursor = page.next_after_seq;
        if (!page.has_more) break;
      } while (cursor < snapshot.last_event_seq);
      const projected = projectHistory(events, snapshot.last_event_seq);
      // IDs, dependencies, versions, usage fields and microseconds must survive.
      expect(normalizeSnapshot(projected)).toEqual(normalizeSnapshot(snapshot));
    }

    async function command(value: string, key = randomUUID()) {
      const response = await request.post(`/api/runs/${run.id}/commands`, {
        headers: { ...headers, 'Idempotency-Key': key }, data: { command: value },
      });
      expect(response.ok()).toBe(true);
      return { key, command: value, response: await response.json() };
    }

    await assertProjection();
    for (const action of sequence) {
      if (cancelled) break;
      if (action === 'duplicate' && previous) {
        const duplicate = await command(previous.command, previous.key);
        expect(duplicate.response).toEqual(previous.response);
      } else {
        const value = action === 'cancel' ? 'cancel' : paused ? 'resume' : 'pause';
        previous = await command(value);
        if (value === 'cancel') cancelled = true;
        else paused = !paused;
      }
      await assertProjection();
    }
    if (!cancelled) await command('cancel');
    await assertProjection();
  }), { seed: 20261114, numRuns: 32, verbose: true });
});
