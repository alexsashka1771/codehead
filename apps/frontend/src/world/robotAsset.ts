import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  Bone, BoxGeometry, BufferGeometry, Color, CylinderGeometry, Euler, Float32BufferAttribute, Group,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, RingGeometry, Skeleton, SkinnedMesh,
  SphereGeometry, TorusGeometry, Uint16BufferAttribute, Vector3, type MeshStandardMaterialParameters,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { roleDetails } from '../features/roles';
import { AgentBot } from './AgentBot';
import { resolveAppearance, type ProceduralVariant } from './appearance';
import { avatarPosition } from './layout';
import { createRobotRig, ROBOT_JOINTS, type AgentRig, type RobotBones, type RobotJoint } from './robotRig';

export interface RobotVisualState {
  night?: boolean;
  selected?: boolean;
  agent?: AgentView;
  definition?: RoleDefinition;
}

export interface RobotAsset extends AgentRig {
  /** Theme and selection update existing resources; appearance and role changes require a new asset. */
  setVisualState(state: RobotVisualState): void;
}

type Point3 = [number, number, number];
type RecipeProps = {
  children?: ReactNode;
  args?: number[];
  name?: string;
  position?: Point3;
  rotation?: Point3;
  scale?: number | Point3;
  castShadow?: boolean;
  receiveShadow?: boolean;
} & MeshStandardMaterialParameters;

type MaterialSpec = {
  color: string;
  emissive: string;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
  transparent: boolean;
  opacity: number;
};

type RecipePart = {
  type: string;
  args: number[];
  matrix: Matrix4;
  names: string[];
  material: MaterialSpec;
  castShadow: boolean;
  receiveShadow: boolean;
};

type PreparedPart = {
  geometry: BufferGeometry;
  joint: RobotJoint;
  day: MaterialSpec;
  night: MaterialSpec;
  castShadow: boolean;
  receiveShadow: boolean;
};

type MaterialBinding = { material: MeshStandardMaterial; day: MaterialSpec; night: MaterialSpec };

function transform(props: RecipeProps) {
  return new Matrix4().compose(new Vector3(...(props.position ?? [0, 0, 0])),
    new Quaternion().setFromEuler(new Euler(...(props.rotation ?? [0, 0, 0]))),
    typeof props.scale === 'number' ? new Vector3().setScalar(props.scale) : new Vector3(...(props.scale ?? [1, 1, 1])));
}

function materialSpec(props: RecipeProps): MaterialSpec {
  return {
    color: `#${new Color(props.color ?? '#ffffff').getHexString()}`,
    emissive: `#${new Color(props.emissive ?? '#000000').getHexString()}`,
    emissiveIntensity: props.emissiveIntensity ?? 1,
    roughness: props.roughness ?? 1,
    metalness: props.metalness ?? 0,
    transparent: props.transparent ?? false,
    opacity: props.opacity ?? 1,
  };
}

/** Expand the authoritative pure robot recipe; no React renderer or WebGL is involved. */
function recipe(definition: RoleDefinition, agent: AgentView | undefined, night: boolean) {
  const outer = AgentBot({ definition, agent, night, selected: false, onSelect: () => {} });
  if (!isValidElement<RecipeProps>(outer)) throw new Error('Expected the authoritative robot group.');
  const children = Array.isArray(outer.props.children) ? outer.props.children : [outer.props.children];
  const model = children.find(child => isValidElement<RecipeProps>(child) && child.type === 'group') as ReactElement<RecipeProps> | undefined;
  if (!model) throw new Error('The authoritative robot recipe has no model group.');
  const parts: RecipePart[] = [];
  function collect(node: ReactNode, parent = new Matrix4(), names: string[] = []) {
    if (Array.isArray(node)) { node.forEach(child => collect(child, parent, names)); return; }
    if (!isValidElement<RecipeProps>(node)) return;
    if (typeof node.type === 'function') {
      collect((node.type as (props: RecipeProps) => ReactNode)(node.props), parent, names);
      return;
    }
    const props = node.props;
    const nextNames = props.name ? [...names, props.name] : names;
    const matrix = node.type === 'group' || node.type === 'mesh' ? parent.clone().multiply(transform(props)) : parent;
    if (node.type === 'mesh') {
      const meshChildren = (Array.isArray(props.children) ? props.children : [props.children]).filter(isValidElement<RecipeProps>);
      const geometry = meshChildren.find(child => typeof child.type === 'string' && child.type.endsWith('Geometry'));
      const material = meshChildren.find(child => child.type === 'meshStandardMaterial');
      if (!geometry || !material) throw new Error('The robot recipe contains an unsupported mesh.');
      parts.push({ type: String(geometry.type), args: geometry.props.args ?? [], matrix, names: nextNames,
        material: materialSpec(material.props), castShadow: props.castShadow ?? false, receiveShadow: props.receiveShadow ?? false });
    } else collect(props.children, matrix, nextNames);
  }
  collect(model.props.children);
  return { model: model.props, parts };
}

