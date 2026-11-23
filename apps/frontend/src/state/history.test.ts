import { describe, expect, it } from 'vitest';
import type { DomainEvent, Snapshot } from '../../../../packages/contracts';
import { normalizeSnapshot, projectHistory } from './projection';
import { makeEvent, makeSnapshot, testTask } from './fixtures';

function creation(): DomainEvent {
  const snapshot = makeSnapshot();
  return { ...makeEvent(), event_type: 'run.created', payload: { project: snapshot.project, run: { ...snapshot.run, last_event_seq: 1 }, agents: [] } };
}

describe('persisted history projection', () => {
  it('reconstructs a continuous prefix beginning with run.created', () => {
    const result = projectHistory([creation(), makeEvent(2)], 2);
    expect(result.project).toEqual(makeSnapshot().project);
    expect(result.tasks).toEqual([testTask]);
    expect(result.run.status).toBe('created');
    expect(result.last_event_seq).toBe(2);
    expect(result.run.last_event_seq).toBe(2);
  });

  it('accepts run.created alone as a valid nonterminal prefix', () => {
    const result = projectHistory([creation()]);
    expect(result.tasks).toEqual([]);
    expect(result.run.status).toBe('created');
    expect(result.last_event_seq).toBe(1);
  });

  it('rejects an empty history and a history without the creation event', () => {
    expect(() => projectHistory([])).toThrowError('invalid_history');
    expect(() => projectHistory([makeEvent()])).toThrowError('invalid_history');
  });

  it('rejects a sequence gap and an incomplete requested suffix', () => {
    expect(() => projectHistory([creation(), makeEvent(3)])).toThrowError('event_gap');
    expect(() => projectHistory([creation()], 2)).toThrowError('event_gap');
  });

  it('rejects a second run.created event', () => {
    expect(() => projectHistory([creation(), { ...creation(), seq: 2 }])).toThrowError('invalid_history');
  });

  it('rejects mixed runs and mixed projects', () => {
    expect(() => projectHistory([creation(), { ...makeEvent(2), run_id: 'other-run' }])).toThrowError('foreign_run');
    expect(() => projectHistory([creation(), { ...makeEvent(2), project_id: 'other-project' }])).toThrowError('foreign_run');
  });

  it('validates the initial schema and every later event type', () => {
    expect(() => projectHistory([{ ...creation(), schema_version: 2 } as unknown as DomainEvent])).toThrowError('unsupported_schema');
    expect(() => projectHistory([creation(), { ...makeEvent(2), event_type: 'future.event' } as unknown as DomainEvent])).toThrowError('unsupported_event');
  });

  it('matches the persisted final state after an actual state-replacement event', () => {
    const snapshot = makeSnapshot();
    const cancelled: Snapshot = {
      ...snapshot, run: { ...snapshot.run, status: 'cancelled', finished_at: '2026-11-14T10:05:00Z', last_event_seq: 3 },
      tasks: [{ ...testTask, status: 'cancelled', record_version: 2 }], last_event_seq: 3,
    };
    const event: DomainEvent = { ...makeEvent(3), event_type: 'run.cancelled', payload: { run: cancelled.run, tasks: cancelled.tasks, agents: cancelled.agents } };
    expect(projectHistory([creation(), makeEvent(2), event], 3)).toEqual(cancelled);
  });
});

describe('snapshot normalization', () => {
  it('sorts entity arrays by their real IDs without changing identity or state values', () => {
    const snapshot = makeSnapshot();
    snapshot.tasks = [{ ...testTask, id: 'task-z', attempt: 3, dependencies: ['b', 'a'] }, { ...testTask, id: 'task-a', status: 'cancelled' }];
    const before = structuredClone(snapshot);
    const result = normalizeSnapshot(snapshot);
    expect(result.tasks.map((task) => task.id)).toEqual(['task-a', 'task-z']);
    expect(result.tasks[1].attempt).toBe(3);
    expect(result.tasks[1].dependencies).toEqual(['b', 'a']);
    expect(result.tasks[0].status).toBe('cancelled');
    expect(result.run.id).toBe(snapshot.run.id);
    expect(result.project.id).toBe(snapshot.project.id);
    expect(result.last_event_seq).toBe(snapshot.last_event_seq);
    expect(snapshot).toEqual(before);
  });

  it('canonicalizes UTC formatting without losing persisted microseconds', () => {
    const left = makeSnapshot();
    left.project.created_at = '2026-11-14T15:00:00.123456+05:00';
    left.run.created_at = '2026-11-14T10:00:00.000000+00:00';
    left.tasks = [{ ...testTask, created_at: '2026-11-14T12:00:00.123456+02:00', lease_expires_at: '2026-11-14T10:01:00.100000Z' }];
    const right = structuredClone(left);
    right.project.created_at = '2026-11-14T10:00:00.123456Z';
    right.run.created_at = '2026-11-14T10:00:00Z';
    right.tasks[0].created_at = '2026-11-14T10:00:00.123456Z';
    right.tasks[0].lease_expires_at = '2026-11-14T10:01:00.1Z';
    expect(normalizeSnapshot(left)).toEqual(right);
    expect(normalizeSnapshot(left).run.started_at).toBeNull();
    expect(left.project.created_at).toBe('2026-11-14T15:00:00.123456+05:00');
  });

  it('does not equate different persisted instants or fabricate UTC for ambiguous timestamps', () => {
    const left = makeSnapshot();
    const right = makeSnapshot();
    left.run.created_at = '2026-11-14T10:00:00.123456Z';
    right.run.created_at = '2026-11-14T10:00:00.123457Z';
    expect(normalizeSnapshot(left)).not.toEqual(normalizeSnapshot(right));
    right.run.created_at = '2026-11-14T10:00:00';
    expect(() => normalizeSnapshot(right)).toThrowError('invalid_timestamp');
  });
});
