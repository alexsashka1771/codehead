import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Canvas, type RootState } from '@react-three/fiber';
import type { Vector3 } from 'three';
import type { AgentView, Role, RoleDefinition } from '../../../../packages/contracts';
import { FactoryGeometry } from './geometry';
import { CentralHub } from './CentralHub';
import { ATELIER_BACKGROUND } from './finishes';
import { AtelierLighting } from './lighting';
import { RiggedAgentBot } from './RiggedAgentBot';
import { SceneCamera, type CameraCommand } from './SceneCamera';
import { SceneContextGuard } from './SceneContextGuard';
import { SceneFallback } from './SceneFallback';
import { SceneMotionController } from './SceneMotionController';
import { ScenePrecompiler } from './ScenePrecompiler';
import type { ScenePreparationStatus } from './shaderPreparation';
import type { RigRegistry } from './actorController';
import type { AgentRig } from './robotRig';
import type { ProjectedLabels } from './WorldLabels';
import { ATELIER_GL_OPTIONS, configureAtelierRenderer, DEFAULT_RENDER_DENSITY, FACTORY_CAMERA_OPTIONS,
  type RenderDensity } from './renderer';

const Geometry = memo(FactoryGeometry);
const Hub = memo(CentralHub);
const Robot = memo(RiggedAgentBot);

/** DOM panels and projected-label updates cannot schedule another world render. */
export const FactoryViewport = memo(function FactoryViewport({ roles, agents, selected, onSelect, night,
  focusRequest, command, onProject, onZoom, onLost, onStatus, resourceRevision, reducedMotion }: {
  roles: RoleDefinition[]; agents: AgentView[]; selected: Role; onSelect: (role: Role) => void; night: boolean;
  focusRequest: number; command: CameraCommand; onProject: (labels: ProjectedLabels) => void;
  onZoom: (zoom: number) => void; onLost: () => void; onStatus: (status: ScenePreparationStatus) => void;
  resourceRevision: string; reducedMotion: boolean;
}) {
  const [registry] = useState<RigRegistry>(() => ({ rigs: new Map(), revision: 0 }));
  const occlusionTarget = useRef<Vector3 | null>(null);
  const [density, setDensity] = useState<RenderDensity>(DEFAULT_RENDER_DENSITY);
  const rendererReady = useCallback((state: RootState) => { setDensity(configureAtelierRenderer(state)); }, []);
  const expectedRoles = useMemo(() => roles.map(definition => definition.role), [roles]);
  const handlers = useMemo(() => Object.fromEntries(roles.map(definition => [definition.role, {
    select: () => onSelect(definition.role),
    ready: (rig: AgentRig | null) => {
      if (rig) registry.rigs.set(definition.role, rig);
      else registry.rigs.delete(definition.role);
      registry.revision++;
    },
  }])), [roles, onSelect, registry]);
  const selectedLocation = agents.find(agent => agent.role === selected)?.location
    ?? roles.find(role => role.role === selected)?.location ?? 'product';

  return <div className="factory-viewport"><Canvas orthographic
    camera={FACTORY_CAMERA_OPTIONS}
    frameloop="demand" dpr={density} shadows="percentage"
    gl={ATELIER_GL_OPTIONS}
    fallback={<SceneFallback />} onCreated={rendererReady}
    style={{ width: '100%', height: '100%', display: 'block' }}>
    <color attach="background" args={[ATELIER_BACKGROUND[night ? 'night' : 'day']]} />
    <ScenePrecompiler registry={registry} expectedRoles={expectedRoles} resourceRevision={resourceRevision} onStatus={onStatus} />
    <AtelierLighting night={night} />
    <SceneCamera roles={roles} agents={agents} registry={registry} selected={selected} focusRequest={focusRequest}
      command={command} onProject={onProject} onZoom={onZoom} reducedMotion={reducedMotion} />
    <SceneMotionController roles={roles} agents={agents} registry={registry} reducedMotion={reducedMotion}
      selected={selected} occlusionTarget={occlusionTarget} />
    <SceneContextGuard onLost={onLost} />
    <Geometry night={night} selectedLocation={selectedLocation} occlusionTarget={occlusionTarget} />
    <Hub night={night} />
    {roles.map(role => <Robot key={role.role} definition={role} agent={agents.find(agent => agent.role === role.role)}
      selected={role.role === selected} onSelect={handlers[role.role].select} night={night}
      onRigReady={handlers[role.role].ready} />)}
  </Canvas></div>;
});
