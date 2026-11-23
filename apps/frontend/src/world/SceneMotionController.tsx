import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { AgentView, Role, RoleDefinition } from '../../../../packages/contracts';
import { ActorMotionController, type RigRegistry } from './actorController';

export function SceneMotionController({ roles, agents, registry, reducedMotion, selected, occlusionTarget }: {
  roles: RoleDefinition[]; agents: AgentView[]; registry: RigRegistry; reducedMotion: boolean;
  selected?: Role; occlusionTarget?: RefObject<Vector3 | null>;
}) {
  const [controller] = useState(() => new ActorMotionController());
  const pending = useRef(true);
  const synchronizedRevision = useRef(-1);
  const lastFrame = useRef(performance.now() / 1000);
  const torso = useRef(new Vector3());
  const visible = useRef(!document.hidden);
  const invalidate = useThree(state => state.invalidate);
  const gl = useThree(state => state.gl);

  useLayoutEffect(() => {
    pending.current = true;
    invalidate();
  }, [roles, agents, reducedMotion, invalidate]);

  useEffect(() => {
    const visibilityChanged = () => {
      visible.current = !document.hidden;
      if (visible.current) { lastFrame.current = performance.now() / 1000; invalidate(); }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, [invalidate]);

  useFrame(() => {
    if (!visible.current) return;
    const now = performance.now() / 1000;
    if (pending.current || synchronizedRevision.current !== registry.revision) {
      controller.synchronize(roles, agents, registry.rigs, now, reducedMotion);
      pending.current = false;
      synchronizedRevision.current = registry.revision;
    }
    const frame = controller.advance(now, Math.min(1, Math.max(0, now - lastFrame.current)));
    if (occlusionTarget) {
      const rig = selected ? registry.rigs.get(selected) : undefined;
      if (rig) { rig.labelPosition(torso.current); torso.current.y -= 1.05; occlusionTarget.current = torso.current; }
      else occlusionTarget.current = null;
    }
    lastFrame.current = now;
    if (frame.changed) gl.shadowMap.needsUpdate = true;
    if (frame.active) invalidate();
  }, -0.5);

  return null;
}
