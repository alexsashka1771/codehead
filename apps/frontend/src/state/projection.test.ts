import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../../../packages/contracts';
import { applyEvent, hydrateSnapshot, normalizeSnapshot, projectHistory, ProjectionError } from './projection';
import { makeEvent, makeSnapshot, testTask } from './fixtures';
import { makeWorkerSnapshot, makeWorkflowEvent } from './workerFixtures';

describe('event projection', () => {
  it('adds a queued task and advances both snapshot and run cursors', () => {
    const result = applyEvent(makeSnapshot(), makeEvent());
    expect(result.tasks).toEqual([testTask]);
    expect(result.last_event_seq).toBe(1);
    expect(result.run.last_event_seq).toBe(1);
  });

  it('does not mutate the snapshot or the received event', () => {
    const snapshot = makeSnapshot();
    const event = makeEvent();
    const before = structuredClone({ snapshot, event });
    Object.freeze(snapshot.tasks);
    Object.freeze(snapshot.run);
    Object.freeze(snapshot);
    const result = applyEvent(snapshot, event);
    expect({ snapshot, event }).toEqual(before);
    expect(result).not.toBe(snapshot);
    expect(result.run).not.toBe(snapshot.run);
  });

  it('ignores duplicate and older sequence numbers without changing identity', () => {
    const snapshot = { ...makeSnapshot(), last_event_seq: 3 };
    snapshot.run.last_event_seq = 3;
    expect(applyEvent(snapshot, makeEvent(3))).toBe(snapshot);
    expect(applyEvent(snapshot, makeEvent(1))).toBe(snapshot);
  });

  it('rejects a gap so the transport can backfill instead of losing events', () => {
    expect(() => applyEvent(makeSnapshot(), makeEvent(2))).toThrowError(ProjectionError);
    expect(() => applyEvent(makeSnapshot(), makeEvent(2))).toThrowError('event_gap');
  });

  it('rejects an event from a different run, even if its sequence is old', () => {
    const event = { ...makeEvent(), run_id: 'another-run', seq: 0 };
    expect(() => applyEvent(makeSnapshot(), event)).toThrowError('foreign_run');
  });

  it('rejects a foreign project', () => {
    expect(() => applyEvent(makeSnapshot(), { ...makeEvent(), project_id: 'other-project' })).toThrowError('foreign_run');
  });

  it('rejects an unsupported event schema', () => {
    const event = { ...makeEvent(), schema_version: 2 } as unknown as DomainEvent;
    expect(() => applyEvent(makeSnapshot(), event)).toThrowError('unsupported_schema');
  });

  it('rejects an unknown event type instead of advancing the cursor', () => {
    const event = { ...makeEvent(), event_type: 'task.future' } as unknown as DomainEvent;
    expect(() => applyEvent(makeSnapshot(), event)).toThrowError('unsupported_event');
  });

  it('replaces persisted tasks and agents when a run is cancelled', () => {
    const snapshot = makeSnapshot();
    snapshot.tasks = [testTask];
    const event: DomainEvent = {
      ...makeEvent(), event_type: 'run.cancelled',
      payload: { run: { ...snapshot.run, status: 'cancelled', last_event_seq: 1 }, tasks: [{ ...testTask, status: 'cancelled' }], agents: [] },
    };
    const result = applyEvent(snapshot, event);
    expect(result.run.status).toBe('cancelled');
    expect(result.tasks[0].status).toBe('cancelled');
    expect(result.run.last_event_seq).toBe(result.last_event_seq);
    expect(snapshot.tasks[0].status).toBe('queued');
  });

  it('applies run.created without inventing tasks or agent activity', () => {
    const snapshot = makeSnapshot();
    const event: DomainEvent = {
      ...makeEvent(), event_type: 'run.created',
      payload: { run: { ...snapshot.run, last_event_seq: 1 }, project: snapshot.project, agents: [] },
    };
    const result = applyEvent(snapshot, event);
    expect(result.run.status).toBe('created');
    expect(result.last_event_seq).toBe(1);
    expect(result.tasks).toEqual([]);
    expect(result.agents).toEqual([]);
  });
});

