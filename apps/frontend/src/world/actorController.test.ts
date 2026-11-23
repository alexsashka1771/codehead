import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { AgentView, Role } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import { ActorMotionController } from './actorController';
import { avatarPosition, NAVIGATION_BLOCKERS, workHeading } from './layout';
import { buildRobotAsset } from './robotAsset';
import { ROBOT_MODEL_YAW, type AgentRig } from './robotRig';

const definition = fallbackRoles.find(role => role.role === 'backend')!;
const observation: AgentView = {
  id: 'backend-actor', run_id: 'run-a', role: 'backend', instructions_version: '1',
  appearance_id: definition.appearance_id, lifecycle: 'busy', activity: 'coding',
  location: 'development', current_task_id: 'task-a', allowed_operations: [],
};

function rigMap(rig: AgentRig) { return new Map<Role, AgentRig>([['backend', rig]]); }

describe('real scene actor controller', () => {
  it('keeps an interrupted walk outside the solid Core footprint', () => {
    const rig = buildRobotAsset(definition, observation, true);
    try {
      const controller = new ActorMotionController();
      const rigs = rigMap(rig);
      controller.synchronize([definition], [observation], rigs, 0);
      controller.advance(0, 0);
      controller.synchronize([definition], [{ ...observation, location: 'devops' }], rigs, 1);
      controller.advance(1.1, 0.1);
      const latest = { ...observation, location: 'qa' as const };
      controller.synchronize([definition], [latest], rigs, 1.1);
      const blocker = NAVIGATION_BLOCKERS.core[0];
      for (let step = 0; step <= 110; step++) {
        controller.advance(1.1 + step * 0.02, 0.02);
        const { x, z } = rig.root.position;
        const inside = x > blocker.min[0] && x < blocker.max[0] && z > blocker.min[1] && z < blocker.max[1];
        expect(inside, `Core collision at ${x}, ${z}`).toBe(false);
      }
      expect(rig.root.position.toArray()).toEqual(avatarPosition(definition, latest));
    } finally { rig.dispose(); }
  });

  it('starts a newly observed finite clip from rest after a long idle interval', () => {
    const rig = buildRobotAsset(definition, observation, true);
    try {
      const controller = new ActorMotionController();
      controller.synchronize([definition], [{ ...observation, lifecycle: 'offline' }], rigMap(rig), 0);
      controller.advance(0, 0);
      controller.synchronize([definition], [{ ...observation, lifecycle: 'failed' }], rigMap(rig), 20);
      expect(controller.advance(20, 20).active).toBe(true);
      expect(controller.advance(21, 1).active).toBe(false);
    } finally { rig.dispose(); }
  });

  it('leaves an offline skeleton in its rest pose without requesting frames', () => {
    const offline = { ...observation, lifecycle: 'offline' as const };
    const rig = buildRobotAsset(definition, offline, true);
    try {
      const head = rig.skeleton.bones.find(bone => bone.name === 'head')!;
      const rest = head.quaternion.clone();
      const controller = new ActorMotionController();
      controller.synchronize([definition], [offline], rigMap(rig), 0);
      expect(controller.advance(0, 0).active).toBe(false);
      expect(controller.advance(10, 1).active).toBe(false);
      expect(head.quaternion.equals(rest)).toBe(true);
      expect(rig.root.rotation.y).toBe(0);
      expect(rig.root.userData.robot_clip).toBe('idle');
    } finally { rig.dispose(); }
  });

  it('moves real joints only while the server describes work', () => {
    const rig = buildRobotAsset(definition, observation, true);
    try {
      const shoulder = rig.skeleton.bones.find(bone => bone.name === 'leftShoulder')!;
      const rest = shoulder.quaternion.clone();
      const controller = new ActorMotionController();
      controller.synchronize([definition], [observation], rigMap(rig), 0);
      controller.advance(0, 0);
      expect(controller.advance(0.35, 0.35).active).toBe(true);
      expect(shoulder.quaternion.angleTo(rest)).toBeGreaterThan(0.1);
      expect(rig.root.position.toArray()).toEqual(avatarPosition(definition, observation));
      controller.synchronize([definition], [{ ...observation, activity: 'waiting' }], rigMap(rig), 0.4);
      expect(controller.advance(0.4, 0.05).active).toBe(false);
      expect(shoulder.quaternion.angleTo(rest)).toBeLessThan(1e-6);
      expect(rig.root.userData.robot_clip).toBe('idle');
    } finally { rig.dispose(); }
  });

  it('walks between actual locations and projects the moving head instead of the destination', () => {
    const rig = buildRobotAsset(definition, observation, true);
    try {
      const controller = new ActorMotionController();
      const rigs = rigMap(rig);
      controller.synchronize([definition], [observation], rigs, 0);
      controller.advance(0, 0);
      const initial = rig.root.position.clone();
      const meeting = { ...observation, location: 'meeting' as const, activity: 'meeting' as const };
      const target = new Vector3(...avatarPosition(definition, meeting));
      controller.synchronize([definition], [meeting], rigs, 1);
      controller.advance(1, 0);
      controller.advance(1.4, 0.4);
      expect(rig.root.position.distanceTo(initial)).toBeGreaterThan(0.1);
      expect(rig.root.position.distanceTo(target)).toBeGreaterThan(0.1);
      expect(rig.root.userData.robot_clip).toBe('walk');
      expect(rig.labelPosition(new Vector3()).distanceTo(target)).toBeGreaterThan(1);
      controller.advance(3.3, 0.4);
      expect(rig.root.position.distanceTo(target)).toBeLessThan(1e-6);
      expect(rig.root.rotation.y).toBeCloseTo(workHeading('meeting', 'backend') - ROBOT_MODEL_YAW);
      expect(rig.root.userData.robot_clip).toBe('meeting');
    } finally { rig.dispose(); }
  });

  it('settles a reduced-motion failure into a static pose without a hidden render loop', () => {
    const rig = buildRobotAsset(definition, observation, true);
    try {
      const head = rig.skeleton.bones.find(bone => bone.name === 'head')!;
      const rest = head.quaternion.clone();
      const failed = { ...observation, lifecycle: 'failed' as const };
      const controller = new ActorMotionController();
      controller.synchronize([definition], [failed], rigMap(rig), 0, true);
      expect(controller.advance(0, 0).active).toBe(false);
      expect(head.quaternion.angleTo(rest)).toBeGreaterThan(0.1);
      const pose = head.quaternion.clone();
      expect(controller.advance(20, 1).active).toBe(false);
      expect(head.quaternion.toArray()).toEqual(pose.toArray());
    } finally { rig.dispose(); }
  });

  it('drops an unregistered model without disposing resources owned by its component', () => {
    const rig = buildRobotAsset(definition, observation, true);
    try {
      const controller = new ActorMotionController();
      controller.synchronize([definition], [observation], rigMap(rig), 0);
      controller.advance(0, 0);
      controller.synchronize([definition], [observation], new Map(), 0.3);
      expect(controller.advance(0.4, 0.1).active).toBe(false);
      expect(rig.root.children.length).toBeGreaterThan(0);
    } finally { rig.dispose(); }
  });
});
