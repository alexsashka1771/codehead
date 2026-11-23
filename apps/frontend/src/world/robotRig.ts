import {
  AnimationClip, AnimationMixer, Euler, LoopOnce, LoopRepeat, Quaternion, QuaternionKeyframeTrack,
  VectorKeyframeTrack, type AnimationAction, type Bone, type Group, type Skeleton, type Vector3,
} from 'three';
import type { Role } from '../../../../packages/contracts';

export type RobotClip = 'idle' | 'walk' | 'work' | 'handoff' | 'meeting' | 'blocked' | 'failed';

/** Bone animation never writes the world transform owned by the motion controller. */
export interface AgentRig {
  root: Group;
  skeleton: Skeleton;
  play(clip: RobotClip, loop?: boolean): void;
  update(deltaSeconds: number): boolean;
  stop(): void;
  labelPosition(target: Vector3): Vector3;
  dispose(): void;
}

export const ROBOT_MODEL_YAW = -0.15;

export const ROBOT_JOINTS = [
  'root', 'torso', 'head',
  'leftShoulder', 'leftElbow', 'leftWrist',
  'rightShoulder', 'rightElbow', 'rightWrist',
  'leftHip', 'leftKnee', 'rightHip', 'rightKnee',
] as const;

export type RobotJoint = typeof ROBOT_JOINTS[number];
export type RobotBones = Record<RobotJoint, Bone>;

type ActiveRobotClip = Exclude<RobotClip, 'idle'>;
type Angles = [number, number, number];
type Pose = { rotations: Partial<Record<RobotJoint, Angles>>; lift?: number };

type RigParts = {
  root: Group;
  model: Group;
  bones: RobotBones;
  skeleton: Skeleton;
  role: Role;
  headAnchor: Vector3;
  releaseResources: () => void;
};

const FADE_SECONDS = 0.18;
const loopingClips: ReadonlySet<RobotClip> = new Set(['walk', 'work', 'meeting']);

function walkingPose(phase: number): Pose {
  const stride = Math.sin(phase);
  return {
    lift: (1 - Math.cos(phase * 2)) * 0.012,
    rotations: {
      torso: [0.025, stride * 0.025, stride * 0.015], head: [-0.02, -stride * 0.015, 0],
      leftHip: [-stride * 0.36, 0, 0], rightHip: [stride * 0.36, 0, 0],
      leftKnee: [Math.max(0, stride) * 0.64, 0, 0], rightKnee: [Math.max(0, -stride) * 0.64, 0, 0],
      leftShoulder: [stride * 0.23, 0, -0.025], rightShoulder: [-stride * 0.23, 0, 0.025],
      leftElbow: [-0.08 - Math.max(0, -stride) * 0.10, 0, 0],
      rightElbow: [-0.08 - Math.max(0, stride) * 0.10, 0, 0],
    },
  };
}

