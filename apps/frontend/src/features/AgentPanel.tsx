import { useState } from 'react';
import type { AgentView, Role, RoleDefinition, Snapshot } from '../../../../packages/contracts';
import { Briefcase, CircleDashed, Code2, Layers, MapPin, PanelTop, Play, Search, Server, ShieldCheck, Unplug } from 'lucide-react';
import { lifecycleLabels, roleDetails, taskLabels, zoneNames } from './roles';
import { ArtifactBrowser, AttemptList, DecisionCard, InputVersions, type ResolveDecision } from './WorkerDetails';

interface Props { roles: RoleDefinition[]; agents: AgentView[]; selected: Role; onSelect: (role: Role) => void; hasRun: boolean }
const roleIcons: Record<Role, typeof Briefcase> = {
  product_manager: Briefcase, architect: Layers, cto: ShieldCheck,
  backend: Code2, frontend: PanelTop, qa: Search, devops: Server,
};

export function AgentStrip({ roles, agents, selected, onSelect, hasRun }: Props) {
  return <nav className="agent-strip" aria-label="Роли фабрики">
    {roles.map(definition => {
      const agent = agents.find(item => item.role === definition.role);
      const details = roleDetails[definition.role];
      const Icon = roleIcons[definition.role];
      return <button key={definition.role} className={'agent-button' + (selected === definition.role ? ' is-selected' : '')}
        type="button" data-lifecycle={agent?.lifecycle ?? 'offline'} onClick={() => onSelect(definition.role)}
        aria-label={'Выбрать роль: ' + definition.name} aria-pressed={selected === definition.role}>
        <span className="role-mark" style={{ '--role-color': details.color } as React.CSSProperties} aria-hidden="true"><Icon size={22} /></span>
        <span className="role-short" aria-hidden="true">{details.short}</span>
        <span className="agent-button-copy" aria-hidden="true"><strong>{definition.name}</strong>
          <span>{agent ? lifecycleLabels[agent.lifecycle] : hasRun ? 'Нет данных' : 'До запуска'}</span>
        </span>
        <span className="agent-state-dot" aria-hidden="true" />
      </button>;
    })}
  </nav>;
}

export function AgentPanel({ definition, snapshot, active, connected, pending, onResolve }: {
  definition: RoleDefinition; snapshot: Snapshot | null; active: boolean; connected: boolean; pending: boolean; onResolve: ResolveDecision;
}) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const details = roleDetails[definition.role];
  const Icon = roleIcons[definition.role];
  const agent = snapshot?.agents.find(item => item.role === definition.role);
  const roleTasks = snapshot?.tasks.filter(item => item.role === definition.role) ?? [];
  const task = roleTasks.find(item => item.id === agent?.current_task_id) ?? roleTasks.at(-1);
  const taskIds = new Set(roleTasks.map(item => item.id));
  const attempts = snapshot?.agent_runs?.filter(attempt => taskIds.has(attempt.task_id)) ?? [];
  const artifacts = snapshot?.artifacts.filter(artifact => artifact.task_id != null && taskIds.has(artifact.task_id)) ?? [];
  const inputs = snapshot?.artifacts.filter(artifact => Object.entries(task?.input_versions ?? {}).some(([id, version]) =>
    (artifact.id === id || artifact.artifact_type === id) && artifact.version === version)) ?? [];
  const visibleArtifacts = [...new Map([...artifacts, ...inputs].map(artifact => [artifact.id, artifact])).values()];
  const decisions = snapshot?.decisions?.filter(decision => taskIds.has(decision.task_id)) ?? [];
  const queued = snapshot?.tasks.filter(item => item.role === definition.role && item.status === 'queued').length ?? 0;
  const previewUrl = new URL(window.location.href);
  previewUrl.searchParams.set('view', 'animations');
  previewUrl.searchParams.set('role', definition.role);
  return <section className="agent-detail" aria-labelledby="agent-title">
    <div className="section-title"><h2 id="agent-title">Роль в команде</h2><CircleDashed size={16} aria-hidden="true" /></div>
    <div className="agent-profile">
      <span className="role-mark large" style={{ '--role-color': details.color } as React.CSSProperties} aria-hidden="true"><Icon size={30} /></span>
      <div><h3>{definition.name}</h3><span className="agent-status">
        {agent?.lifecycle === 'offline' ? <Unplug size={12} /> : null}
        {agent ? lifecycleLabels[agent.lifecycle] : 'Запуск ещё не выбран'}
      </span></div>
    </div>
    <p className="supporting-text">{details.description}</p>
    <div className="agent-location"><MapPin size={13} /><span>{zoneNames[agent?.location ?? definition.location]}</span></div>
    {agent ? <p className="agent-assignment">{task ? roleDetails[task.role].task : 'Текущей задачи нет.'}{queued ? ' В очереди: ' + queued + '.' : ''}</p>
      : <p className="agent-assignment">Состояние агента появится после создания запуска.</p>}
    {task ? <div className="role-workflow">
      <div className="section-title"><h3>Задача роли</h3><span className={'task-status status-' + task.status}>{taskLabels[task.status]}</span></div>
      {task.blocked_reason ? <p className="attempt-error">{task.blocked_reason}</p> : null}
      <details><summary>Входы задачи</summary><InputVersions versions={task.input_versions} artifacts={snapshot?.artifacts} onSelectArtifact={setSelectedArtifactId} />
        <p className="field-hint">Версия записи {task.record_version} · fencing token {task.fencing_token ?? 0}</p></details>
      {decisions.map(decision => <DecisionCard key={decision.id + ':' + decision.version} decision={decision}
        artifacts={snapshot?.artifacts ?? []} pending={pending} connected={connected} onResolve={onResolve} onSelectArtifact={setSelectedArtifactId} />)}
      {attempts.length ? <><h3 className="workflow-subheading">Попытки</h3><AttemptList attempts={attempts} artifacts={snapshot?.artifacts ?? []}
        onSelectArtifact={setSelectedArtifactId} active={active} /></> : <p className="field-hint">Попыток выполнения пока нет.</p>}
      {visibleArtifacts.length ? <><h3 className="workflow-subheading">Документы и входы</h3><ArtifactBrowser artifacts={visibleArtifacts}
        selectedId={active ? selectedArtifactId : null} onSelect={setSelectedArtifactId} /></> : null}
    </div> : null}
    <a className="model-preview-link" href={previewUrl.pathname + previewUrl.search}><Play size={14} />Посмотреть анимации модели</a>
  </section>;
}
