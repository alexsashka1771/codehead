import { describe, expect, it } from 'vitest';
import { applyEvent, hydrateSnapshot, normalizeSnapshot } from './projection';
import { makeCandidateSnapshot } from './candidateFixtures';
import { makeToolEvent, makeToolSnapshot } from './toolFixtures';

describe('persisted Runner projection', () => {
  it.each(['created', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain', 'timed_out'] as const)('retains the exact persisted %s tool status', status => {
    expect(hydrateSnapshot(makeToolSnapshot(status)).tool_runs![0].status).toBe(status);
  });
  it('rejects unsupported tool states including a non-contract queued state', () => {
    const snapshot = makeToolSnapshot(); Object.assign(snapshot.tool_runs![0], { status: 'queued' });
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
  });
  it('defaults legacy tool lists and projects workflow tool results', () => {
    expect(hydrateSnapshot(makeCandidateSnapshot()).tool_runs).toEqual([]);
    expect(applyEvent(makeCandidateSnapshot(), makeToolEvent(4)).tool_runs).toEqual(makeToolSnapshot().tool_runs);
  });
  it('sorts tool IDs and normalizes timestamps including leases without losing microseconds', () => {
    const snapshot = makeToolSnapshot();
    snapshot.tool_runs![0].created_at = '2026-11-24T15:00:01.123456+05:00';
    snapshot.tool_runs![0].lease_expires_at = '2026-11-24T15:01:00+05:00';
    snapshot.tool_runs!.push({ ...snapshot.tool_runs![0], id: 'a-tool' });
    const normalized = normalizeSnapshot(snapshot);
    expect(normalized.tool_runs!.map(tool => tool.id)).toEqual(['a-tool', 'tool-one']);
    expect(normalized.tool_runs![0].created_at).toBe('2026-11-24T10:00:01.123456Z');
    expect(normalized.tool_runs![0].lease_expires_at).toBe('2026-11-24T10:01:00Z');
  });
  it.each(['run_id', 'workspace_id', 'manifest_artifact_id'] as const)('rejects foreign %s in snapshots and stale duplicate events', field => {
    const snapshot = makeToolSnapshot(); snapshot.tool_runs![0][field] = 'foreign';
    expect(() => hydrateSnapshot(snapshot)).toThrow('foreign_run');
    const event = makeToolEvent(2); event.payload.tool_runs![0][field] = 'foreign';
    expect(() => applyEvent(makeCandidateSnapshot(), event)).toThrow('foreign_run');
  });
  it.each(['tree_hash', 'manifest_hash', 'profile_hash', 'profile_version', 'acceptance_suite_hash', 'template_hash'] as const)('rejects mismatched %s pins', field => {
    const snapshot = makeToolSnapshot(); snapshot.tool_runs![0][field] = '0'.repeat(64);
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
  });
  it('rejects duplicate tools and future revisions', () => {
    const snapshot = makeToolSnapshot(); snapshot.tool_runs!.push({ ...snapshot.tool_runs![0] });
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
    snapshot.tool_runs!.pop(); snapshot.tool_runs![0].snapshot_version += 1;
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
  });
  it('retains an old result and its immutable manifest after candidate advancement', () => {
    const snapshot = makeToolSnapshot(); const candidate = snapshot.candidate!;
    const oldManifest = snapshot.artifacts.find(a => a.id === candidate.manifest_artifact_id)!;
    const manifest = { ...oldManifest, id: 'manifest-four', version: 4, content_hash: 'a'.repeat(64),
      provenance: { ...oldManifest.provenance!, parent_artifact_id: oldManifest.id } };
    snapshot.artifacts.push(manifest);
    candidate.revision = 4; candidate.tree_hash = 'b'.repeat(64);
    candidate.manifest_artifact_id = manifest.id; candidate.manifest_hash = manifest.content_hash;
    expect(hydrateSnapshot(snapshot).tool_runs![0].snapshot_version).toBe(3);
  });
  it('requires a same-run tool reference and null task for an uncertain tool decision', () => {
    const snapshot = makeToolSnapshot('uncertain');
    snapshot.decisions = [{ id: 'tool-decision', run_id: snapshot.run.id, task_id: null, attempt_id: null,
      tool_run_id: 'missing', kind: 'tool_uncertain_outcome', status: 'open', version: 1,
      title: 'Исход процесса неизвестен', summary: 'Проверьте процесс', choices: ['confirm_failed'],
      artifact_ids: [], choice: null, comment: null, created_at: snapshot.run.created_at, resolved_at: null }];
    expect(() => hydrateSnapshot(snapshot)).toThrow('foreign_run');
    snapshot.decisions[0].tool_run_id = 'tool-one';
    expect(hydrateSnapshot(snapshot).decisions![0].tool_run_id).toBe('tool-one');
    snapshot.decisions[0].task_id = snapshot.tasks[0].id;
    expect(() => hydrateSnapshot(snapshot)).toThrow('invalid_event');
  });
  it('rejects foreign tool references on stale decision events', () => {
    const event = makeToolEvent(3); event.payload.tool_runs = undefined;
    event.payload.decisions = [{ id: 'tool-decision', run_id: event.run_id, task_id: null, attempt_id: null,
      tool_run_id: 'missing', kind: 'tool_uncertain_outcome', status: 'open', version: 1,
      title: 'Unknown', summary: 'Unknown', choices: ['confirm_failed'], artifact_ids: [], choice: null,
      comment: null, created_at: event.occurred_at, resolved_at: null }];
    expect(() => applyEvent(makeToolSnapshot(), event)).toThrow('foreign_run');
  });
});
