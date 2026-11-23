import type { AgentView } from '../../../../packages/contracts';
import type { Position3 } from './layout';
import type { RobotClip } from './robotRig';

export type MotionOptions = { reducedMotion?: boolean; forwardCorrection?: number };
export type MotionState = {
  runId: string | null;
  location: AgentView['location'] | null;
  clip: RobotClip;
  route: Position3[];
  target: Position3;
  startedAt: number;
  duration: number;
  fromHeading: number;
  goalHeading: number;
  lagSince: number;
  pendingChanges: number;
  options: MotionOptions;
};
export type MotionSample = { position: Position3; heading: number; clip: RobotClip; moving: boolean; loop: boolean };

const TURN_SECONDS = 0.18;
const MAX_TRAVEL_SECONDS = 2;
const CATCH_UP_SECONDS = 0.22;
const copy = (value: Position3): Position3 => [...value];
const distance = (a: Position3, b: Position3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function clipForAgent(agent?: AgentView): RobotClip {
  if (!agent || agent.lifecycle === 'offline') return 'idle';
  if (agent.lifecycle === 'blocked') return 'blocked';
  if (agent.lifecycle === 'failed') return 'failed';
  if (agent.lifecycle !== 'busy' || agent.activity === 'waiting' || !agent.activity) return 'idle';
  return agent.activity === 'meeting' ? 'meeting' : 'work';
}

export function createMotion(agent: AgentView | undefined, position: Position3, heading: number, now: number,
  options: MotionOptions = {}): MotionState {
  return {
    runId: agent?.run_id ?? null, location: agent?.location ?? null, clip: clipForAgent(agent),
    route: [copy(position)], target: copy(position), startedAt: now, duration: 0,
    fromHeading: heading, goalHeading: heading, lagSince: now, pendingChanges: 0, options: { ...options },
  };
}

function corridorRoute(start: Position3, supplied: Position3[], target: Position3): Position3[] {
  const result = [copy(start)];
  for (const point of [...supplied, target]) {
    if (distance(result[result.length - 1], point) > 0.0001) result.push(copy(point));
  }
  return result;
}

export function observeMotion(previous: MotionState, agent: AgentView | undefined, target: Position3,
  heading: number, route: Position3[], now: number): MotionState {
  if (!agent || agent.lifecycle === 'offline' || agent.lifecycle === 'blocked' || agent.lifecycle === 'failed'
    || agent.run_id !== previous.runId || previous.options.reducedMotion) {
    return createMotion(agent, target, agent?.lifecycle === 'offline' ? 0 : heading, now, previous.options);
  }
  const current = sampleMotion(previous, now);
  const changed = distance(previous.target, target) > 0.001;
  if (changed) {
    const nextRoute = corridorRoute(current.position, route, target);
    const length = nextRoute.slice(1).reduce((sum, point, index) => sum + distance(nextRoute[index], point), 0);
    const pendingChanges = current.moving ? previous.pendingChanges + 1 : 1;
    const lagSince = current.moving ? previous.lagSince : now;
    const catchUp = pendingChanges > 5 || now - lagSince > 2;
    return {
      ...previous, location: agent.location, clip: clipForAgent(agent), route: nextRoute, target: copy(target),
      startedAt: now, duration: catchUp ? CATCH_UP_SECONDS : Math.min(MAX_TRAVEL_SECONDS, Math.max(0.18, length / 3.2)),
      fromHeading: current.heading, goalHeading: heading, lagSince, pendingChanges,
    };
  }
  const headingChanged = Math.abs(Math.atan2(Math.sin(heading - previous.goalHeading), Math.cos(heading - previous.goalHeading))) > 0.001;
  return {
    ...previous, location: agent.location, clip: clipForAgent(agent), goalHeading: heading,
    ...(headingChanged && !current.moving ? { fromHeading: current.heading, startedAt: now, duration: 0, route: [copy(target)] } : {}),
    pendingChanges: current.moving ? previous.pendingChanges : 0,
  };
}

export function sampleMotion(state: MotionState, now: number): MotionSample {
  const progress = state.duration > 0 ? Math.min(1, Math.max(0, (now - state.startedAt) / state.duration)) : 1;
  const moving = state.duration > 0 && progress < 1 && !state.options.reducedMotion;
  let position = copy(state.target);
  let heading = state.fromHeading;
  if (moving) {
    const lengths = state.route.slice(1).map((point, index) => distance(state.route[index], point));
    let remainder = lengths.reduce((sum, value) => sum + value, 0) * progress;
    for (let index = 0; index < lengths.length; index++) {
      const length = lengths[index];
      if (remainder <= length || index === lengths.length - 1) {
        const a = state.route[index];
        const b = state.route[index + 1];
        const ratio = length > 0 ? Math.min(1, remainder / length) : 1;
        position = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, a[2] + (b[2] - a[2]) * ratio];
        heading = Math.atan2(b[0] - a[0], b[2] - a[2]) + (state.options.forwardCorrection ?? 0);
        break;
      }
      remainder -= length;
    }
  } else {
    if (state.duration > 0 && state.route.length > 1) {
      const a = state.route[state.route.length - 2];
      const b = state.route[state.route.length - 1];
      heading = Math.atan2(b[0] - a[0], b[2] - a[2]) + (state.options.forwardCorrection ?? 0);
    }
    const turn = state.options.reducedMotion ? 1 : Math.min(1, Math.max(0, (now - state.startedAt - state.duration) / TURN_SECONDS));
    const delta = Math.atan2(Math.sin(state.goalHeading - heading), Math.cos(state.goalHeading - heading));
    heading += delta * turn;
  }
  const clip = moving ? 'walk' : state.clip;
  return { position, heading, clip, moving, loop: !state.options.reducedMotion && ['walk', 'work', 'meeting'].includes(clip) };
}

export function needsMotionFrames(state: MotionState, now: number): boolean {
  if (state.options.reducedMotion) return false;
  if (now < state.startedAt + state.duration) return true;
  let arrivalHeading = state.fromHeading;
  if (state.duration > 0 && state.route.length > 1) {
    const a = state.route[state.route.length - 2];
    const b = state.route[state.route.length - 1];
    arrivalHeading = Math.atan2(b[0] - a[0], b[2] - a[2]) + (state.options.forwardCorrection ?? 0);
  }
  const turning = Math.abs(Math.atan2(Math.sin(state.goalHeading - arrivalHeading), Math.cos(state.goalHeading - arrivalHeading))) > 0.001;
  return turning && now < state.startedAt + state.duration + TURN_SECONDS;
}
