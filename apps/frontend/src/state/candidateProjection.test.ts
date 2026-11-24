import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../../../packages/contracts';
import { applyEvent, hydrateSnapshot, normalizeSnapshot, projectHistory } from './projection';
import { makeEvent, makeSnapshot } from './fixtures';
import { makeCandidateEvent, makeCandidateSnapshot } from './candidateFixtures';

describe('persisted candidate projection', () => {
  it('reconstructs a nonempty immutable file tree with exact versions, IDs, hashes and microseconds', () => {
    const initial = makeSnapshot();
    const first: DomainEvent = { ...makeEvent(1), event_type: 'run.created',
      payload: { project: initial.project, run: { ...initial.run, mode: 'test', workflow_version: 'clinic-v2', last_event_seq: 1 }, agents: [] } };
    const assembling = makeCandidateEvent(2, 'assembling');
    const ready = makeCandidateEvent(3);
    const persisted = makeCandidateSnapshot();
    expect(normalizeSnapshot(projectHistory([first, assembling, ready], 3))).toEqual(normalizeSnapshot(persisted));
    expect(persisted.candidate!.files.filter(file => file.origin === 'test_injected')).toHaveLength(6);
    expect(persisted.candidate!.updated_at).toBe('2026-11-24T10:00:04.654321Z');
  });

  it('retains the candidate when a run is paused using a compatible old event shape', () => {
    const snapshot = makeCandidateSnapshot();
    const paused: DomainEvent = { ...makeEvent(4), event_type: 'run.paused', payload: {
      run: { ...snapshot.run, status: 'paused', last_event_seq: 4 }, tasks: snapshot.tasks, agents: snapshot.agents } };
    expect(applyEvent(snapshot, paused).candidate).toEqual(snapshot.candidate);
  });

  it('normalizes candidate ordering and time once without mutating source IDs or bytes metadata', () => {
    const snapshot = makeCandidateSnapshot();
    snapshot.candidate!.files.reverse();
    snapshot.candidate!.updated_at = '2026-11-24T15:00:04.654321+05:00';
    const before = structuredClone(snapshot);
    const normalized = normalizeSnapshot(snapshot);
    expect(normalizeSnapshot(normalized)).toEqual(normalized);
    expect(normalized.candidate!.updated_at).toBe('2026-11-24T10:00:04.654321Z');
    expect(normalized.candidate!.files.find(file => file.relative_path === 'frontend/src/App.tsx')).toEqual(before.candidate!.files.find(file => file.relative_path === 'frontend/src/App.tsx'));
    expect(snapshot).toEqual(before);
  });

  it.each(['candidate', 'manifest', 'source', 'parent', 'producer'])('rejects a foreign %s reference before mixing candidate and run data', target => {
    const snapshot = makeCandidateSnapshot();
    if (target === 'candidate') snapshot.candidate!.run_id = 'foreign-run';
    if (target === 'manifest') snapshot.candidate!.manifest_artifact_id = 'foreign-manifest';
    if (target === 'source') snapshot.candidate!.files[0].artifact_id = 'foreign-source';
    if (target === 'parent') snapshot.candidate!.files[0].parent_artifact_id = 'foreign-parent';
    if (target === 'producer') snapshot.candidate!.files[0].producer_id = 'foreign-attempt';
    expect(() => hydrateSnapshot(snapshot)).toThrowError('foreign_run');
  });

  it('rejects a source descriptor hash that differs from its persisted immutable artifact', () => {
    const snapshot = makeCandidateSnapshot();
    snapshot.candidate!.files[0].content_hash = '0'.repeat(64);
    expect(() => hydrateSnapshot(snapshot)).toThrowError('invalid_event');
  });

  it.each(['manifest_hash', 'parent_hash', 'version', 'media_type', 'byte_size', 'producer_role', 'input_versions', 'profile_hash', 'template_hash'])('rejects inconsistent candidate %s metadata', target => {
    const snapshot = makeCandidateSnapshot();
    const candidate = snapshot.candidate!;
    const file = candidate.files[0];
    if (target === 'manifest_hash') candidate.manifest_hash = '0'.repeat(64);
    if (target === 'parent_hash') file.parent_hash = '0'.repeat(64);
    if (target === 'version') file.version += 1;
    if (target === 'media_type') file.media_type = 'text/html';
    if (target === 'byte_size') file.byte_size += 1;
    if (target === 'producer_role') file.producer_role = 'frontend';
    if (target === 'input_versions') file.input_versions = { 'contract-one': 99 };
    if (target === 'profile_hash') candidate.profile_hash = '0'.repeat(64);
    if (target === 'template_hash') candidate.template_hash = '0'.repeat(64);
    expect(() => hydrateSnapshot(snapshot)).toThrowError('invalid_event');
  });

  it('rejects foreign source metadata inside a duplicate event before ignoring its cursor', () => {
    const snapshot = makeCandidateSnapshot();
    const event = makeCandidateEvent(snapshot.last_event_seq);
    event.payload.candidate!.files[0].artifact_id = 'foreign-source';
    expect(() => applyEvent(snapshot, event)).toThrowError('foreign_run');
  });

  it('rejects a foreign candidate even when the enclosing event is already delivered', () => {
    const snapshot = makeCandidateSnapshot();
    const event = makeCandidateEvent(snapshot.last_event_seq);
    event.payload.candidate!.run_id = 'foreign-run';
    expect(() => applyEvent(snapshot, event)).toThrowError('foreign_run');
  });

  it.each(['producer_id', 'parent_artifact_id'] as const)('rejects a foreign manifest provenance %s', reference => {
    const snapshot = makeCandidateSnapshot();
    const manifest = snapshot.artifacts.find(item => item.id === snapshot.candidate!.manifest_artifact_id)!;
    manifest.provenance![reference] = 'foreign-reference';
    expect(() => hydrateSnapshot(snapshot)).toThrowError('foreign_run');
  });

  it.each(['foreign-artifact', 'contract-one'])('rejects an invalid latest manifest input version %s', id => {
    const snapshot = makeCandidateSnapshot();
    snapshot.artifacts.find(item => item.id === snapshot.candidate!.manifest_artifact_id)!.input_versions = { [id]: 99 };
    expect(() => hydrateSnapshot(snapshot)).toThrowError(id === 'foreign-artifact' ? 'foreign_run' : 'invalid_event');
  });

  it('validates input versions in the immutable parent manifest chain', () => {
    const snapshot = makeCandidateSnapshot();
    const manifest = snapshot.artifacts.find(item => item.id === snapshot.candidate!.manifest_artifact_id)!;
    snapshot.artifacts.push({ ...manifest, id: 'manifest-parent', version: 2,
      provenance: { ...manifest.provenance!, parent_artifact_id: null }, input_versions: { 'foreign-artifact': 1 } });
    manifest.provenance!.parent_artifact_id = 'manifest-parent';
    expect(() => hydrateSnapshot(snapshot)).toThrowError('foreign_run');
  });
});
