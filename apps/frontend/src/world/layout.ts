import type { AgentView, Location, Role, RoleDefinition } from '../../../../packages/contracts';
import type { CameraBounds } from './camera';
import { navigationGraphRoute } from './navigationGraph';

export type Position3 = [number, number, number];
type Position2 = [number, number];
type NavigationBlocker = { min: Position2; max: Position2 };

// One inhabited shell; the backdrop is deliberately excluded from camera fitting.
export const FACTORY_BOUNDS = { min: [-10.72, -0.56, -8.4] as const, max: [10.72, 4.0, 8.88] as const };
export const ROBOT_SCALE = 1.15;
export const DECK_HEIGHT = 0.16;

export const zonePositions: Record<Location, Position2> = {
  product: [-7.35, -3.95],
  architecture: [-1.7, -5.55],
  security: [2.0, -6.08],
  development: [-7.05, 1.45],
  devops: [7.15, -1.65],
  research: [7.15, -5.6],
  meeting: [-6.15, 6.55],
  qa: [3.55, 5.05],
  production: [8.25, 4.95],
  core: [0, 0],
};

export const plannedZones: ReadonlySet<Location> = new Set(['security', 'research', 'meeting', 'production']);

// A logical alcove shares its physical studio's slab, threshold and services.
export const roomFootprints: Record<Location, { size: Position2; radius: number; offset: Position2 }> = {
  product: { size: [5.75, 5.8], radius: 0.82, offset: [0, 0] },
  architecture: { size: [5.05, 4.9], radius: 0.84, offset: [-0.05, -0.05] },
  security: { size: [2.35, 3.9], radius: 0.47, offset: [0, 0] },
  development: { size: [6.55, 5.65], radius: 0.88, offset: [0, 0] },
  devops: { size: [5.95, 3.45], radius: 0.72, offset: [0, 0] },
  research: { size: [5.95, 3.45], radius: 0.83, offset: [0, -0.2] },
  meeting: { size: [7.55, 3.65], radius: 0.91, offset: [0, 0.15] },
  qa: { size: [5.75, 5.85], radius: 0.88, offset: [0, 0.1] },
  production: { size: [3.6, 5.85], radius: 0.68, offset: [0, -0.05] },
  core: { size: [4.7, 4.7], radius: 2.2, offset: [0, 0] },
};

export function zoneSize(zone: Location): Position2 {
  return roomFootprints[zone].size;
}

const roles: Role[] = ['product_manager', 'architect', 'cto', 'backend', 'frontend', 'qa', 'devops'];
const workPlaces: Partial<Record<Location, Partial<Record<Role, Position2>>>> = {
  product: { product_manager: [-7.35, -3.35] },
  architecture: { architect: [-2.85, -4.6], cto: [-0.55, -4.6] },
  development: { backend: [-8.65, 1.15], frontend: [-5.55, 1.15] },
  qa: { qa: [4.35, 4.4] },
  devops: { devops: [7.15, -0.65] },
};

export const meetingPlaces: Record<Role, Position2> = {
  product_manager: [-8.87, 6.55],
  architect: [-7.62, 5.2],
  cto: [-6.22, 5.2],
  backend: [-4.82, 5.2],
  frontend: [-3.48, 6.55],
  qa: [-5.42, 8.06],
  devops: [-7.12, 8.06],
};

function place(location: Location, role: Role): Position2 {
  if (location === 'meeting') return meetingPlaces[role];
  const workstation = workPlaces[location]?.[role];
  if (workstation) return workstation;
  const index = roles.indexOf(role);
  if (location === 'core') {
    const servicePlaces: Position2[] = [[2.3, 0], [2.3, 1.25], [1.0, 1.95], [-1.0, 1.95], [-2.3, 0], [-1.4, -2.3], [1.4, -2.3]];
    return servicePlaces[index];
  }
  const [x, z] = zonePositions[location];
  const width = Math.min(3.7, roomFootprints[location].size[0] - 1.0);
  const forward = location === 'research' ? 1.1 : location === 'security' ? 1.22 : location === 'production' ? 1.5 : 1.75;
  return [x + (index - 3) / 6 * width, z + forward];
}

export function avatarPosition(definition: RoleDefinition, agent?: AgentView): Position3 {
  const [x, z] = place(agent?.location ?? definition.location, definition.role);
  return [x, DECK_HEIGHT, z];
}

