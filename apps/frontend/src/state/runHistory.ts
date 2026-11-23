import type { RunView } from '../../../../packages/contracts';

export function mergeRunHistory(received: RunView[], current: RunView[], projectId: string): RunView[] {
  const merged = new Map<string, RunView>();
  for (const run of [...received, ...current]) {
    if (run.project_id !== projectId) continue;
    const previous = merged.get(run.id);
    if (!previous || run.last_event_seq >= previous.last_event_seq) merged.set(run.id, run);
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}
