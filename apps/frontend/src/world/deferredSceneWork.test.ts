import { describe, expect, it } from 'vitest';
import { deferSceneWork, type SceneWorkScheduler } from './deferredSceneWork';

function scheduler() {
  let id = 0;
  const frames = new Map<number, () => void>();
  const tasks = new Map<number, () => void>();
  const scheduling: SceneWorkScheduler = {
    frame: callback => { frames.set(++id, callback); return id; },
    task: callback => { tasks.set(++id, callback); return id; },
    cancelFrame: key => { frames.delete(key); }, cancelTask: key => { tasks.delete(key); },
  };
  return { scheduling, frames, tasks,
    flushFrame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    flushTasks() { const callbacks = [...tasks.values()]; tasks.clear(); callbacks.forEach(callback => callback()); },
  };
}

describe('deferred scene preparation', () => {
  it('leaves a frame and a task boundary for HTML before preparing expensive reflections', () => {
    const queue = scheduler();
    let builds = 0;
    deferSceneWork(() => { builds++; }, queue.scheduling);
    expect(builds).toBe(0);
    queue.flushFrame();
    expect(builds).toBe(0);
    queue.flushTasks();
    expect(builds).toBe(1);
  });

  it('prepares only the surviving StrictMode mount', () => {
    const queue = scheduler();
    let builds = 0;
    const cancelFirst = deferSceneWork(() => { builds++; }, queue.scheduling);
    cancelFirst();
    deferSceneWork(() => { builds++; }, queue.scheduling);
    queue.flushFrame(); queue.flushTasks();
    expect(builds).toBe(1);
  });

  it('cancels a queued preparation after the frame but before its task executes', () => {
    const queue = scheduler();
    let builds = 0;
    const cancel = deferSceneWork(() => { builds++; }, queue.scheduling);
    queue.flushFrame(); cancel(); queue.flushTasks();
    expect(builds).toBe(0);
  });
});
