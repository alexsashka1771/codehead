export type SceneWorkScheduler = {
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  task: (callback: () => void) => number;
  cancelTask: (id: number) => void;
};

export function deferSceneWork(work: () => void, scheduler: SceneWorkScheduler = {
  frame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  task: callback => window.setTimeout(callback, 0), cancelTask: id => window.clearTimeout(id),
}): () => void {
  let cancelled = false;
  let task: number | null = null;
  const frame = scheduler.frame(() => {
    task = scheduler.task(() => { if (!cancelled) work(); });
  });
  return () => {
    cancelled = true;
    scheduler.cancelFrame(frame);
    if (task !== null) scheduler.cancelTask(task);
  };
}
