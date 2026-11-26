import { describe, expect, it } from 'vitest';
import { applyEvent, hydrateSnapshot, normalizeSnapshot, projectHistory } from './projection';
import { makeEvent } from './fixtures';
import { makeQualityEvent } from './qualityFixtures';
import { legacyWithoutDelivery, makeDeliverySnapshot } from './previewFixtures';

describe('delivery and preview projection', () => {
  it('hydrates legacy omissions without inventing a package or sessions', () => {
    expect(hydrateSnapshot(legacyWithoutDelivery())).toMatchObject({ delivery: null, preview_sessions: [] });
  });

  it('folds a complete event log to the same published package and selected sessions', () => {
    const published = makeDeliverySnapshot({ readySession: false });
    const running = makeDeliverySnapshot();
    const created = { ...makeEvent(1), event_type: 'run.created' as const, payload: {
      project: published.project, run: { ...published.run, last_event_seq: 1, status: 'created' as const }, agents: [],
    } };
    const ready = makeQualityEvent(published, 2);
    const started = makeQualityEvent(running, 3);
    const projected = projectHistory([created, ready, started]);
    expect(projected.delivery?.package_tree_hash).toBe(running.delivery?.package_tree_hash);
    expect(projected.preview_sessions?.map(session => session.id)).toEqual(['preview-run-one']);
    expect(projected.quality_cycles?.map(cycle => cycle.status)).toEqual(['failed', 'passed']);
    expect(normalizeSnapshot(projected)).toEqual(normalizeSnapshot(hydrateSnapshot(running)));
  });

  it.each([
    ['foreign delivery', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.delivery!.run_id = 'other-run'; }],
    ['legacy workflow', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.run.workflow_version = 'clinic-v3'; }],
    ['old QA cycle', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.delivery!.qa_cycle_id = 'cycle-0'; }],
    ['wrong QA report hash', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.delivery!.qa_report_hash = '1'.repeat(64); }],
    ['wrong build operation', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.delivery!.build_tool_run_id = 'tool-1-1'; }],
    ['smoke tool with a wrong producer link', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.artifacts.find(a => a.id === 'artifact-smoke')!.provenance!.producer_id = 'tool-1-0'; }],
    ['wrong DevOps attempt', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.artifacts.find(a => a.id === 'artifact-runbook')!.provenance!.producer_id = 'attempt-qa-1'; }],
    ['wrong DevOps inputs', (s: ReturnType<typeof makeDeliverySnapshot>) => { delete s.artifacts.find(a => a.id === 'artifact-runbook')!.input_versions['artifact-smoke']; }],
    ['partial package metadata', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.delivery!.package_archive_byte_size = null; }],
    ['different package generation', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.preview_sessions![0].package_generation++; }],
    ['duplicate session versions', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.preview_sessions!.push({ ...s.preview_sessions![0], id: 'another-preview', status: 'failed' }); }],
    ['runtime access bundled in session', (s: ReturnType<typeof makeDeliverySnapshot>) => { Object.assign(s.preview_sessions![0], { origin: 'http://127.0.0.1:45670' }); }],
    ['wrong preview start producer', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.preview_sessions![0].start_tool_run_id = 'tool-smoke'; }],
  ] as const)('rejects %s in a snapshot and event', (_name, mutate) => {
    const snapshot = makeDeliverySnapshot(); mutate(snapshot);
    expect(() => hydrateSnapshot(snapshot)).toThrow();
    expect(() => applyEvent(makeDeliverySnapshot(), makeQualityEvent(snapshot))).toThrow();
  });

  it.each([
    ['published archive changed', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.delivery!.package_archive_hash = 'a'.repeat(64); }],
    ['version moved backward', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.preview_sessions![0].version--; }],
    ['session vanished', (s: ReturnType<typeof makeDeliverySnapshot>) => { s.preview_sessions = []; s.tool_runs = s.tool_runs!.filter(tool => tool.operation_id !== 'start_preview'); }],
  ] as const)('rejects a newer otherwise valid event when the %s', (_name, mutate) => {
    const snapshot = makeDeliverySnapshot(); const changed = structuredClone(snapshot); mutate(changed);
    expect(() => hydrateSnapshot(changed)).not.toThrow();
    expect(() => applyEvent(snapshot, makeQualityEvent(changed))).toThrow('invalid_event');
  });

  it.each(['failed', 'stopped'] as const)('retains completed delivery when a ready preview is observed %s directly', status => {
    const snapshot = makeDeliverySnapshot(); const changed = structuredClone(snapshot);
    const session = changed.preview_sessions![0];
    session.status = status; session.version++; session.finished_at = session.updated_at;
    const projected = applyEvent(snapshot, makeQualityEvent(changed));
    expect(projected.preview_sessions?.[0]).toMatchObject({ status, version: session.version });
    expect(projected.delivery).toEqual(snapshot.delivery);
    expect(projected.quality_cycles).toEqual(snapshot.quality_cycles);
  });

  it('keeps immutable timestamps across equivalent UTC serializations of a package or session', () => {
    const snapshot = makeDeliverySnapshot(); const changed = structuredClone(snapshot);
    changed.delivery!.created_at = changed.delivery!.created_at.replace('Z', '+00:00');
    changed.preview_sessions![0].created_at = changed.preview_sessions![0].created_at.replace('Z', '+00:00');
    changed.preview_sessions![0].ready_at = changed.preview_sessions![0].ready_at!.replace('Z', '+00:00');
    expect(normalizeSnapshot(applyEvent(snapshot, makeQualityEvent(changed)))).toMatchObject({
      delivery: snapshot.delivery, preview_sessions: snapshot.preview_sessions,
    });
  });

  it('keeps the cancelled smoke tool when pause queues a fresh smoke on the same sealed package', () => {
    const snapshot = makeDeliverySnapshot({ readySession: false });
    snapshot.run.status = 'running';
    const delivery = snapshot.delivery!;
    const previousSmoke = snapshot.tool_runs!.find(tool => tool.id === delivery.smoke_tool_run_id)!;
    previousSmoke.status = 'running'; previousSmoke.exit_code = null; previousSmoke.report = null;
    delivery.status = 'smoking'; delivery.finished_at = null;
    snapshot.artifacts = snapshot.artifacts.filter(artifact => ![delivery.smoke_report_artifact_id,
      delivery.runbook_artifact_id, delivery.deployment_package_artifact_id].includes(artifact.id));
    delivery.smoke_report_artifact_id = delivery.runbook_artifact_id = delivery.deployment_package_artifact_id = null;
    const changed = structuredClone(snapshot);
    changed.run.status = 'paused'; changed.run.pause_requested = true;
    const oldTool = changed.tool_runs!.find(tool => tool.id === previousSmoke.id)!;
    oldTool.status = 'cancelled';
    changed.tool_runs!.push({ ...oldTool, status: 'created', id: 'retried-smoke', finished_at: null });
    changed.delivery!.smoke_tool_run_id = 'retried-smoke';
    const projected = applyEvent(snapshot, makeQualityEvent(changed));
    expect(projected.delivery?.smoke_tool_run_id).toBe('retried-smoke');
    expect(projected.tool_runs?.find(tool => tool.id === previousSmoke.id)?.status).toBe('cancelled');
    expect(projected.delivery?.package_archive_hash).toBe(delivery.package_archive_hash);
  });
});
