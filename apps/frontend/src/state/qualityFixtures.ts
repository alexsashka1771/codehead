import type { ArtifactView, Bug, QualityCycleView, RequirementCheck, Snapshot, TestReport, WorkflowUpdatedEvent } from '../../../../packages/contracts';
import { makeCandidateSnapshot } from './candidateFixtures';
import { makeToolSnapshot } from './toolFixtures';
import { makeEvent, testTask } from './fixtures';

export function makeQualitySnapshot(iterations = 1): Snapshot {
  const snapshot = makeCandidateSnapshot();
  snapshot.run.workflow_version = 'clinic-v3';
  snapshot.run.test_scenario = iterations > 1 ? 'repair_success' : 'standard';
  snapshot.run.injection_done = iterations > 1;
  snapshot.quality_cycles = [];
  snapshot.tool_runs = [];
  snapshot.agents.push({ ...snapshot.agents[0], id: 'agent-qa', role: 'qa', location: 'qa' });
  for (let iteration = 0; iteration < iterations; iteration++) {
    const candidate = snapshot.candidate!;
    if (iteration > 0) {
      const previous = snapshot.artifacts.find(a => a.id === candidate.manifest_artifact_id)!;
      const manifest = { ...previous, id: 'manifest-' + (3 + iteration), version: 3 + iteration,
        content_hash: String(iteration).repeat(64), provenance: { ...previous.provenance, parent_artifact_id: previous.id } };
      snapshot.artifacts.push(manifest);
      candidate.revision = manifest.version; candidate.manifest_artifact_id = manifest.id;
      candidate.manifest_hash = manifest.content_hash; candidate.tree_hash = String(iteration + 6).repeat(64);
    }
    const taskId = 'task-qa-' + iteration;
    const attemptId = 'attempt-qa-' + iteration;
    snapshot.tasks.push({ ...testTask, id: taskId, role: 'qa', task_type: 'quality_assurance', iteration,
      status: 'succeeded', attempt: 1, active_attempt_id: attemptId,
      dependencies: iteration ? ['task-repair-' + iteration] : ['task-backend', 'task-frontend'] });
    snapshot.agent_runs!.push({ ...snapshot.agent_runs![0], id: attemptId, task_id: taskId, agent_id: 'agent-qa' });
    const cycle: QualityCycleView = { id: 'cycle-' + iteration, run_id: snapshot.run.id, task_id: taskId,
      candidate_id: candidate.id, revision: candidate.revision, tree_hash: candidate.tree_hash,
      manifest_artifact_id: candidate.manifest_artifact_id, manifest_hash: candidate.manifest_hash!,
      profile_version: candidate.profile_version, profile_hash: candidate.profile_hash,
      acceptance_suite_hash: candidate.acceptance_suite_hash, template_hash: candidate.template_hash,
      iteration, status: iteration === iterations - 1 ? 'passed' : 'failed',
      tool_run_ids: [], tool_report_artifact_ids: [], bug_artifact_ids: [],
      report_artifact_id: 'report-' + iteration, repair_task_id: null, followup_task_id: null,
      blocked_reason: null, created_at: candidate.created_at, finished_at: candidate.updated_at };
    const qaArtifact = (id: string, type: string): ArtifactView => ({ id, run_id: snapshot.run.id, task_id: taskId,
      artifact_type: type, author_role: 'qa', version: 1, content_hash: 'd'.repeat(64),
      input_versions: { [cycle.manifest_artifact_id]: cycle.revision }, relative_path: 'quality/' + id + '.json',
      created_at: candidate.updated_at, media_type: 'application/json', byte_size: 400,
      provenance: { origin: 'test', producer_id: attemptId, parent_artifact_id: null } });
    for (const [index, operation] of (['validate_backend', 'test_backend', 'build_frontend'] as const).entries()) {
      const id = 'tool-' + iteration + '-' + index;
      const tool = { ...makeToolSnapshot().tool_runs![0], id, qa_cycle_id: cycle.id, operation_id: operation,
        snapshot_version: cycle.revision, tree_hash: cycle.tree_hash, manifest_artifact_id: cycle.manifest_artifact_id,
        manifest_hash: cycle.manifest_hash, status: cycle.status === 'failed' && index === 1 ? 'failed' as const : 'succeeded' as const };
      if (tool.status === 'failed') { tool.exit_code = 1; tool.error_code = 'tool_failed'; tool.error_message = 'HTTP suite failed'; }
      snapshot.tool_runs.push(tool); cycle.tool_run_ids.push(id);
      const artifact = qaArtifact('tool-report-' + iteration + '-' + index, 'tool_report');
      artifact.provenance = { origin: 'tool', producer_id: id, parent_artifact_id: null };
      snapshot.artifacts.push(artifact); cycle.tool_report_artifact_ids!.push(artifact.id);
    }
    snapshot.artifacts.push(qaArtifact(cycle.report_artifact_id!, 'test_report'));
    if (cycle.status === 'failed') {
      cycle.bug_artifact_ids = ['bug-' + iteration]; snapshot.artifacts.push(qaArtifact('bug-' + iteration, 'bug'));
      cycle.repair_task_id = 'task-repair-' + (iteration + 1); cycle.followup_task_id = 'task-qa-' + (iteration + 1);
      snapshot.tasks.push({ ...testTask, id: cycle.repair_task_id, role: 'backend', task_type: 'backend_repair',
        iteration: iteration + 1, dependencies: [taskId], status: 'succeeded', attempt: 1 });
    }
    snapshot.quality_cycles.push(cycle);
  }
  return snapshot;
}

export function makeTestReport(cycle: QualityCycleView): TestReport {
  return { ...cycle, cycle_id: cycle.id, status: cycle.status === 'passed' ? 'passed' : 'failed',
    requirements: Array.from({ length: 8 }, (_, i) => ({ requirement_id: ('REQ-' + String(i + 1).padStart(3, '0')) as RequirementCheck['requirement_id'],
      status: i === 5 || i === 7 || cycle.status === 'failed' ? 'not_verified' as const : 'passed' as const,
      tool_run_ids: [cycle.tool_run_ids[i === 5 ? 2 : 1]] })),
    proposed_tests: [{ title: 'Дополнительная проверка UI', requirement_ids: ['REQ-006'], status: 'proposed' }],
    resolves_bug_ids: cycle.iteration > 0 ? ['bug-0'] : [] };
}
export function makeBug(cycle: QualityCycleView): Bug {
  return { ...cycle, cycle_id: cycle.id, status: 'open', tool_run_ids: [cycle.tool_run_ids[1]], requirement_ids: ['REQ-003'], summary: 'HTTP conflict check failed' };
}
export function makeQualityEvent(snapshot: Snapshot, seq = 4): WorkflowUpdatedEvent {
  return { ...makeEvent(seq), event_type: 'workflow.updated', payload: { ...snapshot,
    action: 'quality.updated', run: { ...snapshot.run, last_event_seq: seq },
    agent_runs: snapshot.agent_runs!, decisions: snapshot.decisions!, usage: snapshot.usage! } };
}
