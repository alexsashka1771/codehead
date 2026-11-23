import { useLayoutEffect, useMemo, useRef } from 'react';
import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { reconcileSceneList } from './sceneSnapshot';

export function useSceneSnapshot(roles: RoleDefinition[], agents: AgentView[]) {
  const previous = useRef({ roles, agents });
  const sceneRoles = useMemo(() => reconcileSceneList(previous.current.roles, roles), [roles]);
  const sceneAgents = useMemo(() => reconcileSceneList(previous.current.agents, agents), [agents]);
  useLayoutEffect(() => { previous.current = { roles: sceneRoles, agents: sceneAgents }; });
  return { roles: sceneRoles, agents: sceneAgents };
}