// Physical control positions are shared by the environment and the animation rig.
export function workSurfaceTarget(location: Location, role: Role): Position3 {
  const [x, z] = place(location, role);
  if (location === 'meeting' || location === 'core') {
    const [cx, cz] = zonePositions[location];
    return [cx, location === 'core' ? 1.45 : 1.23, cz];
  }
  return [x, 1.25, z - 0.61];
}

export function workHeading(location: Location, role: Role): number {
  const [x, z] = place(location, role);
  const [tx, , tz] = workSurfaceTarget(location, role);
  return Math.atan2(tx - x, tz - z);
}

export function roomFocusBounds(location: Location): CameraBounds {
  const [x, z] = zonePositions[location];
  const { size: [width, depth], offset: [dx, dz] } = roomFootprints[location];
  return {
    min: [x + dx - width / 2 - 0.24, -0.08, z + dz - depth / 2 - 0.24],
    max: [x + dx + width / 2 + 0.24, 3.86, z + dz + depth / 2 + 0.24],
  };
}

// These footprints describe the solid furniture, not merely the zone decoration.
export const NAVIGATION_BLOCKERS: Record<Location, NavigationBlocker[]> = {
  product: [{ min: [-9.25, -5.01], max: [-5.45, -3.91] }, { min: [-9.72, -6.65], max: [-8.85, -5.12] }],
  architecture: [{ min: [-4.02, -6.17], max: [0.62, -5.03] }],
  security: [{ min: [0.86, -7.0], max: [2.98, -5.36] }],
  development: [{ min: [-9.93, -0.47], max: [-7.37, 0.68] }, { min: [-6.87, -0.47], max: [-4.23, 0.68] }],
  qa: [{ min: [3.44, 2.95], max: [5.28, 3.86] }, { min: [1.21, 4.66], max: [3.13, 6.21] }],
  devops: [{ min: [5.83, -2.12], max: [8.47, -1.07] }, { min: [4.98, -4.25], max: [9.61, -3.05] }],
  research: [{ min: [5.25, -6.75], max: [8.88, -5.52] }],
  production: [{ min: [7.03, 3.45], max: [9.45, 5.36] }],
  meeting: [{ min: [-8.35, 5.73], max: [-3.95, 7.37] }],
  core: [{ min: [-1.56, -1.56], max: [1.56, 1.56] }],
};

const portals: Record<Location, Position2> = {
  product: [-4.31, -2.37], architecture: [-1.55, -3.03], security: [2.43, -3.03],
  development: [-3.58, 2.3], devops: [3.97, -0.92], research: [4.0, -5.05],
  qa: [0.52, 3.36], production: [7.65, 1.77], meeting: [-2.46, 6.55], core: [2.3, 0],
};

const promenade: Position2[] = [[-2.3, -2.3], [0, -2.3], [2.3, -2.3], [2.3, 0], [2.3, 1.95], [0, 1.95], [-2.3, 1.95], [-2.3, 0]];
const approaches: Record<Location, { ring: number; points: Position2[] }> = {
  product: { ring: 0, points: [[-3.5, -2.37], portals.product] },
  architecture: { ring: 1, points: [[-1.55, -2.3], portals.architecture] },
  security: { ring: 2, points: [portals.security] },
  development: { ring: 6, points: [[-2.75, 2.3], portals.development] },
  devops: { ring: 3, points: [[3.4, 0], portals.devops] },
  research: { ring: 2, points: [[3.55, -2.3], [3.55, -5.05], portals.research] },
  qa: { ring: 5, points: [[0.2, 1.95], [0.2, 3.36], portals.qa] },
  production: { ring: 4, points: [[4.65, 1.53], [7.65, 1.53], portals.production] },
  meeting: { ring: 5, points: [[-1.4, 2.6], [-1.4, 6.55], portals.meeting] },
  core: { ring: 3, points: [portals.core] },
};
const passagePaths: Position2[][] = [
  [...promenade, promenade[0]],
  ...Object.values(approaches).map(approach => [promenade[approach.ring], ...approach.points]),
];

const clearance = 0.25;

function segmentClear(from: Position2, to: Position2, blockers: NavigationBlocker[]) {
  return blockers.every(blocker => {
    let near = 0;
    let far = 1;
    for (let axis = 0; axis < 2; axis++) {
      const delta = to[axis] - from[axis];
      const min = blocker.min[axis] - clearance;
      const max = blocker.max[axis] + clearance;
      if (Math.abs(delta) < 0.00001) {
        if (from[axis] <= min || from[axis] >= max) return true;
      } else {
        const a = (min - from[axis]) / delta;
        const b = (max - from[axis]) / delta;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
      }
    }
    return near >= far || far <= 0 || near >= 1;
  });
}

