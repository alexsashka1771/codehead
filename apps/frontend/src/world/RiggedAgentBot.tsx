import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { resolveAppearance } from './appearance';
import { avatarPosition, type Position3 } from './layout';
import { buildRobotAsset, type RobotAsset } from './robotAsset';
import type { AgentRig } from './robotRig';

export type RiggedAgentBotProps = {
  definition: RoleDefinition;
  agent?: AgentView;
  selected: boolean;
  onSelect: () => void;
  night: boolean;
  onRigReady?: (rig: AgentRig | null) => void;
  origin?: Position3;
};

export function RiggedAgentBot(props: RiggedAgentBotProps) {
  const { definition, agent, selected, night, origin } = props;
  const appearance = resolveAppearance(agent?.appearance_id ?? definition.appearance_id, definition.appearance_id);
  const invalidate = useThree(state => state.invalidate);
  const latest = useRef(props);
  const owned = useRef<RobotAsset | null>(null);
  const [asset, setAsset] = useState<RobotAsset | null>(null);

  useLayoutEffect(() => { latest.current = props; });

  useLayoutEffect(() => {
    const initial = latest.current;
    const next = buildRobotAsset(initial.definition, initial.agent, initial.night);
    next.root.position.fromArray(initial.origin ?? avatarPosition(initial.definition, initial.agent));
    next.setVisualState({ selected: initial.selected });
    next.update(0);
    owned.current = next;
    setAsset(next);
    const register = initial.onRigReady;
    register?.(next);
    invalidate();
    return () => {
      if (owned.current === next) owned.current = null;
      register?.(null);
      next.dispose();
    };
  }, [definition.role, appearance.appearance.id, invalidate]);

  useLayoutEffect(() => {
    const current = owned.current;
    if (!current) return;
    current.setVisualState({ definition, agent, selected, night });
    // Once registered, the motion controller owns location changes and heading.
    if (!latest.current.onRigReady) {
      current.root.position.fromArray(origin ?? avatarPosition(definition, agent));
      current.update(0);
    }
    invalidate();
  }, [asset, definition, agent, selected, night, origin, invalidate]);

  useFrame((state, delta) => {
    // Registered rigs are advanced exactly once by their scene controller.
    if (!latest.current.onRigReady && owned.current?.update(delta)) state.invalidate();
  });

  const onClick = useCallback((event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.delta < 6) latest.current.onSelect();
  }, []);

  return asset ? <primitive object={asset.root} dispose={null} onClick={onClick} /> : null;
}
