import { describe, expect, it } from 'vitest';
import type { AgentView } from '../../../../packages/contracts';
import { clipForAgent, createMotion, observeMotion, sampleMotion, needsMotionFrames } from './motion';

const agent: AgentView = {
  id: 'actor', run_id: 'run-a', role: 'backend', instructions_version: '1',
  appearance_id: 'backend_v1', lifecycle: 'busy', activity: 'coding',
  location: 'development', current_task_id: 'task-a', allowed_operations: [],
};

describe('server-driven motion presentation', () => {
  it('requests no frames for a stationary offline role', () => {
    const state = createMotion({ ...agent, lifecycle: 'offline' }, [0, 0.16, 0], 0, 0);
    expect(needsMotionFrames(state, 0)).toBe(false);
  });

  it('retains the direction of the final walking segment when arriving', () => {
    const state = observeMotion(createMotion(agent, [0, 0.16, 0], 0, 0), agent,
      [3, 0.16, 0], Math.PI / 2, [[0, 0.16, 0], [3, 0.16, 0]], 1);
    expect(sampleMotion(state, 1 + state.duration).heading).toBeCloseTo(Math.PI / 2);
  });
  it('gives offline and waiting states no fictitious work', () => {
    expect(clipForAgent(undefined)).toBe('idle');
    expect(clipForAgent({ ...agent, lifecycle: 'offline' })).toBe('idle');
    expect(clipForAgent({ ...agent, activity: 'waiting' })).toBe('idle');
    expect(clipForAgent({ ...agent, activity: null })).toBe('idle');
    expect(clipForAgent(agent)).toBe('work');
    expect(clipForAgent({ ...agent, activity: 'meeting' })).toBe('meeting');
    expect(clipForAgent({ ...agent, lifecycle: 'blocked' })).toBe('blocked');
    expect(clipForAgent({ ...agent, lifecycle: 'failed' })).toBe('failed');
  });

  it('follows a supplied corridor route before starting the destination activity', () => {
    const initial = createMotion(agent, [-2, 0.16, 0], 0, 0);
    const moved = observeMotion(initial, { ...agent, location: 'qa' }, [2, 0.16, 0], Math.PI,
      [[-2, 0.16, 0], [-2, 0.16, 2], [2, 0.16, 2], [2, 0.16, 0]], 1);
    const corner = sampleMotion(moved, 1 + moved.duration * 0.25);
    expect(corner.clip).toBe('walk');
    expect(corner.position[0]).toBeCloseTo(-2);
    expect(corner.position[2]).toBeCloseTo(2);
    expect(sampleMotion(moved, 1 + moved.duration + 0.3).position).toEqual([2, 0.16, 0]);
    expect(sampleMotion(moved, 1 + moved.duration + 0.3).clip).toBe('work');
  });

  it('stops movement immediately when the server disconnects or blocks a role', () => {
    const initial = createMotion(agent, [0, 0.16, 0], 0, 0);
    const moved = observeMotion(initial, agent, [4, 0.16, 0], 0, [[0, 0.16, 0], [4, 0.16, 0]], 1);
    const offline = observeMotion(moved, { ...agent, lifecycle: 'offline' }, [4, 0.16, 0], 0, [], 1.2);
    expect(sampleMotion(offline, 1.2)).toMatchObject({ position: [4, 0.16, 0], clip: 'idle', moving: false, loop: false });
    expect(needsMotionFrames(offline, 2)).toBe(false);
    const blocked = observeMotion(moved, { ...agent, lifecycle: 'blocked' }, [4, 0.16, 0], 0, [], 1.2);
    expect(sampleMotion(blocked, 1.2)).toMatchObject({ clip: 'blocked', moving: false, loop: false });
  });

  it('does not reuse a pending walk from a different run', () => {
    const initial = createMotion(agent, [0, 0.16, 0], 0, 0);
    const moving = observeMotion(initial, agent, [5, 0.16, 0], 0, [[0, 0.16, 0], [5, 0.16, 0]], 1);
    const replacement = observeMotion(moving, { ...agent, run_id: 'run-b' }, [-3, 0.16, 0], 0, [], 1.1);
    expect(sampleMotion(replacement, 1.1).position).toEqual([-3, 0.16, 0]);
    expect(sampleMotion(replacement, 1.1).moving).toBe(false);
  });

  it('bounds a fast stream of movement updates and reaches the latest target', () => {
    let state = createMotion(agent, [0, 0.16, 0], 0, 0);
    for (let index = 1; index <= 7; index++) {
      const now = index * 0.01;
      state = observeMotion(state, agent, [index, 0.16, 0], 0,
        [sampleMotion(state, now).position, [index, 0.16, 0]], now);
    }
    expect(state.duration).toBeLessThanOrEqual(0.25);
    expect(sampleMotion(state, 0.6).position).toEqual([7, 0.16, 0]);
  });

  it('honors reduced motion and does not mutate the server observation', () => {
    const observation = Object.freeze({ ...agent });
    const initial = createMotion(observation, [0, 0.16, 0], 0, 0, { reducedMotion: true });
    const state = observeMotion(initial, observation, [5, 0.16, 0], 0, [[0, 0.16, 0], [5, 0.16, 0]], 1);
    expect(sampleMotion(state, 1)).toMatchObject({ position: [5, 0.16, 0], moving: false, loop: false });
    expect(observation.location).toBe('development');
  });
});
