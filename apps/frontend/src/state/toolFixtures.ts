import type { ToolRunView, WorkflowUpdatedEvent } from '../../../../packages/contracts';
import { makeCandidateSnapshot } from './candidateFixtures';
import { makeEvent } from './fixtures';

export function makeToolSnapshot(status: ToolRunView['status'] = 'succeeded') {
  const snapshot = makeCandidateSnapshot();
  const candidate = snapshot.candidate!;
  const tool: ToolRunView = {
    id: 'tool-one', run_id: snapshot.run.id, operation_id: 'validate_backend',
    workspace_id: candidate.id, snapshot_version: candidate.revision, status,
    required_isolation: 'process_only', isolation_level: 'process_only', timeout_seconds: 180,
    output_limit_bytes: 262144, tree_hash: candidate.tree_hash,
    manifest_artifact_id: candidate.manifest_artifact_id, manifest_hash: candidate.manifest_hash!,
    profile_version: candidate.profile_version, profile_hash: candidate.profile_hash,
    acceptance_suite_hash: candidate.acceptance_suite_hash, template_hash: candidate.template_hash,
    commands: [['python', '-m', 'compileall', 'backend']], stdout: '<script>compile complete</script>',
    stderr: '', report: { validated: true }, exit_code: status === 'succeeded' ? 0 : null,
    error_code: null, error_message: null, process_id: null,
    created_at: '2026-11-24T10:00:01.123456Z', started_at: '2026-11-24T10:00:02Z',
    finished_at: ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status) ? '2026-11-24T10:00:03Z' : null,
    fencing_token: 1, lease_owner: null, lease_expires_at: null,
    qa_cycle_id: null,
  };
  snapshot.tool_runs = [tool];
  return snapshot;
}

export function makeToolEvent(seq = 3): WorkflowUpdatedEvent {
  const snapshot = makeToolSnapshot();
  return { ...makeEvent(seq), event_type: 'workflow.updated', payload: {
    action: 'tool.succeeded', run: { ...snapshot.run, last_event_seq: seq }, tasks: snapshot.tasks,
    agents: snapshot.agents, artifacts: snapshot.artifacts, agent_runs: snapshot.agent_runs!,
    decisions: [], usage: snapshot.usage!, candidate: snapshot.candidate, tool_runs: snapshot.tool_runs,
  } };
}
