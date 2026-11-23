import type { RunView, Snapshot, TaskQueuedEvent, TaskView } from '../../../../packages/contracts';

export const testRun: RunView = {
  id: 'run-one', project_id: 'project-one', mode: 'live', workflow_version: 'clinic-demo-v1',
  requirements_version: 1, status: 'created', limits: { max_file_bytes: 65536, max_files_per_proposal: 4, max_proposal_bytes: 262144 }, last_event_seq: 0,
  created_at: '2026-11-14T10:00:00Z', started_at: null, finished_at: null, blocked_reason: null,
  cancel_requested: false,
  pause_requested: false,
  profile_version: null, profile_hash: null, acceptance_suite_hash: null,
};

export function makeSnapshot(): Snapshot {
  return {
    schema_version: 1,
    project: { id: 'project-one', name: 'Clinic Demo', description: 'Test project', requirements_version: 1, created_at: testRun.created_at, profile: 'clinic_demo' },
    run: { ...testRun, limits: { ...testRun.limits } }, tasks: [], agents: [], artifacts: [], last_event_seq: 0,
    agent_runs: [], decisions: [], usage: null, candidate: null,
  };
}

export const testTask: TaskView = {
  id: 'task-one', run_id: testRun.id, role: 'product_manager', task_type: 'requirements',
  status: 'queued', dependencies: [], input_versions: {}, iteration: 0, attempt: 0,
  record_version: 1, lease_owner: null, lease_expires_at: null, created_at: testRun.created_at,
  fencing_token: 0, active_attempt_id: null, blocked_reason: null,
};

export function makeEvent(seq = 1): TaskQueuedEvent {
  return {
    schema_version: 1, event_type: 'task.queued', event_id: `event-${seq}`, seq,
    project_id: testRun.project_id, run_id: testRun.id, occurred_at: testRun.created_at,
    actor_id: null, task_id: testTask.id, correlation_id: 'correlation-one', causation_id: null,
    payload: { task: { ...testTask } },
  };
}
