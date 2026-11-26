import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, ChevronDown, Database, Factory, FolderPlus, Moon, PanelLeft, RefreshCw, Rows3, Sun, Unplug, Wifi, WifiOff, X } from 'lucide-react';
import type { AgentView, CreateProject, DecisionResolution, DecisionView, Role, RunCommand, StartRun } from '../../../../packages/contracts';
import { useWorkspace } from '../state/useWorkspace';
import { useRunConnection } from '../state/useRunConnection';
import { ProjectForm } from '../features/ProjectForm';
import { RunPanel } from '../features/RunPanel';
import { AgentPanel, AgentStrip } from '../features/AgentPanel';
import { Inspector } from '../features/Inspector';
import { fallbackRoles, runLabels } from '../features/roles';
import { SceneBoundary, SceneFallback } from '../world/SceneFallback';

const FactoryScene = lazy(() => import('../world/FactoryScene'));
const EMPTY_AGENTS: AgentView[] = [];
type Panel = 'project' | 'role' | 'data' | null;

function restoreFocus(target: HTMLElement | null, fallback: HTMLElement | null) {
  const usable = target?.isConnected && target.getClientRects().length
    && !(target instanceof HTMLButtonElement && target.disabled);
  (usable ? target : fallback)?.focus();
}

export function App() {
  const workspace = useWorkspace();
  const stream = useRunConnection(workspace.selection.runId);
  const [selectedRole, setSelectedRole] = useState<Role>(() => {
    const requested = new URLSearchParams(window.location.search).get('role');
    return fallbackRoles.find(role => role.role === requested)?.role ?? 'product_manager';
  });
  const [focusRequest, setFocusRequest] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<Panel>(null);
  const [toolRequest, setToolRequest] = useState<{ runId: string; id: string } | null>(null);
  const projectOpen = activePanel === 'project';
  const roleOpen = activePanel === 'role';
  const dataOpen = activePanel === 'data';
  const [night, setNight] = useState(() => {
    try { return localStorage.getItem('codehead.theme.v1') !== 'day'; }
    catch { return true; }
  });
  const projectToggle = useRef<HTMLButtonElement>(null);
  const roleToggle = useRef<HTMLButtonElement>(null);
  const dataToggle = useRef<HTMLButtonElement>(null);
  const projectReturnFocus = useRef<HTMLElement | null>(null);
  const roleReturnFocus = useRef<HTMLElement | null>(null);
  const dataReturnFocus = useRef<HTMLElement | null>(null);
  const initialViewResolved = useRef(false);
  const roles = workspace.capabilities?.roles.length ? workspace.capabilities.roles : fallbackRoles;
  const selectedDefinition = roles.find(definition => definition.role === selectedRole) ?? roles[0];
  const connected = stream.connection === 'connected';
  const connectionBusy = ['loading', 'connecting', 'reconnecting'].includes(stream.connection) || workspace.loading;
  const connectionError = workspace.error ?? stream.error;
  const visibleError = connectionError ?? workspace.actionError;
  const showForm = createOpen || (!workspace.project && !workspace.loading && !workspace.error);
  const currentRun = stream.snapshot?.run ?? workspace.run;
  const currentSnapshot = useRef(stream.snapshot);
  currentSnapshot.current = stream.snapshot;
  useEffect(() => { workspace.observeToolSnapshot(stream.snapshot); }, [stream.snapshot, workspace.observeToolSnapshot]);
  const awaitingToolEvent = workspace.acceptedTools.some(accepted => accepted.runId === stream.snapshot?.run.id
    && accepted.candidateId === stream.snapshot.candidate?.id && accepted.revision === stream.snapshot.candidate.revision
    && !stream.snapshot.tool_runs?.some(tool => tool.id === accepted.toolRunId));
  const testCapability = workspace.capabilities?.capabilities.find(capability => capability.id === 'test_execution');
  const qaCapability = workspace.capabilities?.capabilities.find(capability => capability.id === 'qa_execution');
  const deliveryCapability = workspace.capabilities?.capabilities.find(capability => capability.id === 'delivery');
  const testReason = deliveryCapability?.status !== 'available' ? deliveryCapability?.reason ?? 'Worker доставки clinic-v4 сейчас недоступен.'
    : qaCapability?.status !== 'available' ? qaCapability?.reason ?? 'QA worker сейчас недоступен.'
      : testCapability?.status !== 'available' ? testCapability?.reason ?? 'Тестовый worker сейчас недоступен.' : null;

  useEffect(() => {
    try { localStorage.setItem('codehead.theme.v1', night ? 'night' : 'day'); }
    catch { /* Keep the theme usable when browser storage is unavailable. */ }
    document.documentElement.style.colorScheme = night ? 'dark' : 'light';
  }, [night]);

  useEffect(() => {
    if (!workspace.loading && !workspace.error && !workspace.project && !initialViewResolved.current) {
      initialViewResolved.current = true;
      setActivePanel('project');
    }
  }, [workspace.loading, workspace.error, workspace.project]);

  const choosePanel = useCallback((panel: Panel) => {
    initialViewResolved.current = true;
    setActivePanel(panel);
  }, []);

  const closeProject = useCallback(() => {
    choosePanel(null);
    restoreFocus(projectReturnFocus.current, projectToggle.current);
  }, [choosePanel]);
  const closeRole = useCallback(() => {
    choosePanel(null);
    restoreFocus(roleReturnFocus.current, roleToggle.current);
  }, [choosePanel]);
  const closeData = useCallback(() => {
    choosePanel(null);
    restoreFocus(dataReturnFocus.current, dataToggle.current);
  }, [choosePanel]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (roleOpen) closeRole();
      else if (projectOpen) closeProject();
      else if (dataOpen) closeData();
      else return;
      event.preventDefault();
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [roleOpen, projectOpen, dataOpen, closeRole, closeProject, closeData]);

  const selectRole = useCallback((role: Role) => {
    const active = document.activeElement;
    roleReturnFocus.current = active instanceof HTMLElement && active !== document.body
      ? active : roleToggle.current;
    setSelectedRole(role);
    setFocusRequest(value => value + 1);
    choosePanel('role');
  }, [choosePanel]);

  function openProject(create = false) {
    projectReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement : projectToggle.current;
    if (create) setCreateOpen(true);
    choosePanel('project');
  }
  function showData(expanded: boolean) {
    if (expanded && !dataOpen) {
      dataReturnFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement : dataToggle.current;
    }
    choosePanel(expanded ? 'data' : null);
  }
  function reconnect() { workspace.refresh(); stream.reconnect(); }
  async function createProject(input: CreateProject) {
    const created = await workspace.createProject(input);
    if (created) setCreateOpen(false);
    return created;
  }
  async function command(value: RunCommand['command']) {
    await workspace.command(value);
    stream.reconnect();
  }
  function start(mode: StartRun['mode'] = 'live', scenario?: StartRun['test_scenario']) {
    dataReturnFocus.current = dataToggle.current;
    choosePanel('data');
    void workspace.start(mode, scenario);
  }
  async function resolveDecision(decision: DecisionView, choice: DecisionResolution['choice'], comment: string) {
    const saved = await workspace.resolveDecision(decision, choice, comment);
    stream.reconnect();
    return saved;
  }
  async function queueTool(command: Parameters<typeof workspace.queueTool>[1]) {
    if (!stream.snapshot || !connected) return false;
    return workspace.queueTool(stream.snapshot, command, () => currentSnapshot.current);
  }

  return <div className="app" data-theme={night ? 'night' : 'day'} data-has-error={Boolean(visibleError)} data-run-mode={currentRun?.mode ?? ''}>
    <a className="skip-link" href="#main-controls" onClick={() => {
      openProject();
      requestAnimationFrame(() => document.getElementById('main-controls')?.focus());
    }}>Перейти к управлению</a>
    <header className="topbar">
      <a className="brand" href={window.location.pathname} aria-label="CodeHead — фабрика разработки">
        <span className="brand-symbol"><Factory size={24} strokeWidth={1.7} /></span><span>CodeHead</span>
      </a>
      <span className="brand-divider" aria-hidden="true" />
      <label className="project-picker">
        <span className="sr-only">Выбрать проект</span>
        <select aria-label="Выбрать проект" value={workspace.project?.id ?? ''}
          disabled={workspace.loading || Boolean(workspace.pending)}
          onChange={event => { workspace.selectProject(event.target.value); setCreateOpen(false); }}>
          <option value="" disabled>{workspace.loading ? 'Загружаем проекты…' : 'Выберите проект'}</option>
          {workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <ChevronDown className="project-picker-chevron" size={14} aria-hidden="true" />
      </label>
      <button type="button" className="new-project-button" onClick={() => openProject(true)}
        disabled={Boolean(workspace.pending)} aria-label="Новый проект" title="Новый проект">
        <FolderPlus size={18} /><span>Новый проект</span>
      </button>
      <div className="topbar-spacer" />
      {currentRun ? <span className={'run-mode' + (currentRun.mode === 'test' ? ' test-label' : '')} role="status" aria-label="Режим запуска"
        title={currentRun.mode === 'test' ? 'Тестовый запуск с провайдером-заглушкой' : 'Режим запуска: ' + currentRun.mode.toUpperCase()}>{currentRun.mode === 'test' ? 'ТЕСТ · заглушка' : currentRun.mode.toUpperCase()}</span> : null}
      <button type="button" className={'connection-button' + (connectionError ? ' has-error' : '')}
        onClick={reconnect} title="Переподключиться к серверу" disabled={workspace.loading}>
        {connectionError ? <WifiOff size={16} /> : <Wifi size={16} />}
        <span>{connectionError ? 'Нет соединения' : connectionBusy ? 'Подключение…' : connected ? 'События подключены' : 'Сервер подключён'}</span>
      </button>
      <div className="theme-control" role="group" aria-label="Освещение фабрики">
        <button type="button" className={!night ? 'selected' : ''} aria-pressed={!night}
          onClick={() => setNight(false)} aria-label="Дневная тема" title="Дневная тема"><Sun size={17} /></button>
        <button type="button" className={night ? 'selected' : ''} aria-pressed={night}
          onClick={() => setNight(true)} aria-label="Ночная тема" title="Ночная тема"><Moon size={17} /></button>
      </div>
    </header>

    {visibleError ? <div className="error-banner" role="alert">
      <AlertTriangle size={17} /><span>{visibleError}{connectionError && stream.snapshot ? ' Показан последний полученный снимок.' : ''}</span>
      {connectionError ? <button className="button text" onClick={reconnect}><RefreshCw size={14} />Повторить</button>
        : <button className="button text" onClick={() => openProject()}><PanelLeft size={14} />Открыть управление</button>}
    </div> : null}

    <main className="factory-workspace" data-panel={activePanel ?? 'none'} aria-label="Фабрика и данные запуска">
      <div className="scene-area">
        <SceneBoundary><Suspense fallback={<SceneFallback loading />}>
          <FactoryScene roles={roles} agents={stream.snapshot?.agents ?? EMPTY_AGENTS}
            selected={selectedRole} focusRequest={focusRequest} onSelect={selectRole} night={night} />
        </Suspense></SceneBoundary>
      </div>
      <div className="workspace-caption">
        <h1 title={workspace.project?.name}>{workspace.project?.name ?? 'Фабрика разработки'}</h1>
        <p>{workspace.project ? 'Clinic Demo · Требования v' + workspace.project.requirements_version : 'Создайте проект, чтобы собрать очередь команды'}</p>
        <div className="scene-status"><Unplug size={13} />
          <span>{currentRun ? runLabels[currentRun.status] : 'Исполнение не подключено'}</span>
        </div>
      </div>
      <nav className="workspace-tools" aria-label="Панели фабрики">
        <button ref={projectToggle} type="button" className={'tool-button' + (projectOpen ? ' active' : '')}
          aria-label="Управление проектом" title="Управление проектом" aria-controls="main-controls" aria-expanded={projectOpen}
          onClick={() => projectOpen ? closeProject() : openProject()}><PanelLeft size={20} /></button>
        <button ref={roleToggle} type="button" className={'tool-button' + (roleOpen ? ' active' : '')}
          aria-label="Карточка выбранной роли" title="Карточка выбранной роли" aria-controls="role-panel" aria-expanded={roleOpen}
          onClick={() => roleOpen ? closeRole() : selectRole(selectedRole)}><Bot size={20} /></button>
        <button ref={dataToggle} type="button" className={'tool-button' + (dataOpen ? ' active' : '')}
          aria-label="Данные запуска" title="Данные запуска" aria-controls="inspector-content" aria-expanded={dataOpen}
          onClick={() => dataOpen ? closeData() : showData(true)}><Rows3 size={20} /></button>
      </nav>

      <aside className="control-rail" id="main-controls" tabIndex={-1} aria-label="Управление проектом" hidden={!projectOpen}>
        <header className="panel-heading"><h2>Управление проектом</h2>
          <button type="button" className="icon-button" aria-label="Скрыть управление" title="Скрыть управление · Escape" onClick={closeProject}><X size={18} /></button>
        </header>
        <div className="panel-body">
          {showForm ? <ProjectForm pending={workspace.pending === 'project'} onSubmit={createProject}
            onClose={workspace.project ? () => setCreateOpen(false) : undefined} /> : workspace.project ?
            <section className="project-brief"><div className="section-title"><h2>Задание проекта</h2></div>
              <p>{workspace.project.description}</p><span className="profile-tag">Clinic Demo</span>
            </section> : <section className="project-brief">
              <h2>{workspace.loading ? 'Загружаем проекты…' : 'Подключите локальный сервер'}</h2>
              <p>Проекты и их состояние хранятся в PostgreSQL.</p>
            </section>}
          {!showForm ? <RunPanel run={workspace.run} runs={workspace.runs} snapshot={stream.snapshot}
            loading={workspace.runsLoading} pending={workspace.pending} hasProject={Boolean(workspace.project)}
            connected={connected} usage={stream.usage} onSelectRun={workspace.selectRun} onStart={() => start('live')}
            onStartTest={scenario => start('test', scenario)} testScenario={workspace.testScenario} onScenarioChange={workspace.selectTestScenario}
            testAvailable={testReason === null} testReason={testReason}
            onCommand={value => void command(value)} /> : null}
        </div>
      </aside>

      <aside className="role-inspector" id="role-panel" aria-label="Карточка выбранной роли" hidden={!roleOpen}>
        <header className="panel-heading"><h2>Команда</h2>
          <button type="button" className="icon-button" aria-label="Скрыть карточку роли" title="Скрыть карточку роли · Escape" onClick={closeRole}><X size={18} /></button>
        </header>
        <div className="panel-body"><AgentPanel key={selectedDefinition.role} definition={selectedDefinition} snapshot={stream.snapshot}
          active={roleOpen} connected={connected} pending={Boolean(workspace.pending)} onResolve={resolveDecision}
          onSelectTool={id => { if (stream.snapshot) { setToolRequest({ runId: stream.snapshot.run.id, id }); choosePanel('data'); } }} /></div>
      </aside>
      <AgentStrip roles={roles} agents={stream.snapshot?.agents ?? EMPTY_AGENTS} selected={selectedRole}
        onSelect={selectRole} hasRun={Boolean(stream.snapshot)} />
      <Inspector snapshot={stream.snapshot} events={stream.events} capabilities={workspace.capabilities}
        loading={Boolean(workspace.selection.runId) && !stream.snapshot && connectionBusy}
        expanded={dataOpen} onExpandedChange={showData} connected={connected} pending={Boolean(workspace.pending)} onResolve={resolveDecision}
        onQueueTool={queueTool} awaitingToolEvent={awaitingToolEvent} toolRequest={toolRequest} />
    </main>
    <footer className="statusbar">
      <span><Database size={12} />{workspace.error ? 'Сервер недоступен' : workspace.loading ? 'Подключаем хранилище' : 'Данные сохраняются на сервере'}</span>
      <span>{stream.snapshot ? 'Снимок #' + stream.snapshot.last_event_seq + ' · ' + (connected ? 'синхронизирован' : 'восстанавливаем соединение') : '7 ролей · 10 зон'}</span>
    </footer>
  </div>;
}
