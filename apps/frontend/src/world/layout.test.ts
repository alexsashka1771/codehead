import { describe, expect, it } from 'vitest';
import type { AgentView, Location } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import { avatarPosition, DECK_HEIGHT, NAVIGATION_BLOCKERS, navigationRoute, roomFocusBounds, workHeading, workSurfaceTarget, zonePositions, type Position3 } from './layout';

function distanceToSegment(point: [number, number], from: [number, number, number], to: [number, number, number]) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const t = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[2]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(point[0] - from[0] - t * dx, point[1] - from[2] - t * dz);
}

function alongSegment(route: Position3[], start: [number, number], ratio: number): Position3 {
  const index = route.findIndex(point => Math.hypot(point[0] - start[0], point[2] - start[1]) < 0.001);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(index + 1).toBeLessThan(route.length);
  return route[index].map((value, axis) => value + (route[index + 1][axis] - value) * ratio) as Position3;
}

function expectSafeRoute(route: Position3[], from: Position3, to: Position3) {
  expect(route[0]).toEqual(from);
  expect(route.at(-1)).toEqual(to);
  expect(route.every(point => point.every(Number.isFinite) && point[1] === DECK_HEIGHT)).toBe(true);
  const blockers = Object.values(NAVIGATION_BLOCKERS).flat();
  for (let index = 1; index < route.length; index++) {
    expect(distanceToSegment(zonePositions.core, route[index - 1], route[index])).toBeGreaterThan(1.65);
    for (let sample = 0; sample <= 30; sample++) {
      const ratio = sample / 30;
      const x = route[index - 1][0] + (route[index][0] - route[index - 1][0]) * ratio;
      const z = route[index - 1][2] + (route[index][2] - route[index - 1][2]) * ratio;
      expect(blockers.some(blocker => x > blocker.min[0] - 0.1 && x < blocker.max[0] + 0.1
        && z > blocker.min[1] - 0.1 && z < blocker.max[1] + 0.1)).toBe(false);
    }
  }
}

