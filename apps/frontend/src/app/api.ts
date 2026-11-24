import type {
  AgentRunView, ApiProblem, ArtifactContent, ArtifactView, AttemptTrace, CapabilitiesResponse,
  CandidateView, CreateProject, DecisionResolution, DecisionView, EventsPage, ProjectView,
  RunCommand, RunView, SessionInfo, Snapshot, StartRun, UsageSummary,
} from '../../../../packages/contracts';

export class ApiError extends Error {
  constructor(public readonly problem: ApiProblem, public readonly status: number) {
    super(problem.message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(12_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(path, { ...options, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as ApiProblem | null;
    throw new ApiError(body?.message ? body : {
      code: 'http_error', message: `Сервер вернул ошибку ${response.status}. Повторите запрос.`,
      correlation_id: '', retriable: response.status >= 500,
    }, response.status);
  }
  return response.json() as Promise<T>;
}

let commandToken: string | null = null;
let sessionRequest: Promise<string> | null = null;

function getCommandToken(): Promise<string> {
  if (commandToken) return Promise.resolve(commandToken);
  if (!sessionRequest) {
    sessionRequest = request<SessionInfo>('/api/session', { cache: 'no-store' })
      .then((session) => {
        commandToken = session.command_token;
        return session.command_token;
      })
      .finally(() => { sessionRequest = null; });
  }
  return sessionRequest;
}

async function post<T>(path: string, body: unknown, key: string): Promise<T> {
  const serialized = JSON.stringify(body);
  const send = (token: string) => request<T>(path, {
    method: 'POST', body: serialized,
    headers: {
      'Content-Type': 'application/json', 'X-CodeHead-Client': 'browser',
      'Idempotency-Key': key, 'X-CodeHead-Token': token,
    },
  });
  const token = await getCommandToken();
  try { return await send(token); }
  catch (cause) {
    if (!(cause instanceof ApiError) || cause.status !== 403 || cause.problem.code !== 'invalid_command_token') throw cause;
    if (commandToken === token) commandToken = null;
    return send(await getCommandToken());
  }
}

export const startParameters: StartRun = {
  mode: 'live',
  limits: {
    max_parallel_tasks: 2, max_repair_iterations: 2, max_llm_calls: 64,
    max_tokens: null, max_cost_usd: null, max_duration_seconds: 1800,
  },
};

export const api = {
  capabilities: (signal?: AbortSignal) => request<CapabilitiesResponse>('/api/capabilities', { signal }),
  projects: (signal?: AbortSignal) => request<ProjectView[]>('/api/projects', { signal }),
  createProject: (input: CreateProject, key: string) => post<ProjectView>('/api/projects', input, key),
  runs: (projectId: string, signal?: AbortSignal) => request<RunView[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`, { signal }),
  start: (projectId: string, key: string, mode: StartRun['mode'] = 'live') => post<RunView>(`/api/projects/${encodeURIComponent(projectId)}/runs`, { ...startParameters, mode }, key),
  snapshot: (runId: string, signal?: AbortSignal) => request<Snapshot>(`/api/runs/${encodeURIComponent(runId)}/snapshot`, { signal }),
  candidate: (runId: string, signal?: AbortSignal) => request<CandidateView | null>(`/api/runs/${encodeURIComponent(runId)}/candidate`, { signal }),
  artifacts: (runId: string, signal?: AbortSignal) => request<ArtifactView[]>(`/api/runs/${encodeURIComponent(runId)}/artifacts`, { signal }),
  events: (runId: string, after: number, signal?: AbortSignal) => request<EventsPage>(`/api/runs/${encodeURIComponent(runId)}/events?after_seq=${after}&limit=100`, { signal }),
  command: (runId: string, command: RunCommand['command'], key: string) => post<RunView>(`/api/runs/${encodeURIComponent(runId)}/commands`, { command }, key),
  usage: (runId: string, signal?: AbortSignal) => request<UsageSummary>(`/api/runs/${encodeURIComponent(runId)}/usage`, { signal }),
  agentRuns: (runId: string, signal?: AbortSignal) => request<AgentRunView[]>(`/api/runs/${encodeURIComponent(runId)}/agent-runs`, { signal }),
  attemptTrace: (attemptId: string, signal?: AbortSignal) => request<AttemptTrace>(`/api/agent-runs/${encodeURIComponent(attemptId)}/trace`, { signal }),
  decisions: (runId: string, signal?: AbortSignal) => request<DecisionView[]>(`/api/runs/${encodeURIComponent(runId)}/decisions`, { signal }),
  resolveDecision: (decisionId: string, resolution: DecisionResolution, key: string) => post<RunView>(`/api/decisions/${encodeURIComponent(decisionId)}/resolve`, resolution, key),
  artifact: (artifactId: string, signal?: AbortSignal) => request<ArtifactView>(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal }),
  artifactContent: (artifactId: string, signal?: AbortSignal) => request<ArtifactContent>(`/api/artifacts/${encodeURIComponent(artifactId)}/content`, { signal }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'Сервер не ответил за 12 секунд. Проверьте подключение и повторите запрос.';
  return 'Не удалось связаться с сервером. Убедитесь, что локальный сервер запущен, и повторите запрос.';
}
