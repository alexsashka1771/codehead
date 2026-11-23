export type NavigationPoint = [number, number];

const tolerance = 0.000001;
const distance = (from: NavigationPoint, to: NavigationPoint) => Math.hypot(to[0] - from[0], to[1] - from[1]);

/** Finds a path using only the supplied passage segments. */
export function navigationGraphRoute(from: NavigationPoint, to: NavigationPoint,
  paths: readonly (readonly NavigationPoint[])[]): NavigationPoint[] | null {
  const nodes: NavigationPoint[] = [];
  const addNode = (point: NavigationPoint) => {
    const existing = nodes.findIndex(node => distance(node, point) < tolerance);
    if (existing >= 0) return existing;
    nodes.push([...point]);
    return nodes.length - 1;
  };
  const start = addNode(from);
  const goal = addNode(to);
  for (const path of paths) for (const point of path) addNode(point);
  const edges = nodes.map(() => new Map<number, number>());

  for (const path of paths) for (let index = 1; index < path.length; index++) {
    const a = path[index - 1];
    const b = path[index];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const squaredLength = dx * dx + dz * dz;
    if (squaredLength < tolerance * tolerance) continue;
    // Splitting at every on-segment vertex also permits reversal after repeated replanning.
    const connected = nodes.map((point, node) => {
      const ratio = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / squaredLength));
      return { node, ratio, separation: Math.hypot(point[0] - a[0] - ratio * dx, point[1] - a[1] - ratio * dz) };
    }).filter(item => item.separation < tolerance).sort((left, right) => left.ratio - right.ratio);
    for (let part = 1; part < connected.length; part++) {
      const left = connected[part - 1].node;
      const right = connected[part].node;
      const length = distance(nodes[left], nodes[right]);
      edges[left].set(right, length);
      edges[right].set(left, length);
    }
  }

  const distances = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const visited = new Set<number>();
  distances[start] = 0;
  for (let step = 0; step < nodes.length; step++) {
    let current = -1;
    for (let index = 0; index < nodes.length; index++) {
      if (!visited.has(index) && (current < 0 || distances[index] < distances[current])) current = index;
    }
    if (current < 0 || !Number.isFinite(distances[current])) break;
    if (current === goal) break;
    visited.add(current);
    for (const [next, length] of edges[current]) {
      const candidate = distances[current] + length;
      if (candidate < distances[next]) { distances[next] = candidate; previous[next] = current; }
    }
  }
  if (!Number.isFinite(distances[goal])) return null;
  const route: NavigationPoint[] = [];
  for (let current = goal; current >= 0; current = previous[current]) route.unshift([...nodes[current]]);
  return route;
}