function workingPose(role: Role, phase: number): Pose {
  const glance = Math.sin(phase);
  const tap = Math.sin(phase * 3);
  const turn = Math.sin(phase * 2);
  const rotations: Pose['rotations'] = { torso: [0.025, glance * 0.025, 0] };
  switch (role) {
    case 'product_manager':
      Object.assign(rotations, {
        head: [0.16 + glance * 0.025, -0.16, 0],
        leftShoulder: [-0.16, 0.05, 0.16], leftElbow: [-0.23, 0, 0], leftWrist: [0.08, -0.08, 0.04],
        rightShoulder: [-0.86, -0.08, -0.62], rightElbow: [-0.58 + tap * 0.10, 0, -0.32],
        rightWrist: [tap * 0.09, 0, -0.12 + turn * 0.05],
      });
      break;
    case 'architect':
      Object.assign(rotations, {
        head: [0.06, 0.22 + glance * 0.065, 0],
        rightShoulder: [-0.12, -0.05, -0.10], rightElbow: [-0.24, 0, 0], rightWrist: [0, turn * 0.20, 0.05],
        leftShoulder: [-0.82 + turn * 0.05, 0.12, 0.40], leftElbow: [-0.58 + glance * 0.09, 0.06, 0.18],
        leftWrist: [-0.08, 0.08, tap * 0.04],
      });
      break;
    case 'cto':
      Object.assign(rotations, {
        head: [0.12 + glance * 0.04, glance * 0.09, 0],
        leftShoulder: [-0.34, 0, 0.08], leftElbow: [-0.46, 0.10, 0.12],
        rightShoulder: [-0.63 + turn * 0.08, 0.04, -0.16], rightElbow: [-0.48 + glance * 0.08, 0, -0.10],
        rightWrist: [0, glance * 0.13, turn * 0.12],
      });
      break;
    case 'backend':
      Object.assign(rotations, {
        head: [0.19 + glance * 0.025, 0.07, 0],
        rightShoulder: [-0.10, -0.03, -0.08], rightElbow: [-0.18, 0, 0], rightWrist: [0.04, 0, 0],
        leftShoulder: [-0.95, 0.10, 0.48], leftElbow: [-0.62 + tap * 0.13, 0, 0.16],
        leftWrist: [tap * 0.13, turn * 0.025, 0],
      });
      break;
    case 'frontend':
      Object.assign(rotations, {
        head: [0.13, -0.06 + glance * 0.06, 0],
        leftShoulder: [-0.72, 0.04, 0.30], leftElbow: [-0.52 + turn * 0.10, 0, 0.18],
        leftWrist: [0.05, turn * 0.12, -0.12 + tap * 0.07],
        rightShoulder: [-0.66, -0.02, -0.24], rightElbow: [-0.40 + tap * 0.08, 0, -0.13],
        rightWrist: [tap * 0.07, 0, 0],
      });
      break;
    case 'qa':
      Object.assign(rotations, {
        torso: [0.04, glance * 0.055, 0], head: [0.14 + turn * 0.035, glance * 0.22, 0],
        leftShoulder: [-0.23 + turn * 0.045, 0.06, 0.10], leftElbow: [-0.36, 0, 0],
        leftWrist: [0.02, glance * 0.16, 0], rightShoulder: [-0.48, 0.04, -0.10],
        rightElbow: [-0.35 + turn * 0.06, 0, 0], rightWrist: [0, 0.12, glance * 0.06],
      });
      break;
    case 'devops':
      Object.assign(rotations, {
        torso: [0.04, -0.04, 0], head: [0.17, 0.18 + glance * 0.04, 0],
        leftShoulder: [-0.08, 0, 0.04], leftElbow: [-0.14, 0, 0], leftWrist: [0, 0, 0.03],
        rightShoulder: [-0.92, -0.04, -0.15], rightElbow: [-0.59 + turn * 0.06, 0, 0],
        rightWrist: [0.08, turn * 0.42, 0.06],
      });
      break;
  }
  return { rotations };
}

function meetingPose(phase: number): Pose {
  const gesture = Math.sin(phase);
  const nod = (1 - Math.cos(phase * 2)) * 0.055;
  return { rotations: {
    torso: [0, gesture * 0.04, 0], head: [nod, -gesture * 0.12, 0],
    leftShoulder: [-0.18 + gesture * 0.05, 0, -0.06], leftElbow: [-0.20, 0.03, 0],
    rightShoulder: [-0.38 - Math.max(0, gesture) * 0.24, 0, 0.12],
    rightElbow: [-0.32 - Math.max(0, gesture) * 0.14, 0, 0],
    rightWrist: [0, gesture * 0.10, gesture * 0.08],
  } };
}

function finitePose(clip: 'handoff' | 'blocked' | 'failed', role: Role, progress: number): Pose {
  const ease = progress * progress * (3 - 2 * progress);
  let target: Pose;
  if (clip === 'handoff') {
    const left = role === 'product_manager' || role === 'frontend' || role === 'qa';
    const shoulder: RobotJoint = left ? 'leftShoulder' : 'rightShoulder';
    const elbow: RobotJoint = left ? 'leftElbow' : 'rightElbow';
    const wrist: RobotJoint = left ? 'leftWrist' : 'rightWrist';
    target = { rotations: { torso: [0.025, left ? -0.05 : 0.05, 0], head: [0.04, left ? -0.12 : 0.12, 0],
      [shoulder]: [-0.59, 0, left ? 0.10 : -0.10], [elbow]: [-0.64, 0, 0], [wrist]: [0.10, 0, 0] } };
  } else if (clip === 'blocked') {
    target = { rotations: { head: [0.08, -0.13, -0.045], torso: [0, -0.04, 0],
      leftShoulder: [-0.22, 0, -0.22], rightShoulder: [-0.22, 0, 0.22],
      leftElbow: [-0.44, 0, 0], rightElbow: [-0.44, 0, 0],
      leftWrist: [0, -0.35, -0.08], rightWrist: [0, 0.35, 0.08] } };
  } else {
    target = { lift: -0.045, rotations: { torso: [0.085, 0, 0], head: [0.37, 0, -0.025],
      leftShoulder: [0.12, 0, 0.025], rightShoulder: [0.12, 0, -0.025],
      leftElbow: [-0.06, 0, 0], rightElbow: [-0.06, 0, 0],
      leftHip: [-0.06, 0, 0], rightHip: [-0.06, 0, 0], leftKnee: [0.13, 0, 0], rightKnee: [0.13, 0, 0] } };
  }
  const rotations: Pose['rotations'] = {};
  for (const joint of ROBOT_JOINTS) {
    const angles = target.rotations[joint];
    if (angles) rotations[joint] = angles.map(value => value * ease) as Angles;
  }
  return { rotations, lift: (target.lift ?? 0) * ease };
}

