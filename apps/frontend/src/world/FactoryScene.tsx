import { memo, useCallback, useMemo, useState } from 'react';
import { Focus, Maximize2, Minus, Plus } from 'lucide-react';
import type { AgentView, Role, RoleDefinition } from '../../../../packages/contracts';
import { MAX_MAGNIFICATION, MIN_MAGNIFICATION } from './camera';
import { resolveAppearance } from './appearance';
import { FactoryViewport } from './FactoryViewport';
import { SceneFallback } from './SceneFallback';
import type { CameraCommand } from './SceneCamera';
import type { ScenePreparationStatus } from './shaderPreparation';
import { useReducedMotion } from './useReducedMotion';
import { useSceneSnapshot } from './useSceneSnapshot';
import { WorldLabels, type ProjectedLabels } from './WorldLabels';

export default memo(function FactoryScene({ roles, agents, selected, onSelect, night, focusRequest = 0 }: {
  roles: RoleDefinition[]; agents: AgentView[]; selected: Role; onSelect: (role: Role) => void; night: boolean;
  focusRequest?: number;
}) {
  const [zoom, setZoom] = useState(1);
  const [lost, setLost] = useState(false);
  const [preparation, setPreparation] = useState<{ revision: string; status: ScenePreparationStatus }>({ revision: '', status: 'loading' });
  const [command, setCommand] = useState<CameraCommand>({ id: 0, type: 'none' });
  const [positions, setPositions] = useState<ProjectedLabels>({});
  const reducedMotion = useReducedMotion();
  const scene = useSceneSnapshot(roles, agents);
  const resourceRevision = useMemo(() => [night ? 'night' : 'day', ...scene.roles.map(definition => {
    const agent = scene.agents.find(item => item.role === definition.role);
    return definition.role + ':' + resolveAppearance(agent?.appearance_id ?? definition.appearance_id, definition.appearance_id).appearance.id;
  })].join('|'), [night, scene.roles, scene.agents]);
  const status = lost ? 'failed' : preparation.revision === resourceRevision ? preparation.status : 'loading';
  const handleStatus = useCallback((next: ScenePreparationStatus) => {
    setPreparation(previous => previous.revision === resourceRevision && previous.status === next ? previous
      : { revision: resourceRevision, status: next });
  }, [resourceRevision]);
  const handleLost = useCallback(() => setLost(true), []);
  const handleProject = useCallback((labels: ProjectedLabels) => {
    setPositions(previous => {
      const entries = Object.entries(labels);
      const unchanged = entries.length === Object.keys(previous).length && entries.every(([id, point]) =>
        previous[id] && Math.abs(previous[id].left - point.left) < 0.25 && Math.abs(previous[id].top - point.top) < 0.25);
      return unchanged ? previous : labels;
    });
  }, []);
  const issue = (type: CameraCommand['type']) => setCommand(previous => ({ id: previous.id + 1, type }));
  const location = agents.find(agent => agent.role === selected)?.location
    ?? roles.find(role => role.role === selected)?.location ?? 'product';

  return <div className="scene-canvas" aria-label="Трёхмерная фабрика CodeHead"
    data-scene-state={status} aria-busy={status === 'loading'}>
    {lost ? <SceneFallback /> : <FactoryViewport roles={scene.roles} agents={scene.agents} selected={selected} onSelect={onSelect}
      night={night} focusRequest={focusRequest} command={command} onProject={handleProject} onZoom={setZoom}
      onLost={handleLost} onStatus={handleStatus} resourceRevision={resourceRevision} reducedMotion={reducedMotion} />}
    {!lost && status === 'loading' && <div className="scene-loading" role="status">Подготавливаем трёхмерный вид…</div>}
    {!lost && status === 'ready' && <WorldLabels positions={positions} roles={roles} agents={agents} selected={selected}
      selectedLocation={location} onSelect={onSelect} night={night} />}
    <p className="camera-help">Перетащите сцену для поворота · ПКМ — сдвиг</p>
    <div className="camera-controls" role="group" aria-label="Управление камерой">
      <button className="icon-button" onClick={() => issue('out')} aria-label="Отдалить" title="Отдалить"
        disabled={lost || zoom <= MIN_MAGNIFICATION}><Minus size={16} /></button>
      <button className="icon-button" onClick={() => issue('reset')} aria-label="Сбросить вид" title="Обзор всей фабрики"
        disabled={lost}><Maximize2 size={16} /></button>
      <button className="icon-button" onClick={() => issue('focus')} aria-label="Показать выбранную роль" title="Показать выбранную роль"
        disabled={lost}><Focus size={16} /></button>
      <button className="icon-button" onClick={() => issue('in')} aria-label="Приблизить" title="Приблизить"
        disabled={lost || zoom >= MAX_MAGNIFICATION}><Plus size={16} /></button>
    </div>
  </div>;
});