function geometryFor(part: RecipePart): BufferGeometry {
  switch (part.type) {
    case 'boxGeometry': return new BoxGeometry(...part.args as ConstructorParameters<typeof BoxGeometry>);
    case 'roundedBoxGeometry': return new RoundedBoxGeometry(...part.args as ConstructorParameters<typeof RoundedBoxGeometry>);
    case 'cylinderGeometry': return new CylinderGeometry(...part.args as ConstructorParameters<typeof CylinderGeometry>);
    case 'sphereGeometry': return new SphereGeometry(...part.args as ConstructorParameters<typeof SphereGeometry>);
    case 'torusGeometry': return new TorusGeometry(...part.args as ConstructorParameters<typeof TorusGeometry>);
    default: throw new Error(`Unsupported robot geometry: ${part.type}`);
  }
}

function attachment(part: RecipePart, variant: ProceduralVariant): RobotJoint {
  // Explicit segment labels keep rounded limb hulls and both hands on their own physical joint.
  for (let index = part.names.length - 1; index >= 0; index--) {
    const joint = ROBOT_JOINTS.find(candidate => part.names[index] === `joint-${candidate}`);
    if (joint) return joint;
  }
  const at = new Vector3().setFromMatrixPosition(part.matrix);
  const left = at.x < 0;
  const shoulder: RobotJoint = left ? 'leftShoulder' : 'rightShoulder';
  const elbow: RobotJoint = left ? 'leftElbow' : 'rightElbow';
  const wrist: RobotJoint = left ? 'leftWrist' : 'rightWrist';
  if (part.names.includes('leg')) return at.y >= 0.56 ? left ? 'leftHip' : 'rightHip' : left ? 'leftKnee' : 'rightKnee';
  if (part.names.includes('arm')) return at.y > 0.93 ? shoulder : elbow;
  if (part.names.includes('robot-head') || part.names.includes('optic-head')) return 'head';
  switch (variant) {
    case 'clipboard':
      if (part.names.includes('clipboard-and-headset')) return at.y > 1.4 ? 'head' : 'leftWrist';
      break;
    case 'projector':
      if (part.names.includes('visor-and-projector')) {
        if (at.y > 1.8) return 'head';
        return at.x < 0 ? 'leftShoulder' : 'rightWrist';
      }
      break;
    case 'lead':
      if (part.names.includes('lead-jacket') && Math.abs(at.x) > 0.3) return shoulder;
      break;
    case 'terminal':
      if (part.names.includes('terminal-and-heatsink') && at.x > 0.3) return 'rightWrist';
      break;
    case 'interface':
      if (part.names.includes('interface-display') && at.x < -0.4) return 'leftWrist';
      break;
    case 'optic':
      if (part.names.includes('inspection-optic')) {
        if (at.x < -0.4) return 'leftWrist';
        if (at.x > 0.4) return 'rightShoulder';
      }
      break;
    case 'tools':
      if (part.names.includes('helmet-and-tools')) {
        if (at.y > 1.75) return 'head';
        if (Math.abs(at.x) > 0.4 && at.z > 0) return wrist;
      }
      break;
    case 'generic': break;
  }
  return at.y < 0.8 ? 'root' : 'torso';
}

function prepareParts(day: RecipePart[], night: RecipePart[], variant: ProceduralVariant): PreparedPart[] {
  return day.map((part, index) => ({
    day: part.material, night: night[index].material,
    castShadow: part.castShadow, receiveShadow: part.receiveShadow,
    joint: attachment(part, variant), geometry: geometryFor(part).applyMatrix4(part.matrix),
  }));
}

