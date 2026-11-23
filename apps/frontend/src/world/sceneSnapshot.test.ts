import { describe, expect, it } from 'vitest';
import type { AgentView } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import { reconcileSceneList } from './sceneSnapshot';

const agent: AgentView = {
  id: 'actor', run_id: 'run-a', role: 'backend', instructions_version: '1',
  appearance_id: 'backend_v1', lifecycle: 'offline', activity: null,
  location: 'development', current_task_id: null, allowed_operations: ['read'],
};
const agents = [agent, { ...agent, id: 'second-actor', role: 'frontend' as const }];

describe('scene snapshot identity', () => {
  it('reuses the scene source when a new transport snapshot has identical role data', () => {
    const copies = agents.map(item => ({ ...item, allowed_operations: [...(item.allowed_operations ?? [])] }));
    expect(reconcileSceneList(agents, copies)).toBe(agents);
    expect(reconcileSceneList(fallbackRoles, fallbackRoles.map(item => ({ ...item })))).toBe(fallbackRoles);
  });

  it.each([
    { lifecycle: 'busy' as const }, { location: 'meeting' as const }, { activity: 'coding' as const },
    { run_id: 'run-b' }, { appearance_id: 'alternate' }, { current_task_id: 'task-b' },
  ])('retains unchanged models while observing the real change %o', change => {
    const changed = { ...agent, ...change };
    const source = reconcileSceneList(agents, [changed, { ...agents[1] }]);
    expect(source).not.toBe(agents);
    expect(source[0]).toBe(changed);
    expect(source[1]).toBe(agents[1]);
  });

  it('keeps current role order and removes absent models without mutating either snapshot', () => {
    const source = reconcileSceneList(agents, [{ ...agents[1] }]);
    expect(source).toEqual([agents[1]]);
    expect(source[0]).toBe(agents[1]);
    expect(agents).toHaveLength(2);
  });
});
