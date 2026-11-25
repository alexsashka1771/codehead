import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilitiesResponse, CreateProject, DecisionResolution, DecisionView, ProjectView, RunCommand, RunView, Snapshot, StartRun, ToolCommand } from '../../../../packages/contracts';
import { api, ApiError, errorMessage } from '../app/api';
import { readSelection, saveSelection, type Selection } from './selection';
import { mergeRunHistory } from './runHistory';

interface AcceptedTool {
  runId: string;
  candidateId: string;
  revision: number;
  operationId: ToolCommand['operation_id'];
  toolRunId: string;
}

export function useWorkspace() {
  const [selection, setSelection] = useState<Selection>(readSelection);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const projectMutationVersion = useRef(0);
  const runMutationVersions = useRef(new Map<string, number>());
  const startIntent = useRef<{ projectId: string; mode: StartRun['mode']; scenario: StartRun['test_scenario']; key: string } | null>(null);
  const [testScenario, setTestScenario] = useState<NonNullable<StartRun['test_scenario']>>('standard');
  const decisionIntent = useRef<{ fingerprint: string; key: string } | null>(null);
  const toolIntents = useRef(new Map<string, string>());
  const acceptedToolIntents = useRef(new Map<string, AcceptedTool>());
  const [acceptedTools, setAcceptedTools] = useState<AcceptedTool[]>([]);
  const selectionVersion = useRef(0);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const observeToolSnapshot = useCallback((snapshot: Snapshot | null) => {
    if (!snapshot) return;
    let changed = false;
    for (const [scope, accepted] of acceptedToolIntents.current) {
      if (accepted.runId === snapshot.run.id && snapshot.tool_runs?.some(tool => tool.id === accepted.toolRunId
        && tool.run_id === accepted.runId && tool.workspace_id === accepted.candidateId && tool.snapshot_version === accepted.revision
        && tool.operation_id === accepted.operationId)) {
        acceptedToolIntents.current.delete(scope);
        changed = true;
      }
    }
    if (changed) setAcceptedTools([...acceptedToolIntents.current.values()]);
  }, []);

  useEffect(() => { saveSelection(selection); }, [selection]);
  useEffect(() => {
    const onPopState = () => { selectionVersion.current += 1; setSelection(readSelection()); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestedProjectVersion = projectMutationVersion.current;
    setLoading(true);
    setError(null);
    Promise.all([api.projects(controller.signal), api.capabilities(controller.signal)])
      .then(([nextProjects, nextCapabilities]) => {
        if (controller.signal.aborted) return;
        setCapabilities(nextCapabilities);
        if (requestedProjectVersion !== projectMutationVersion.current) {
          setProjects((previous) => {
            const merged = new Map(nextProjects.map((project) => [project.id, project]));
            for (const project of previous) merged.set(project.id, project);
            return [...merged.values()].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
          });
          return;
        }
        setProjects(nextProjects);
        setSelection((previous) => nextProjects.some((project) => project.id === previous.projectId)
          ? previous : { projectId: nextProjects[0]?.id ?? null, runId: null });
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const projectId = selection.projectId;
    setRuns([]);
    setActionError(null);
    if (!projectId) { setRunsLoading(false); return; }
    const controller = new AbortController();
    const requestedRunVersion = runMutationVersions.current.get(projectId) ?? 0;
    setRunsLoading(true);
    api.runs(projectId, controller.signal)
      .then((nextRuns) => {
        if (controller.signal.aborted) return;
        if (requestedRunVersion !== (runMutationVersions.current.get(projectId) ?? 0)) {
          setRuns((previous) => mergeRunHistory(nextRuns, previous, projectId));
          return;
        }
        setRuns(nextRuns);
        setSelection((previous) => previous.projectId !== projectId ? previous : {
          ...previous, runId: nextRuns.some((run) => run.id === previous.runId) ? previous.runId : nextRuns[0]?.id ?? null,
        });
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setActionError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setRunsLoading(false); });
    return () => controller.abort();
  }, [selection.projectId, revision]);

  function selectProject(projectId: string) { startIntent.current = null; selectionVersion.current += 1; selectionRef.current = { projectId, runId: null }; setSelection(selectionRef.current); }
  function selectTestScenario(scenario: NonNullable<StartRun['test_scenario']>) { if (pendingRef.current) return; startIntent.current = null; setTestScenario(scenario); }
  function selectRun(runId: string) { selectionVersion.current += 1; selectionRef.current = { ...selectionRef.current, runId }; setSelection(selectionRef.current); setActionError(null); }

  function recordRunMutation(run: RunView) {
    const projectId = run.project_id;
    runMutationVersions.current.set(projectId, (runMutationVersions.current.get(projectId) ?? 0) + 1);
    if (selectionRef.current.projectId === projectId) {
      setRuns((previous) => mergeRunHistory(previous, [run], projectId));
    }
  }

  async function createProject(input: CreateProject) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending('project'); setActionError(null);
    try {
      const project = await api.createProject(input, crypto.randomUUID());
      projectMutationVersion.current += 1;
      setProjects((previous) => [project, ...previous.filter((item) => item.id !== project.id)]);
      setSelection({ projectId: project.id, runId: null });
      return true;
    } catch (cause) { setActionError(errorMessage(cause)); return false; }
    finally { pendingRef.current = false; setPending(null); }
  }

  async function start(mode: StartRun['mode'] = 'live', scenario: StartRun['test_scenario'] = testScenario) {
    const projectId = selectionRef.current.projectId;
    if (!projectId || pendingRef.current) return;
    pendingRef.current = true;
    setPending(mode === 'test' ? 'start-test' : 'start'); setActionError(null);
    const selectedScenario = mode === 'test' ? scenario : 'standard';
    if (startIntent.current?.projectId !== projectId || startIntent.current.mode !== mode || startIntent.current.scenario !== selectedScenario) {
      startIntent.current = { projectId, mode, scenario: selectedScenario, key: crypto.randomUUID() };
    }
    try {
      const run = await api.start(projectId, startIntent.current.key, mode, selectedScenario);
      startIntent.current = null;
      recordRunMutation(run);
      if (selectionRef.current.projectId === projectId) {
        setSelection({ projectId, runId: run.id });
      }
    } catch (cause) {
      if (cause instanceof ApiError && !cause.problem.retriable) startIntent.current = null;
      if (selectionRef.current.projectId === projectId) setActionError(errorMessage(cause));
    } finally { pendingRef.current = false; setPending(null); }
  }

  async function command(command: RunCommand['command']) {
    const runId = selectionRef.current.runId;
    if (!runId || pendingRef.current) return;
    pendingRef.current = true;
    setPending(command); setActionError(null);
    try {
      const run = await api.command(runId, command, crypto.randomUUID());
      recordRunMutation(run);
    } catch (cause) {
      if (selectionRef.current.runId === runId) setActionError(errorMessage(cause));
    } finally { pendingRef.current = false; setPending(null); }
  }

  async function resolveDecision(decision: DecisionView, choice: DecisionResolution['choice'], comment: string) {
    if (pendingRef.current || decision.run_id !== selectionRef.current.runId) return false;
    pendingRef.current = true;
    setPending('decision'); setActionError(null);
    const resolution: DecisionResolution = { version: decision.version, choice, comment };
    const fingerprint = JSON.stringify({ decisionId: decision.id, ...resolution });
    if (decisionIntent.current?.fingerprint !== fingerprint) decisionIntent.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const run = await api.resolveDecision(decision.id, resolution, decisionIntent.current.key);
      decisionIntent.current = null;
      recordRunMutation(run);
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && !cause.problem.retriable) decisionIntent.current = null;
      if (selectionRef.current.runId === decision.run_id) {
        setActionError(cause instanceof ApiError && cause.status === 409
          ? 'Решение изменилось на сервере. Обновляем данные; прочитайте новую версию перед ответом.' : errorMessage(cause));
      }
      return false;
    } finally { pendingRef.current = false; setPending(null); }
  }

  async function queueTool(snapshot: Snapshot, command: ToolCommand, getCurrentSnapshot: () => Snapshot | null = () => snapshot) {
    const runId = selectionRef.current.runId;
    const candidate = snapshot.candidate;
    if (pendingRef.current || runId !== snapshot.run.id || !candidate || candidate.run_id !== runId
      || candidate.status !== 'ready' || snapshot.run.mode !== 'test' || !['clinic-v2', 'clinic-v3'].includes(snapshot.run.workflow_version)
      || snapshot.run.pause_requested || snapshot.run.cancel_requested || ['paused', 'pausing', 'cancelled', 'failed', 'succeeded'].includes(snapshot.run.status)
      || command.workspace_id !== candidate.id || command.snapshot_version !== candidate.revision) return false;
    observeToolSnapshot(snapshot);
    const scope = JSON.stringify([runId, candidate.id, candidate.revision, command.operation_id]);
    if (acceptedToolIntents.current.has(scope)) return false;
    pendingRef.current = true;
    const version = selectionVersion.current;
    const current = () => {
      const latest = getCurrentSnapshot();
      return selectionVersion.current === version && selectionRef.current.runId === runId && latest?.run.id === runId
        && latest.candidate?.id === candidate.id && latest.candidate.revision === candidate.revision;
    };
    setPending('tool-' + command.operation_id); setActionError(null);
    const fingerprint = JSON.stringify({ runId, ...command });
    if (!toolIntents.current.has(fingerprint)) toolIntents.current.set(fingerprint, crypto.randomUUID());
    try {
      const receipt = await api.queueTool(runId, command, toolIntents.current.get(fingerprint)!);
      if (receipt.run_id !== runId || receipt.workspace_id !== candidate.id || receipt.snapshot_version !== candidate.revision
        || receipt.operation_id !== command.operation_id || receipt.manifest_artifact_id !== candidate.manifest_artifact_id
        || receipt.manifest_hash !== candidate.manifest_hash || receipt.tree_hash !== candidate.tree_hash
        || receipt.profile_hash !== candidate.profile_hash || receipt.profile_version !== candidate.profile_version
        || receipt.acceptance_suite_hash !== candidate.acceptance_suite_hash || receipt.template_hash !== candidate.template_hash) {
        if (current()) setActionError('Ответ проверки не соответствует выбранному запуску и версии кандидата. Обновите данные.');
        return false;
      }
      toolIntents.current.delete(fingerprint);
      acceptedToolIntents.current.set(scope, { runId, candidateId: candidate.id, revision: candidate.revision,
        operationId: command.operation_id, toolRunId: receipt.id });
      setAcceptedTools([...acceptedToolIntents.current.values()]);
      observeToolSnapshot(getCurrentSnapshot());
      // The receipt acknowledges enqueueing; only the event stream changes the snapshot.
      return current();
    } catch (cause) {
      if (cause instanceof ApiError && !cause.problem.retriable) toolIntents.current.delete(fingerprint);
      if (current()) setActionError(errorMessage(cause));
      return false;
    } finally { pendingRef.current = false; setPending(null); }
  }

  return {
    projects, runs, capabilities, loading, runsLoading, error, actionError, pending, selection, acceptedTools, testScenario, selectTestScenario,
    project: projects.find((project) => project.id === selection.projectId) ?? null,
    run: runs.find((run) => run.id === selection.runId) ?? null,
    selectProject, selectRun, createProject, start, command, resolveDecision, queueTool, observeToolSnapshot, refresh,
  };
}