describe('persisted worker projection', () => {
  it('applies complete workflow views, usage and decision versions without adding payload action to state', () => {
    const event = makeWorkflowEvent();
    const result = applyEvent(makeSnapshot(), event);
    expect(result).toEqual({ ...makeWorkerSnapshot(), last_event_seq: 1,
      run: { ...makeWorkerSnapshot().run, last_event_seq: 1 } });
    expect(result.agent_runs?.[0].provider_request_id).toBe('test-request-cto');
    expect(result.decisions?.[0].version).toBe(2);
    expect(result.usage?.cost_usd).toBe(0);
    expect(result).not.toHaveProperty('action');
  });

  it('replays nonempty worker history to the same persisted snapshot including microseconds and provenance', () => {
    const snapshot = makeSnapshot();
    const first: DomainEvent = { ...makeEvent(), event_type: 'run.created',
      payload: { project: snapshot.project, run: { ...snapshot.run, mode: 'test', last_event_seq: 1 }, agents: [],
        usage: { ...makeWorkerSnapshot().usage!, request_count: 0 } } };
    expect(normalizeSnapshot(projectHistory([first, makeWorkflowEvent(2)], 2)))
      .toEqual(normalizeSnapshot(makeWorkerSnapshot()));
  });

  it('preserves attempts, decisions and usage through legacy run state changes', () => {
    const snapshot = makeWorkerSnapshot();
    const paused: DomainEvent = { ...makeEvent(3), event_type: 'run.paused',
      payload: { run: { ...snapshot.run, status: 'paused', last_event_seq: 3 },
        tasks: snapshot.tasks, agents: snapshot.agents } };
    const result = applyEvent(snapshot, paused);
    expect(result.agent_runs).toEqual(snapshot.agent_runs);
    expect(result.decisions).toEqual(snapshot.decisions);
    expect(result.artifacts).toEqual(snapshot.artifacts);
    expect(result.usage).toEqual(snapshot.usage);
  });

  it('rejects foreign nested views even when a duplicate event would not change the snapshot', () => {
    const snapshot = makeWorkerSnapshot();
    const event = makeWorkflowEvent(snapshot.last_event_seq);
    event.payload.agent_runs[0].run_id = 'foreign-run';
    expect(() => applyEvent(snapshot, event)).toThrowError('foreign_run');
    const queued = makeEvent(snapshot.last_event_seq);
    queued.payload.task.run_id = 'foreign-run';
    expect(() => applyEvent(snapshot, queued)).toThrowError('foreign_run');
  });

  it.each(['run', 'task', 'agent', 'artifact', 'attempt', 'decision', 'attempt_task', 'attempt_agent', 'decision_artifact'])
  ('rejects a wrong nested %s identity instead of mixing runs', (entity) => {
    const event = makeWorkflowEvent();
    if (entity === 'run') event.payload.run.project_id = 'foreign-project';
    if (entity === 'task') event.payload.tasks[0].run_id = 'foreign-run';
    if (entity === 'agent') event.payload.agents[0].run_id = 'foreign-run';
    if (entity === 'artifact') event.payload.artifacts[0].run_id = 'foreign-run';
    if (entity === 'attempt') event.payload.agent_runs[0].run_id = 'foreign-run';
    if (entity === 'decision') event.payload.decisions[0].run_id = 'foreign-run';
    if (entity === 'attempt_task') event.payload.agent_runs[0].task_id = 'foreign-task';
    if (entity === 'attempt_agent') event.payload.agent_runs[0].agent_id = 'foreign-agent';
    if (entity === 'decision_artifact') event.payload.decisions[0].artifact_ids = ['foreign-artifact'];
    expect(() => applyEvent(makeSnapshot(), event)).toThrowError('foreign_run');
  });

  it('hydrates old snapshots with compatibility defaults while keeping unknown live usage unknown', () => {
    const snapshot = makeSnapshot();
    snapshot.tasks = [structuredClone(testTask)];
    delete snapshot.agent_runs; delete snapshot.decisions; delete snapshot.usage;
    delete snapshot.run.cancel_requested; delete snapshot.run.pause_requested; delete snapshot.tasks[0].fencing_token;
    delete snapshot.candidate; delete snapshot.run.profile_version; delete snapshot.run.profile_hash;
    delete snapshot.run.acceptance_suite_hash; delete snapshot.run.limits.max_file_bytes;
    delete snapshot.run.limits.max_files_per_proposal; delete snapshot.run.limits.max_proposal_bytes;
    delete snapshot.tasks[0].active_attempt_id; delete snapshot.tasks[0].blocked_reason;
    const before = structuredClone(snapshot);
    const result = hydrateSnapshot(snapshot);
    expect(result.agent_runs).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.usage).toBeNull();
    expect(result.run.cancel_requested).toBe(false);
    expect(result.run.pause_requested).toBe(false);
    expect(result.candidate).toBeNull();
    expect(result.run.profile_version).toBeNull();
    expect(result.run.profile_hash).toBeNull();
    expect(result.run.acceptance_suite_hash).toBeNull();
    expect(result.run.limits).toMatchObject({ max_file_bytes: 65536, max_files_per_proposal: 4, max_proposal_bytes: 262144 });
    expect(result.tasks[0]).toMatchObject({ fencing_token: 0, active_attempt_id: null, blocked_reason: null });
    expect(snapshot).toEqual(before);
  });

  it('normalizes worker array order and UTC formatting without changing versions, IDs, usage or trace metadata', () => {
    const snapshot = makeWorkerSnapshot();
    snapshot.agent_runs![0].created_at = '2026-11-24T15:00:00.123456+05:00';
    snapshot.decisions![0].created_at = '2026-11-24T15:00:02.123456+05:00';
    expect(normalizeSnapshot(snapshot)).toEqual(makeWorkerSnapshot());
    expect(snapshot.agent_runs![0].created_at).toBe('2026-11-24T15:00:00.123456+05:00');
  });

  it('defaults legacy decisions to blocking and preserves an explicit nonblocking reconciliation', () => {
    const legacy = makeWorkerSnapshot();
    const { blocking: _ignored, ...decision } = legacy.decisions![0];
    legacy.decisions = [decision];
    expect(hydrateSnapshot(legacy).decisions?.[0]).toHaveProperty('blocking', true);
    const followUp = { ...decision, blocking: false };
    legacy.decisions = [followUp];
    expect(normalizeSnapshot(legacy).decisions?.[0]).toHaveProperty('blocking', false);
    expect(hydrateSnapshot(legacy).decisions?.[0]).toHaveProperty('blocking', false);
  });
});
