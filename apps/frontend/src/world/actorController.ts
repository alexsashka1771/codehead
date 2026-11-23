import type { AgentView, Role, RoleDefinition } from '../../../../packages/contracts';
import { avatarPosition, navigationRoute, workHeading } from './layout';
import { createMotion, needsMotionFrames, observeMotion, sampleMotion, type MotionState } from './motion';
import { ROBOT_MODEL_YAW, type AgentRig, type RobotClip } from './robotRig';

type ActorState = {
  rig: AgentRig;
  motion: MotionState;
  playedClip: RobotClip | null;
  playedLoop: boolean;
  animating: boolean;
};

export type RigRegistry = { rigs: Map<Role, AgentRig>; revision: number };

/** Server observations drive translation; the owned rig drives joint animation. */
export class ActorMotionController {
  private actors = new Map<Role, ActorState>();

  synchronize(definitions: RoleDefinition[], agents: AgentView[], rigs: Map<Role, AgentRig>, now: number,
    reducedMotion = false) {
    const present = new Set<Role>();
    for (const definition of definitions) {
      const rig = rigs.get(definition.role);
      if (!rig) continue;
      present.add(definition.role);
      const agent = agents.find(item => item.role === definition.role);
      const location = agent?.location ?? definition.location;
      const target = avatarPosition(definition, agent);
      const heading = !agent || agent.lifecycle === 'offline' ? 0 : workHeading(location, definition.role) - ROBOT_MODEL_YAW;
      const existing = this.actors.get(definition.role);
      const options = { reducedMotion, forwardCorrection: -ROBOT_MODEL_YAW };
      if (!existing || existing.rig !== rig) {
        this.actors.set(definition.role, {
          rig, motion: createMotion(agent, target, heading, now, options),
          playedClip: null, playedLoop: false, animating: false,
        });
        continue;
      }
      const replacedRun = existing.motion.runId !== (agent?.run_id ?? null);
      if (replacedRun || existing.motion.options.reducedMotion !== reducedMotion) {
        rig.stop();
        existing.motion = createMotion(agent, target, heading, now, options);
        existing.playedClip = null;
        existing.animating = false;
      } else {
        const current = sampleMotion(existing.motion, now);
        const targetChanged = Math.hypot(...target.map((value, index) => value - existing.motion.target[index])) > 0.001;
        const route = targetChanged
          ? navigationRoute(current.position, existing.motion.location ?? definition.location, target, location, existing.motion.route) : [];
        existing.motion = observeMotion(existing.motion, agent, target, heading, route, now);
      }
    }
    for (const role of this.actors.keys()) if (!present.has(role)) this.actors.delete(role);
  }

  advance(now: number, delta: number): { active: boolean; changed: boolean } {
    let active = false;
    let changed = false;
    for (const actor of this.actors.values()) {
      const sample = sampleMotion(actor.motion, now);
      const { rig } = actor;
      const translated = Math.hypot(rig.root.position.x - sample.position[0], rig.root.position.y - sample.position[1],
        rig.root.position.z - sample.position[2]) > 0.00001;
      const turned = Math.abs(rig.root.rotation.y - sample.heading) > 0.00001;
      rig.root.position.fromArray(sample.position);
      rig.root.rotation.y = sample.heading;
      const clipChanged = actor.playedClip !== sample.clip || actor.playedLoop !== sample.loop;
      if (clipChanged) {
        rig.play(sample.clip, sample.loop);
        actor.playedClip = sample.clip;
        actor.playedLoop = sample.loop;
        actor.animating = sample.clip !== 'idle';
      }
      let updated = false;
      if (actor.motion.options.reducedMotion && clipChanged) {
        rig.update(4);
        actor.animating = false;
        updated = true;
      } else if (actor.animating) {
        actor.animating = rig.update(clipChanged ? 0 : delta);
        updated = true;
        changed = true;
      }
      if ((translated || turned) && !updated) rig.update(0);
      changed ||= translated || turned || clipChanged;
      active ||= actor.animating || needsMotionFrames(actor.motion, now);
    }
    return { active, changed };
  }
}