function robotBones(variant: ProceduralVariant): RobotBones {
  const wide = variant === 'lead' || variant === 'terminal' || variant === 'tools';
  const bodyWidth = wide ? 0.77 : variant === 'projector' ? 0.58 : 0.65;
  const bones = Object.fromEntries(ROBOT_JOINTS.map(joint => {
    const bone = new Bone();
    bone.name = joint;
    return [joint, bone];
  })) as RobotBones;
  bones.root.position.set(0, 0.67, 0);
  bones.root.add(bones.torso, bones.leftHip, bones.rightHip);
  bones.torso.position.set(0, 0.39, 0);
  bones.torso.add(bones.head, bones.leftShoulder, bones.rightShoulder);
  bones.head.position.set(0, 0.38, 0);
  for (const side of [-1, 1]) {
    const left = side < 0;
    const shoulder = left ? bones.leftShoulder : bones.rightShoulder;
    const elbow = left ? bones.leftElbow : bones.rightElbow;
    const wrist = left ? bones.leftWrist : bones.rightWrist;
    const hip = left ? bones.leftHip : bones.rightHip;
    const knee = left ? bones.leftKnee : bones.rightKnee;
    const armRotation = new Quaternion().setFromEuler(new Euler(0, 0, side * -0.055));
    shoulder.position.copy(new Vector3(side * (bodyWidth / 2 + 0.055), 1.29, 0).applyQuaternion(armRotation))
      .sub(new Vector3(0, 1.06, 0));
    shoulder.quaternion.copy(armRotation);
    shoulder.add(elbow);
    elbow.position.set(side * 0.075, -0.44, 0.07);
    elbow.add(wrist);
    wrist.position.set(0, -0.18, 0.05);
    hip.position.set(side * 0.19, -0.07, 0);
    hip.add(knee);
    knee.position.set(0, -0.22, 0);
  }
  return bones;
}

function mergeParts(parts: PreparedPart[], night: boolean, bindings: MaterialBinding[]) {
  const batches = new Map<string, { castShadow: boolean; receiveShadow: boolean; groups: Map<string, PreparedPart[]> }>();
  for (const part of parts) {
    const shadowKey = `${part.castShadow}|${part.receiveShadow}`;
    let batch = batches.get(shadowKey);
    if (!batch) {
      batch = { castShadow: part.castShadow, receiveShadow: part.receiveShadow, groups: new Map() };
      batches.set(shadowKey, batch);
    }
    // Both themes determine batching so switching the palette never rebuilds geometry.
    const key = JSON.stringify([part.day, part.night]);
    const group = batch.groups.get(key) ?? [];
    group.push(part);
    batch.groups.set(key, group);
  }
  return [...batches.values()].map((batch, batchIndex) => {
    const geometry = new BufferGeometry();
    const positions: number[] = [];
    const normals: number[] = [];
    const uv: number[] = [];
    const skinIndices: number[] = [];
    const skinWeights: number[] = [];
    const materials: MeshStandardMaterial[] = [];
    for (const group of batch.groups.values()) {
      const first = group[0];
      const material = new MeshStandardMaterial(night ? first.night : first.day);
      bindings.push({ material, day: first.day, night: first.night });
      const start = positions.length / 3;
      for (const part of group) {
        const triangles = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
        const position = triangles.getAttribute('position');
        const normal = triangles.getAttribute('normal');
        const texture = triangles.getAttribute('uv');
        const boneIndex = ROBOT_JOINTS.indexOf(part.joint);
        for (let index = 0; index < position.count; index += 1) {
          positions.push(position.getX(index), position.getY(index), position.getZ(index));
          normals.push(normal.getX(index), normal.getY(index), normal.getZ(index));
          uv.push(texture.getX(index), texture.getY(index));
          skinIndices.push(boneIndex, 0, 0, 0);
          skinWeights.push(1, 0, 0, 0);
        }
        if (triangles !== part.geometry) triangles.dispose();
        part.geometry.dispose();
      }
      geometry.addGroup(start, positions.length / 3 - start, materials.length);
      materials.push(material);
    }
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));
    geometry.computeBoundingSphere();
    const mesh = new SkinnedMesh(geometry, materials);
    mesh.name = `robot-surfaces-${batchIndex}`;
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = batch.receiveShadow;
    // A conservative volume covers all clips without a per-frame CPU vertex scan.
    mesh.boundingSphere = geometry.boundingSphere!.clone();
    mesh.boundingSphere.radius *= 1.8;
    return mesh;
  });
}