describe('inhabitable atelier layout', () => {
  it('frames the floor, assigned actors and equipment of each logical zone', () => {
    for (const definition of fallbackRoles) {
      const [x, y, z] = avatarPosition(definition);
      const bounds = roomFocusBounds(definition.location);
      expect(y).toBe(DECK_HEIGHT);
      expect(x).toBeGreaterThan(bounds.min[0]);
      expect(x).toBeLessThan(bounds.max[0]);
      expect(z).toBeGreaterThan(bounds.min[2]);
      expect(z).toBeLessThan(bounds.max[2]);
      expect(bounds.max[1]).toBeGreaterThan(y + 2.5);
    }
  });

  it('gives all seven roles a distinct meeting place facing the table', () => {
    const places = fallbackRoles.map(definition => avatarPosition(definition, { location: 'meeting' } as AgentView));
    for (let index = 0; index < places.length; index++) {
      for (let other = index + 1; other < places.length; other++) {
        expect(Math.hypot(places[index][0] - places[other][0], places[index][2] - places[other][2])).toBeGreaterThan(0.75);
      }
      const heading = workHeading('meeting', fallbackRoles[index].role);
      const [x, , z] = places[index];
      const centre = zonePositions.meeting;
      const alignment = Math.sin(heading) * (centre[0] - x) + Math.cos(heading) * (centre[1] - z);
      expect(alignment).toBeGreaterThan(0);
    }
  });

  it('routes every assigned role between logical zones around the Core', () => {
    const locations = Object.keys(zonePositions) as Location[];
    const definition = fallbackRoles[0];
    for (const fromLocation of locations) for (const toLocation of locations) {
      if (fromLocation === toLocation) continue;
      const from = avatarPosition(definition, { location: fromLocation } as AgentView);
      const to = avatarPosition(definition, { location: toLocation } as AgentView);
      const route = navigationRoute(from, fromLocation, to, toLocation);
      expect(route[0]).toEqual(from);
      expect(route.at(-1)).toEqual(to);
      expect(route.every(point => point.every(Number.isFinite) && point[1] === DECK_HEIGHT)).toBe(true);
      for (let index = 1; index < route.length; index++) {
        expect(distanceToSegment(zonePositions.core, route[index - 1], route[index])).toBeGreaterThan(1.65);
      }
    }
  });

  it('uses the door and passes round the meeting table when approaching a far seat', () => {
    const definition = fallbackRoles.find(role => role.role === 'devops')!;
    const from = avatarPosition(definition);
    const to = avatarPosition(definition, { location: 'meeting' } as AgentView);
    const route = navigationRoute(from, 'devops', to, 'meeting');
    expect(route.some(point => point[0] > -3.1 && point[2] > 5.5)).toBe(true);
    for (let index = 1; index < route.length; index++) {
      for (let sample = 0; sample <= 20; sample++) {
        const t = sample / 20;
        const x = route[index - 1][0] + (route[index][0] - route[index - 1][0]) * t;
        const z = route[index - 1][2] + (route[index][2] - route[index - 1][2]) * t;
        expect(x > -8.35 && x < -3.95 && z > 5.73 && z < 7.37).toBe(false);
      }
    }
  });

  it('keeps every role clear of the Core when leaving its service promenade', () => {
    for (const definition of fallbackRoles) {
      const from = avatarPosition(definition, { location: 'core' } as AgentView);
      const to = avatarPosition(definition);
      const route = navigationRoute(from, 'core', to, definition.location);
      for (let index = 1; index < route.length; index++) {
        expect(distanceToSegment(zonePositions.core, route[index - 1], route[index])).toBeGreaterThan(1.65);
      }
    }
  });

  it('keeps the assigned controls in hand reach and routes all work places clear of solid benches', () => {
    const blockers = Object.values(NAVIGATION_BLOCKERS).flat();
    for (const definition of fallbackRoles) {
      const from = avatarPosition(definition);
      const target = workSurfaceTarget(definition.location, definition.role);
      expect(Math.hypot(target[0] - from[0], target[2] - from[2])).toBeLessThan(0.75);
      expect(target[1]).toBeGreaterThan(0.9);
      expect(target[1]).toBeLessThan(1.5);
      const to = avatarPosition(definition, { location: 'meeting' } as AgentView);
      const route = navigationRoute(from, definition.location, to, 'meeting');
      for (let index = 1; index < route.length; index++) for (let sample = 0; sample <= 30; sample++) {
        const t = sample / 30;
        const x = route[index - 1][0] + (route[index][0] - route[index - 1][0]) * t;
        const z = route[index - 1][2] + (route[index][2] - route[index - 1][2]) * t;
        expect(blockers.some(blocker => x > blocker.min[0] - 0.1 && x < blocker.max[0] + 0.1 && z > blocker.min[1] - 0.1 && z < blocker.max[1] + 0.1)).toBe(false);
      }
    }
  });

  it.each([
    { phase: 'source room exit', start: [-8.65, 1.15], ratio: 0.2, target: 'qa', door: [-3.58, 2.3] },
    { phase: 'central promenade', start: [-2.3, 1.95], ratio: 0.4, target: 'product', door: [-4.31, -2.37] },
    { phase: 'destination approach', start: [3.4, 0], ratio: 0.4, target: 'qa', door: [0.52, 3.36] },
    { phase: 'destination room entry', start: [3.97, -0.92], ratio: 0.55, target: 'meeting', door: [3.97, -0.92] },
  ] as const)('replans from the physical position during $phase', ({ start, ratio, target, door }) => {
    const definition = fallbackRoles.find(role => role.role === 'backend')!;
    const origin = avatarPosition(definition);
    const previousTarget = avatarPosition(definition, { location: 'devops' } as AgentView);
    const previousRoute = navigationRoute(origin, 'development', previousTarget, 'devops');
    const from = alongSegment(previousRoute, [...start], ratio);
    const to = avatarPosition(definition, { location: target } as AgentView);
    const route = navigationRoute(from, 'devops', to, target, previousRoute);
    expectSafeRoute(route, from, to);
    expect(route.some(point => point[0] === door[0] && point[2] === door[1])).toBe(true);
    if (target !== 'meeting') {
      expect(route.some(point => point[0] === 3.97 && point[2] === -0.92)).toBe(false);
    }
  });

  it('can reverse an interrupted room exit before reaching the abandoned destination', () => {
    const definition = fallbackRoles.find(role => role.role === 'backend')!;
    const to = avatarPosition(definition);
    const previousTarget = avatarPosition(definition, { location: 'devops' } as AgentView);
    const previousRoute = navigationRoute(to, 'development', previousTarget, 'devops');
    const from = alongSegment(previousRoute, [to[0], to[2]], 0.2);
    const route = navigationRoute(from, 'devops', to, 'development', previousRoute);
    expectSafeRoute(route, from, to);
    expect(route).toEqual([from, to]);
  });

  it('keeps repeated target changes on the passages when the route begins midway along the promenade', () => {
    const definition = fallbackRoles.find(role => role.role === 'backend')!;
    const origin = avatarPosition(definition);
    const devops = avatarPosition(definition, { location: 'devops' } as AgentView);
    const initial = navigationRoute(origin, 'development', devops, 'devops');
    const firstPosition = alongSegment(initial, [-2.3, 1.95], 0.35);
    const qa = avatarPosition(definition, { location: 'qa' } as AgentView);
    const first = navigationRoute(firstPosition, 'devops', qa, 'qa', initial);
    expectSafeRoute(first, firstPosition, qa);
    const secondPosition = alongSegment(first, [firstPosition[0], firstPosition[2]], 0.4);
    const second = navigationRoute(secondPosition, 'qa', origin, 'development', first);
    expectSafeRoute(second, secondPosition, origin);
    expect(second[1][0]).toBeLessThan(secondPosition[0]);
    expect(second[1][2]).toBe(1.95);
    expect(second.some(point => point[0] === 0.52 && point[2] === 3.36)).toBe(false);
  });
});