function animationClips(role: Role, bones: RobotBones): Record<ActiveRobotClip, AnimationClip> {
  function clip(name: ActiveRobotClip, duration: number, poseAt: (progress: number) => Pose) {
    const samples = 24;
    const times = Array.from({ length: samples + 1 }, (_, index) => duration * index / samples);
    const poses = times.map(time => poseAt(time / duration));
    const tracks = ROBOT_JOINTS.map(joint => new QuaternionKeyframeTrack(`${joint}.quaternion`, times,
      poses.flatMap(pose => new Quaternion().copy(bones[joint].quaternion).multiply(
        new Quaternion().setFromEuler(new Euler(...(pose.rotations[joint] ?? [0, 0, 0]))),
      ).toArray()),
    ));
    const origin = bones.root.position;
    return new AnimationClip(name, duration, [...tracks, new VectorKeyframeTrack('root.position', times,
      poses.flatMap(pose => [origin.x, origin.y + (pose.lift ?? 0), origin.z]))]);
  }
  return {
    walk: clip('walk', 1.12, progress => walkingPose(progress * Math.PI * 2)),
    work: clip('work', 2.8, progress => workingPose(role, progress * Math.PI * 2)),
    meeting: clip('meeting', 3.2, progress => meetingPose(progress * Math.PI * 2)),
    handoff: clip('handoff', 1.15, progress => finitePose('handoff', role, progress)),
    blocked: clip('blocked', 0.85, progress => finitePose('blocked', role, progress)),
    failed: clip('failed', 0.95, progress => finitePose('failed', role, progress)),
  };
}

/** Wrap an owned skeleton in clips. Root translation and heading remain external. */
export function createRobotRig({ root, model, bones, skeleton, role, headAnchor, releaseResources }: RigParts): AgentRig {
  const rest = ROBOT_JOINTS.map(joint => ({ bone: bones[joint], position: bones[joint].position.clone(),
    quaternion: bones[joint].quaternion.clone(), scale: bones[joint].scale.clone() }));
  const mixer = new AnimationMixer(model);
  const clips = animationClips(role, bones);
  let current: AnimationAction | null = null;
  let currentClip: RobotClip = 'idle';
  let repeats = false;
  let retiring: { action: AnimationAction; until: number }[] = [];
  let disposed = false;

  function updateMatrices() { root.updateMatrixWorld(true); skeleton.update(); }

  function stop() {
    if (disposed) return;
    mixer.stopAllAction();
    current = null;
    currentClip = 'idle';
    retiring = [];
    root.userData.robot_clip = 'idle';
    for (const transform of rest) {
      transform.bone.position.copy(transform.position);
      transform.bone.quaternion.copy(transform.quaternion);
      transform.bone.scale.copy(transform.scale);
    }
    updateMatrices();
  }

  return {
    root,
    skeleton,
    play(name, loop) {
      if (disposed) return;
      if (name === 'idle') { stop(); return; }
      const shouldRepeat = loop ?? loopingClips.has(name);
      if (currentClip === name && repeats === shouldRepeat) return;
      if (currentClip === name && current) {
        current.setLoop(shouldRepeat ? LoopRepeat : LoopOnce, shouldRepeat ? Infinity : 1);
        current.clampWhenFinished = !shouldRepeat;
        current.paused = false;
        current.enabled = true;
        repeats = shouldRepeat;
        return;
      }
      retiring.forEach(entry => entry.action.stop());
      retiring = [];
      const next = mixer.clipAction(clips[name]).reset().setEffectiveWeight(1)
        .setLoop(shouldRepeat ? LoopRepeat : LoopOnce, shouldRepeat ? Infinity : 1);
      next.clampWhenFinished = !shouldRepeat;
      next.play();
      if (current) {
        current.crossFadeTo(next, FADE_SECONDS, false);
        retiring.push({ action: current, until: mixer.time + FADE_SECONDS });
      } else next.fadeIn(FADE_SECONDS);
      current = next;
      currentClip = name;
      repeats = shouldRepeat;
      root.userData.robot_clip = name;
    },
    update(deltaSeconds) {
      if (disposed) return false;
      if (current && (current.isRunning() || retiring.length > 0)) {
        mixer.update(Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0);
        retiring = retiring.filter(entry => {
          if (mixer.time < entry.until) return true;
          entry.action.stop();
          return false;
        });
      }
      updateMatrices();
      return !!current?.isRunning() || retiring.length > 0;
    },
    stop,
    labelPosition(target) {
      root.updateMatrixWorld(true);
      return bones.head.localToWorld(target.copy(headAnchor));
    },
    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
      mixer.uncacheRoot(model);
      releaseResources();
      model.clear();
      root.clear();
    },
  };
}