function applyMaterial(binding: MaterialBinding, night: boolean) {
  const spec = night ? binding.night : binding.day;
  binding.material.color.set(spec.color);
  binding.material.emissive.set(spec.emissive);
  binding.material.emissiveIntensity = spec.emissiveIntensity;
  binding.material.roughness = spec.roughness;
  binding.material.metalness = spec.metalness;
  binding.material.opacity = spec.opacity;
  binding.material.transparent = spec.transparent;
}

/** Build the seven authoritative robot recipes into owned, genuinely skinned 3D meshes. */
export function buildRobotAsset(definition: RoleDefinition, agent?: AgentView, night = false): RobotAsset {
  const role = definition.role;
  const resolution = resolveAppearance(agent?.appearance_id ?? definition.appearance_id, definition.appearance_id);
  const dayRecipe = recipe(definition, agent, false);
  const nightRecipe = recipe(definition, agent, true);
  const parts = prepareParts(dayRecipe.parts, nightRecipe.parts, resolution.appearance.variant);
  const root = new Group();
  root.name = resolution.appearance.id;
  root.position.fromArray(avatarPosition(definition, agent));
  const model = new Group();
  model.name = dayRecipe.model.name ?? `robot-${resolution.appearance.variant}`;
  model.matrix.copy(transform(dayRecipe.model));
  model.matrix.decompose(model.position, model.quaternion, model.scale);
  const bones = robotBones(resolution.appearance.variant);
  model.add(bones.root);
  const headAnchor = new Vector3(0, 0.60, 0);
  let highest = -Infinity;
  for (const part of parts) {
    if (part.joint !== 'head') continue;
    part.geometry.computeBoundingBox();
    const bounds = part.geometry.boundingBox!;
    if (bounds.max.y > highest) {
      highest = bounds.max.y;
      bounds.getCenter(headAnchor);
      headAnchor.y = highest + 0.12 - 1.44;
    }
  }
  const bindings: MaterialBinding[] = [];
  const meshes = mergeParts(parts, night, bindings);
  model.add(...meshes);
  root.add(model);
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(ROBOT_JOINTS.map(joint => bones[joint]));
  meshes.forEach(mesh => mesh.bind(skeleton));
  const selection = new Mesh(new RingGeometry(0.63, 0.7, 32),
    new MeshBasicMaterial({ color: roleDetails[role].color, transparent: true, opacity: 0.9 }));
  selection.name = 'selection-ring';
  selection.position.y = 0.018;
  selection.rotation.x = -Math.PI / 2;
  selection.visible = false;
  root.add(selection);
  const rig = createRobotRig({ root, model, bones, skeleton, role, headAnchor,
    releaseResources() {
      meshes.forEach(mesh => mesh.geometry.dispose());
      bindings.forEach(binding => binding.material.dispose());
      selection.geometry.dispose();
      selection.material.dispose();
      skeleton.dispose();
    },
  });
  let currentDefinition = definition;
  let currentAgent = agent;
  let currentNight = night;
  const asset: RobotAsset = {
    ...rig,
    setVisualState(state) {
      const nextDefinition = state.definition ?? currentDefinition;
      const nextAgent = 'agent' in state ? state.agent : currentAgent;
      const appearance = resolveAppearance(nextAgent?.appearance_id ?? nextDefinition.appearance_id, nextDefinition.appearance_id);
      if (appearance.appearance.id !== resolution.appearance.id) throw new Error('An appearance change requires a new robot asset.');
      if (nextDefinition.role !== role) throw new Error('A role change requires a new robot asset.');
      currentDefinition = nextDefinition;
      currentAgent = nextAgent;
      if (state.night !== undefined && state.night !== currentNight) {
        currentNight = state.night;
        bindings.forEach(binding => applyMaterial(binding, currentNight));
      }
      if (state.selected !== undefined) selection.visible = state.selected;
      Object.assign(root.userData, { role: currentDefinition.role, appearance_id: appearance.requestedId,
        requested_appearance_id: appearance.requestedId, resolved_appearance_id: appearance.appearance.id,
        appearance_source: appearance.source, lifecycle: currentAgent?.lifecycle ?? 'offline', activity: currentAgent?.activity ?? null });
    },
  };
  asset.setVisualState({ definition, agent, night, selected: false });
  return asset;
}
