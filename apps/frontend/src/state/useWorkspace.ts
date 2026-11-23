import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapabilitiesResponse, CreateProject, DecisionResolution, DecisionView, ProjectView, RunCommand, RunView, StartRun } from '../../../../packages/contracts';
import { api, ApiError, errorMessage } from '../app/api';
import { readSelection, saveSelection, type Selection } from './selection';
import { mergeRunHistory } from './runHistory';

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
  const startIntent = useRef<{ projectId: string; mode: StartRun['mode']; key: string } | null>(null);
  const decisionIntent = useRef<{ fingerprint: string; key: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => { saveSelection(selection); }, [selection]);
  useEffect(() => {
    const onPopState = () => setSelection(readSelection());
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

  function selectProject(projectId: string) { setSelection({ projectId, runId: null }); }
  function selectRun(runId: string) { setSelection((previous) => ({ ...previous, runId })); setActionError(null); }

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

  async function start(mode: StartRun['mode'] = 'live') {
    const projectId = selectionRef.current.projectId;
    if (!projectId || pendingRef.current) return;
    pendingRef.current = true;
    setPending(mode === 'test' ? 'start-test' : 'start'); setActionError(null);
    if (startIntent.current?.projectId !== projectId || startIntent.current.mode !== mode) {
      startIntent.current = { projectId, mode, key: crypto.randomUUID() };
    }
    try {
      const run = await api.start(projectId, startIntent.current.key, mode);
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

  return {
    projects, runs, capabilities, loading, runsLoading, error, actionError, pending, selection,
    project: projects.find((project) => project.id === selection.projectId) ?? null,
    run: runs.find((run) => run.id === selection.runId) ?? null,
    selectProject, selectRun, createProject, start, command, resolveDecision, refresh,
  };
}
