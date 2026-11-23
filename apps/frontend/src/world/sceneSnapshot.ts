import type { Role } from '../../../../packages/contracts';

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** Reuse identical transport records; every real field change reaches the renderer. */
export function reconcileSceneList<T extends { role: Role }>(previous: T[], incoming: T[]): T[] {
  if (previous === incoming) return previous;
  const result = incoming.map(item => {
    const old = previous.find(candidate => candidate.role === item.role);
    return old && sameValue(old, item) ? old : item;
  });
  return result.length === previous.length && result.every((item, index) => item === previous[index]) ? previous : result;
}