function localRoute(from: Position2, to: Position2, location: Location): Position2[] {
  const blockers = NAVIGATION_BLOCKERS[location];
  if (segmentClear(from, to, blockers)) return [from, to];
  const nodes: Position2[] = [from, to];
  for (const blocker of blockers) {
    const left = blocker.min[0] - clearance - 0.02;
    const right = blocker.max[0] + clearance + 0.02;
    const back = blocker.min[1] - clearance - 0.02;
    const front = blocker.max[1] + clearance + 0.02;
    nodes.push([left, back], [right, back], [right, front], [left, front]);
  }
  const distances = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const visited = new Set<number>();
  distances[0] = 0;
  for (let step = 0; step < nodes.length; step++) {
    let current = -1;
    for (let index = 0; index < nodes.length; index++) {
      if (!visited.has(index) && (current < 0 || distances[index] < distances[current])) current = index;
    }
    if (current < 0 || !Number.isFinite(distances[current])) break;
    if (current === 1) break;
    visited.add(current);
    for (let index = 0; index < nodes.length; index++) {
      if (visited.has(index) || !segmentClear(nodes[current], nodes[index], blockers)) continue;
      const distance = distances[current] + Math.hypot(nodes[index][0] - nodes[current][0], nodes[index][1] - nodes[current][1]);
      if (distance < distances[index]) { distances[index] = distance; previous[index] = current; }
    }
  }
  if (!Number.isFinite(distances[1])) return [from, to];
  const route: Position2[] = [to];
  for (let current = previous[1]; current >= 0; current = previous[current]) route.unshift(nodes[current]);
  return route;
}

function ringRoute(from: number, to: number): Position2[] {
  const candidates = [1, -1].map(direction => {
    const route: Position2[] = [promenade[from]];
    for (let index = from; index !== to;) {
      index = (index + direction + promenade.length) % promenade.length;
      route.push(promenade[index]);
    }
    const distance = route.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - route[index][0], point[1] - route[index][1]), 0);
    return { route, distance };
  });
  return candidates[0].distance <= candidates[1].distance ? candidates[0].route : candidates[1].route;
}

export function navigationRoute(from: Position3, fromLocation: Location, to: Position3, toLocation: Location,
  previousRoute?: readonly Position3[]): Position3[] {
  const start: Position2 = [from[0], from[2]];
  const end: Position2 = [to[0], to[2]];
  let points: Position2[] | null = null;
  if (previousRoute && previousRoute.length > 1) {
    // During an interruption fromLocation names the previous goal; from lies on the physical route.
    const previous: Position2[] = previousRoute.map(point => [point[0], point[2]]);
    points = navigationGraphRoute(start, end, [
      ...passagePaths,
      previous,
      localRoute(previous[previous.length - 1], portals[fromLocation], fromLocation),
      localRoute(portals[toLocation], end, toLocation),
    ]);
  }
  points ??= fromLocation === toLocation ? localRoute(start, end, fromLocation) : [
    ...localRoute(start, portals[fromLocation], fromLocation),
    ...approaches[fromLocation].points.slice().reverse(),
    ...ringRoute(approaches[fromLocation].ring, approaches[toLocation].ring),
    ...approaches[toLocation].points,
    ...localRoute(portals[toLocation], end, toLocation),
  ];
  const unique = points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 0.001);
  const result: Position3[] = unique.map(([x, z]) => [x, DECK_HEIGHT, z]);
  result[0] = [...from];
  result[result.length - 1] = [...to];
  return result;
}

export function labelAnchors(definitions: RoleDefinition[], agents: AgentView[]): Record<string, Position3> {
  const anchors: Record<string, Position3> = {};
  for (const [zone, [x, z]] of Object.entries(zonePositions)) {
    const footprint = roomFootprints[zone as Location];
    anchors['zone.' + zone] = [x + footprint.offset[0], DECK_HEIGHT + 0.015, z + footprint.offset[1] + footprint.size[1] / 2 - 0.27];
  }
  for (const definition of definitions) {
    const [x, y, z] = avatarPosition(definition, agents.find(agent => agent.role === definition.role));
    anchors[`agent.${definition.role}`] = [x, y + 2.8, z];
  }
  return anchors;
}
