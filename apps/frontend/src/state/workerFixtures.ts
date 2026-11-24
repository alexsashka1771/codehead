import type { AgentRunView, AgentView, ArtifactView, DecisionView, Snapshot, UsageSummary, WorkflowUpdatedEvent } from '../../../../packages/contracts';
import { makeEvent, makeSnapshot, testTask } from './fixtures';

export function makeWorkerSnapshot(): Snapshot {
  const base = makeSnapshot();
  const agent: AgentView = {
    id: 'agent-cto', run_id: base.run.id, role: 'cto', instructions_version: '1',
    appearance_id: 'cto-v1', lifecycle: 'blocked', activity: 'waiting', location: 'architecture',
    current_task_id: testTask.id,
  };
  const artifact: ArtifactView = {
    id: 'artifact-review', run_id: base.run.id, task_id: testTask.id, artifact_type: 'decision',
    version: 2, content_hash: 'b'.repeat(64), relative_path: 'docs/cto-review-v2.md', author_role: 'cto',
    input_versions: { requirements: 1, architecture: 2, api_contract: 2 },
    created_at: '2026-11-24T10:00:02.123456Z',
    provenance: { origin: 'test', producer_id: 'attempt-cto', parent_artifact_id: null },
    media_type: 'text/markdown', byte_size: 84,
  };
  const attempt: AgentRunView = {
    id: 'attempt-cto', run_id: base.run.id, task_id: testTask.id, agent_id: agent.id,
    number: 1, fencing_token: 3, status: 'succeeded', provider: 'test', model: 'clinic-fixture-v1',
    input_versions: artifact.input_versions, parameters: { max_output_tokens: 2048 },
    created_at: '2026-11-24T10:00:00.123456Z', started_at: '2026-11-24T10:00:01.123456Z',
    finished_at: artifact.created_at, provider_request_id: 'test-request-cto', stop_reason: 'completed',
    input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 10,
    error_code: null, error_message: null, retry_of_attempt_id: null,
    decision_id: 'decision-architecture', trace_available: true,
  };
  const decision: DecisionView = {
    id: 'decision-architecture', run_id: base.run.id, task_id: testTask.id, attempt_id: attempt.id, tool_run_id: null,
    kind: 'architecture_approval', status: 'open', blocking: true, version: 2, title: 'Принять архитектуру',
    summary: 'CTO проверил архитектуру и контракт API. Требуется решение автора.',
    choices: ['approve', 'reject'], artifact_ids: [artifact.id], choice: null, comment: null,
    created_at: artifact.created_at, resolved_at: null,
  };
  const usage: UsageSummary = {
    request_count: 3, input_tokens: 0, output_tokens: 0, cost_usd: 0,
    provider: attempt.provider, model: attempt.model, source: 'test', cached_tokens: 0, latency_ms: 30,
  };
  return {
    ...base, run: { ...base.run, mode: 'test', status: 'blocked', last_event_seq: 2,
      blocked_reason: 'Требуется решение автора об архитектуре.' },
    tasks: [{ ...testTask, role: 'cto', task_type: 'architecture_review', status: 'waiting_for_decision',
      fencing_token: 3, active_attempt_id: attempt.id, input_versions: artifact.input_versions,
      attempt: 1, record_version: 4 }],
    agents: [agent], artifacts: [artifact], agent_runs: [attempt], decisions: [decision], usage,
    last_event_seq: 2,
  };
}

export function makeWorkflowEvent(seq = 1): WorkflowUpdatedEvent {
  const snapshot = makeWorkerSnapshot();
  return {
    ...makeEvent(seq), event_type: 'workflow.updated',
    payload: {
      action: 'decision.created', run: { ...snapshot.run, last_event_seq: seq },
      tasks: snapshot.tasks, agents: snapshot.agents, artifacts: snapshot.artifacts,
      agent_runs: snapshot.agent_runs!, decisions: snapshot.decisions!, usage: snapshot.usage!,
    },
  };
}
