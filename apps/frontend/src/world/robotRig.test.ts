import { isValidElement, type ReactNode } from 'react';
import {
  Bone, Box3, BoxGeometry, BufferGeometry, CylinderGeometry, Euler, Group, Matrix4, Mesh,
  MeshStandardMaterial, Quaternion, Skeleton, SkinnedMesh, SphereGeometry, TorusGeometry, Vector3,
  type Material, type MeshStandardMaterialParameters,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { describe, expect, it } from 'vitest';
import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import { AgentBot } from './AgentBot';
import { avatarPosition, ROBOT_SCALE } from './layout';
import { buildRobotAsset, type RobotAsset } from './robotAsset';
import { ROBOT_JOINTS, ROBOT_MODEL_YAW } from './robotRig';

type RecipeProps = {
  children?: ReactNode;
  args?: number[];
  name?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
  castShadow?: boolean;
  receiveShadow?: boolean;
} & MeshStandardMaterialParameters;

type RecipeMesh = { mesh: Mesh<BufferGeometry, MeshStandardMaterial>; names: string[] };
const materialKeys = ['color', 'emissive', 'emissiveIntensity', 'roughness', 'metalness', 'transparent', 'opacity'] as const;

function localMatrix(props: RecipeProps, skipPosition = false) {
  return new Matrix4().compose(
    new Vector3(...(skipPosition ? [0, 0, 0] as const : props.position ?? [0, 0, 0])),
    new Quaternion().setFromEuler(new Euler(...(props.rotation ?? [0, 0, 0]))),
    typeof props.scale === 'number' ? new Vector3().setScalar(props.scale) : new Vector3(...(props.scale ?? [1, 1, 1])),
  );
}

function recipeParts(definition: RoleDefinition, night: boolean): RecipeMesh[] {
  const parts: RecipeMesh[] = [];
  function collect(node: ReactNode, parent = new Matrix4(), names: string[] = [], outer = false): void {
    if (Array.isArray(node)) { node.forEach(child => collect(child, parent, names)); return; }
    if (!isValidElement<RecipeProps>(node)) return;
    if (typeof node.type === 'function') {
      collect((node.type as (props: RecipeProps) => ReactNode)(node.props), parent, names, outer);
      return;
    }
    const props = node.props;
    const nextNames = props.name ? [...names, props.name] : names;
    const matrix = node.type === 'group' || node.type === 'mesh'
      ? parent.clone().multiply(localMatrix(props, outer)) : parent;
    if (node.type === 'mesh') {
      const children = (Array.isArray(props.children) ? props.children : [props.children]).filter(isValidElement<RecipeProps>);
      const shape = children.find(child => typeof child.type === 'string' && child.type.endsWith('Geometry'));
      const surface = children.find(child => child.type === 'meshStandardMaterial');
      if (!shape || !surface) throw new Error('Authoritative robot contains an unsupported mesh.');
      const args = shape.props.args ?? [];
      let geometry: BufferGeometry;
      switch (shape.type) {
        case 'boxGeometry': geometry = new BoxGeometry(...args as ConstructorParameters<typeof BoxGeometry>); break;
        case 'roundedBoxGeometry': geometry = new RoundedBoxGeometry(...args as ConstructorParameters<typeof RoundedBoxGeometry>); break;
        case 'cylinderGeometry': geometry = new CylinderGeometry(...args as ConstructorParameters<typeof CylinderGeometry>); break;
        case 'sphereGeometry': geometry = new SphereGeometry(...args as ConstructorParameters<typeof SphereGeometry>); break;
        case 'torusGeometry': geometry = new TorusGeometry(...args as ConstructorParameters<typeof TorusGeometry>); break;
        default: throw new Error(`Unsupported authoritative geometry: ${String(shape.type)}`);
      }
      const params = Object.fromEntries(materialKeys.filter(key => surface.props[key] !== undefined).map(key => [key, surface.props[key]]));
      const mesh = new Mesh(geometry, new MeshStandardMaterial(params));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.matrixWorld.copy(matrix);
      mesh.castShadow = props.castShadow ?? false;
      mesh.receiveShadow = props.receiveShadow ?? false;
      parts.push({ mesh, names: nextNames });
    } else collect(props.children, matrix, nextNames);
  }
  collect(AgentBot({ definition, night, selected: false, onSelect: () => {} }), new Matrix4(), [], true);
  return parts;
}

function surfaceKey(material: MeshStandardMaterial, mesh: Mesh) {
  return [material.color.getHexString(), material.emissive.getHexString(), material.emissiveIntensity,
    material.roughness, material.metalness, material.opacity, material.transparent, mesh.castShadow, mesh.receiveShadow].join('|');
}

function vertexKey(vertex: Vector3) { return vertex.toArray().map(value => Math.round(value * 10000) / 10000).join(','); }

function skinnedMeshes(asset: RobotAsset): SkinnedMesh<BufferGeometry, MeshStandardMaterial | MeshStandardMaterial[]>[] {
  const meshes: SkinnedMesh<BufferGeometry, MeshStandardMaterial | MeshStandardMaterial[]>[] = [];
  asset.root.traverse(node => { if (node instanceof SkinnedMesh) meshes.push(node); });
  return meshes;
}

function nativeVertices(asset: RobotAsset) {
  asset.root.updateMatrixWorld(true);
  asset.skeleton.update();
  const records: { vertex: Vector3; surface: string; bone: string }[] = [];
  for (const mesh of skinnedMeshes(asset)) {
    const position = mesh.geometry.getAttribute('position');
    const skins = mesh.geometry.getAttribute('skinIndex');
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const group of mesh.geometry.groups) {
      const material = materials[group.materialIndex ?? 0];
      const key = surfaceKey(material, mesh);
      for (let offset = group.start; offset < group.start + group.count; offset += 1) {
        const index = mesh.geometry.index?.getX(offset) ?? offset;
        records.push({
          vertex: mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld).sub(asset.root.position),
          surface: key,
          bone: asset.skeleton.bones[skins.getX(index)]?.name ?? '',
        });
      }
    }
  }
  return records;
}

function expectedVertices(parts: RecipeMesh[]) {
  return parts.flatMap(({ mesh }) => {
    const position = mesh.geometry.getAttribute('position');
    const surface = surfaceKey(mesh.material, mesh);
    return Array.from({ length: position.count }, (_, index) => ({
      vertex: new Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld), surface,
    }));
  });
}

function releaseRecipe(parts: RecipeMesh[]) { parts.forEach(({ mesh }) => { mesh.geometry.dispose(); mesh.material.dispose(); }); }
function bonePose(asset: RobotAsset) { return asset.skeleton.bones.flatMap(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()]); }

function agentFor(definition: RoleDefinition, overrides: Partial<AgentView> = {}): AgentView {
  return { id: `agent-${definition.role}`, run_id: 'rig-test', role: definition.role,
    appearance_id: definition.appearance_id, instructions_version: '1', lifecycle: 'offline', activity: null,
    location: definition.location, current_task_id: null, ...overrides };
}

describe('native articulated robot assets', () => {
  it.each(fallbackRoles)('builds an actual weighted 3D skeleton for $role', definition => {
    const asset = buildRobotAsset(definition);
    expect(asset.root).toBeInstanceOf(Group);
    expect(asset.skeleton).toBeInstanceOf(Skeleton);
    expect(asset.skeleton.bones.map(bone => bone.name)).toEqual([...ROBOT_JOINTS]);
    expect(asset.skeleton.bones.every(bone => bone instanceof Bone)).toBe(true);
    expect(skinnedMeshes(asset).length).toBeGreaterThan(0);
    for (const mesh of skinnedMeshes(asset)) {
      expect(mesh.skeleton).toBe(asset.skeleton);
      const weights = mesh.geometry.getAttribute('skinWeight');
      const indices = mesh.geometry.getAttribute('skinIndex');
      expect(weights.count).toBe(mesh.geometry.getAttribute('position').count);
      for (let index = 0; index < weights.count; index += 1) {
        expect(weights.getX(index) + weights.getY(index) + weights.getZ(index) + weights.getW(index)).toBeCloseTo(1);
        expect(weights.getX(index)).toBe(1);
        expect(indices.getX(index)).toBeLessThan(asset.skeleton.bones.length);
      }
    }
    expect(asset.root.position.toArray()).toEqual(avatarPosition(definition));
    const model = asset.root.children.find(child => child.name.startsWith('robot-'));
    expect(model?.scale.toArray()).toEqual([ROBOT_SCALE, ROBOT_SCALE, ROBOT_SCALE]);
    expect(model?.rotation.y).toBe(ROBOT_MODEL_YAW);
    asset.dispose();
  });

  it.each(fallbackRoles)('matches every authoritative rounded surface and REST vertex of $role in both themes', definition => {
    for (const night of [false, true]) {
      const authoritative = recipeParts(definition, night);
      const asset = buildRobotAsset(definition, undefined, night);
      const expected = expectedVertices(authoritative);
      const actual = nativeVertices(asset);
      const actualSet = new Set(actual.map(record => `${record.surface}:${vertexKey(record.vertex)}`));
      for (const record of expected) {
        const matching = actualSet.has(`${record.surface}:${vertexKey(record.vertex)}`);
        const nearest = matching ? 0 : Math.min(...actual.filter(item => item.surface === record.surface)
          .map(item => item.vertex.distanceTo(record.vertex)));
        expect(nearest, JSON.stringify({ role: definition.role, night, surface: record.surface, vertex: record.vertex.toArray() })).toBeLessThan(0.00001);
      }
      expect(new Set(actual.map(record => record.surface))).toEqual(new Set(expected.map(record => record.surface)));
      const exterior = new Set(expected.map(record => vertexKey(record.vertex)));
      for (const record of actual) {
        if (!exterior.has(vertexKey(record.vertex))) expect(expected.some(point => point.vertex.distanceTo(record.vertex) < 0.00001)).toBe(true);
      }
      const actualBounds = new Box3().setFromPoints(actual.map(record => record.vertex));
      const expectedBounds = new Box3().setFromPoints(expected.map(record => record.vertex));
      expect(actualBounds.min.distanceTo(expectedBounds.min)).toBeLessThan(0.00001);
      expect(actualBounds.max.distanceTo(expectedBounds.max)).toBeLessThan(0.00001);
      const drawCalls = skinnedMeshes(asset).reduce((sum, mesh) => sum + mesh.geometry.groups.length, 0);
      expect(drawCalls).toBeLessThan(authoritative.length * 0.75);
      releaseRecipe(authoritative);
      asset.dispose();
    }
  });

  it('keeps aliases, snapshot precedence, unknown fallbacks and domain placement independent', () => {
    const definition = Object.freeze({ ...fallbackRoles[0], appearance_id: 'qa_v1' });
    const snapshot = Object.freeze(agentFor(definition, { appearance_id: 'missing-robot-v8', location: 'meeting' }));
    const asset = buildRobotAsset(definition, snapshot);
    expect(asset.root.userData).toMatchObject({ role: definition.role, requested_appearance_id: snapshot.appearance_id,
      resolved_appearance_id: 'qa_v1', appearance_source: 'definition-fallback' });
    expect(asset.root.position.toArray()).toEqual(avatarPosition(definition, snapshot));
    const canonical = buildRobotAsset({ ...definition, appearance_id: 'qa_v1' });
    const alias = buildRobotAsset({ ...definition, appearance_id: 'qa-v1' });
    expect(nativeVertices(alias).map(record => [record.surface, vertexKey(record.vertex)]))
      .toEqual(nativeVertices(canonical).map(record => [record.surface, vertexKey(record.vertex)]));
    const precedence = buildRobotAsset(definition, agentFor(definition, { appearance_id: 'backend_v1' }));
    expect(precedence.root.userData.resolved_appearance_id).toBe('backend_v1');
    expect(precedence.root.userData.role).toBe('product_manager');
    const generic = buildRobotAsset({ ...definition, appearance_id: 'unknown-default' }, snapshot);
    expect(generic.root.userData).toMatchObject({ resolved_appearance_id: 'generic_procedural_v1', appearance_source: 'generic-fallback' });
    expect(skinnedMeshes(generic).length).toBeGreaterThan(0);
    expect(snapshot.location).toBe('meeting');
    expect(definition.appearance_id).toBe('qa_v1');
    [asset, canonical, alias, precedence, generic].forEach(item => item.dispose());
  });

  it.each(['walk', 'work'] as const)('moves bones and actual 3D vertices during %s without moving the world root', clip => {
    const asset = buildRobotAsset(fallbackRoles[0]);
    const rest = bonePose(asset);
    const restVertices = nativeVertices(asset).map(record => record.vertex.clone());
    const position = asset.root.position.clone();
    const rotation = asset.root.quaternion.clone();
    asset.play(clip);
    expect(asset.update(0.27)).toBe(true);
    expect(bonePose(asset)).not.toEqual(rest);
    const moved = nativeVertices(asset);
    expect(moved.some((record, index) => record.vertex.distanceTo(restVertices[index]) > 0.04)).toBe(true);
    expect(asset.root.position).toEqual(position);
    expect(asset.root.quaternion.toArray()).toEqual(rotation.toArray());
    if (clip === 'walk') {
      const leftHip = asset.skeleton.getBoneByName('leftHip')!;
      const rightHip = asset.skeleton.getBoneByName('rightHip')!;
      expect(leftHip.rotation.x * rightHip.rotation.x).toBeLessThan(0);
      expect(Math.max(asset.skeleton.getBoneByName('leftKnee')!.rotation.x, asset.skeleton.getBoneByName('rightKnee')!.rotation.x)).toBeGreaterThan(0.1);
    }
    asset.stop();
    expect(bonePose(asset)).toEqual(rest);
    expect(asset.update(1)).toBe(false);
    expect(nativeVertices(asset).every((record, index) => record.vertex.distanceTo(restVertices[index]) < 0.00001)).toBe(true);
    asset.dispose();
  });

  it('gives all seven roles distinct working gestures', () => {
    const poses = fallbackRoles.map(definition => {
      const asset = buildRobotAsset(definition);
      asset.play('work');
      asset.update(0.61);
      const pose = asset.skeleton.bones.filter(bone => !['root', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee'].includes(bone.name))
        .flatMap(bone => bone.quaternion.toArray().map(value => value.toFixed(3))).join(',');
      asset.dispose();
      return pose;
    });
    expect(new Set(poses).size).toBe(7);
  });

  it.each([
    ['product_manager', 'bb8b5e', 'leftWrist'],
    ['architect', '52c8ff', 'rightWrist'],
    ['backend', '173242', 'rightWrist'],
    ['frontend', 'ffaf75', 'leftWrist'],
    ['qa', '4a6575', 'leftWrist'],
    ['devops', '87aabb', 'leftWrist'],
  ] as const)('attaches the handheld accessory of %s to %s through %s', (role, color, joint) => {
    const definition = fallbackRoles.find(item => item.role === role)!;
    const asset = buildRobotAsset(definition, undefined, true);
    const vertices = nativeVertices(asset).filter(record => record.surface.startsWith(`${color}|`) && record.bone === joint);
    expect(vertices.length).toBeGreaterThan(0);
    asset.dispose();
  });

  it.each(['handoff', 'blocked', 'failed'] as const)('settles finite %s animation and holds the last pose', clip => {
    const asset = buildRobotAsset(fallbackRoles[0]);
    const rest = bonePose(asset);
    asset.play(clip);
    expect(asset.update(0.2)).toBe(true);
    expect(asset.update(4)).toBe(false);
    const final = bonePose(asset);
    expect(final).not.toEqual(rest);
    expect(asset.update(1)).toBe(false);
    expect(bonePose(asset)).toEqual(final);
    asset.stop();
    expect(bonePose(asset)).toEqual(rest);
    asset.dispose();
  });

  it('keeps unconnected, offline and idle robots still until an explicit clip is played', () => {
    const definition = fallbackRoles[0];
    for (const agent of [undefined, agentFor(definition), agentFor(definition, { lifecycle: 'busy', activity: 'coding' })]) {
      const asset = buildRobotAsset(definition, agent);
      const rest = bonePose(asset);
      expect(asset.update(3)).toBe(false);
      expect(bonePose(asset)).toEqual(rest);
      asset.play('idle');
      expect(asset.update(3)).toBe(false);
      expect(bonePose(asset)).toEqual(rest);
      asset.dispose();
    }
  });

  it('keeps playback continuous when the same looping clip is requested again', () => {
    const actual = buildRobotAsset(fallbackRoles[0]);
    const expected = buildRobotAsset(fallbackRoles[0]);
    for (const asset of [actual, expected]) { asset.play('walk'); asset.update(0.25); }
    actual.play('walk');
    actual.update(0.11);
    expected.update(0.11);
    expect(bonePose(actual)).toEqual(bonePose(expected));
    actual.dispose();
    expected.dispose();
  });

  it('can change the loop mode of a playing clip without stopping its own action', () => {
    const asset = buildRobotAsset(fallbackRoles[0]);
    asset.play('walk', true);
    asset.update(0.25);
    asset.play('walk', false);
    expect(asset.update(0.3)).toBe(true);
    expect(asset.update(2)).toBe(false);
    asset.dispose();
  });

  it('blends between clips and restores metal parts correctly after world translation and yaw', () => {
    const asset = buildRobotAsset(fallbackRoles[2]);
    const rest = nativeVertices(asset).map(record => record.vertex.clone());
    asset.root.position.set(2, 0.5, -1);
    asset.root.rotation.y = 1.1;
    asset.play('walk');
    asset.update(0.27);
    const before = bonePose(asset);
    asset.play('work');
    expect(bonePose(asset)).toEqual(before);
    expect(asset.update(0.001)).toBe(true);
    const blended = bonePose(asset);
    expect(Math.max(...blended.map((value, index) => Math.abs(value - before[index])))).toBeLessThan(0.015);
    expect(asset.update(0.3)).toBe(true);
    expect(asset.skeleton.getBoneByName('leftHip')!.rotation.x).toBeCloseTo(0);
    asset.stop();
    const final = nativeVertices(asset);
    const rotation = asset.root.quaternion;
    expect(final.every((record, index) => record.vertex.distanceTo(rest[index].clone().applyQuaternion(rotation)) < 0.00001)).toBe(true);
    expect(asset.root.position.toArray()).toEqual([2, 0.5, -1]);
    expect(asset.root.rotation.y).toBeCloseTo(1.1);
    asset.dispose();
  });

  it('changes theme, selection and resource metadata without rebuilding the skeleton or resetting motion', () => {
    const definition = fallbackRoles[0];
    const asset = buildRobotAsset(definition, undefined, false);
    const geometry = skinnedMeshes(asset).map(mesh => mesh.geometry);
    const skeleton = asset.skeleton;
    asset.play('work');
    asset.update(0.3);
    const pose = bonePose(asset);
    asset.root.position.set(10, 0.16, -4);
    asset.root.rotation.y = 0.8;
    asset.setVisualState({ night: true, selected: true, agent: agentFor(definition, { appearance_id: 'product_manager_v1' }) });
    expect(asset.skeleton).toBe(skeleton);
    expect(skinnedMeshes(asset).map(mesh => mesh.geometry)).toEqual(geometry);
    expect(bonePose(asset)).toEqual(pose);
    expect(asset.root.position.toArray()).toEqual([10, 0.16, -4]);
    expect(asset.root.rotation.y).toBeCloseTo(0.8);
    expect(asset.root.getObjectByName('selection-ring')?.visible).toBe(true);
    expect(asset.root.userData.requested_appearance_id).toBe('product_manager_v1');
    asset.stop();
    const reference = buildRobotAsset(definition, undefined, true);
    const colors = skinnedMeshes(asset).flatMap(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material.color.getHexString()));
    const expectedColors = skinnedMeshes(reference).flatMap(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material.color.getHexString()));
    expect(colors).toEqual(expectedColors);
    asset.setVisualState({ selected: false });
    expect(asset.root.getObjectByName('selection-ring')?.visible).toBe(false);
    expect(asset.update(0.1)).toBe(false);
    asset.dispose();
    reference.dispose();
  });

  it.each(['appearance', 'role'] as const)('rejects an incompatible %s update atomically', change => {
    const definition = fallbackRoles[0];
    const asset = buildRobotAsset(definition);
    const geometry = skinnedMeshes(asset).map(mesh => mesh.geometry);
    const incompatible = change === 'appearance'
      ? { agent: agentFor(definition, { appearance_id: 'qa_v1' }) }
      : { definition: { ...definition, role: 'architect' as const } };
    expect(() => asset.setVisualState(incompatible)).toThrow(/requires a new robot asset/);
    expect(() => asset.setVisualState({ night: true, selected: true })).not.toThrow();
    expect(asset.root.userData).toMatchObject({ role: definition.role, resolved_appearance_id: 'product_manager_v1' });
    expect(skinnedMeshes(asset).map(mesh => mesh.geometry)).toEqual(geometry);
    asset.dispose();
  });

  it('anchors labels to the animated head under movement and world rotation', () => {
    const asset = buildRobotAsset(fallbackRoles[1]);
    const target = new Vector3();
    expect(asset.labelPosition(target)).toBe(target);
    const before = target.clone();
    const tip = new Box3().setFromPoints(nativeVertices(asset).map(record => record.vertex)).max.y + asset.root.position.y;
    expect(target.y).toBeGreaterThan(tip);
    expect(target.y - tip).toBeLessThan(0.4);
    asset.root.position.add(new Vector3(2, 0, 3));
    const translated = asset.labelPosition(target).clone();
    expect(translated.distanceTo(before.clone().add(new Vector3(2, 0, 3)))).toBeLessThan(0.00001);
    asset.root.rotation.y = Math.PI / 2;
    asset.play('meeting');
    asset.update(0.6);
    const animated = asset.labelPosition(target);
    expect(animated.distanceTo(translated)).toBeGreaterThan(0.01);
    asset.dispose();
  });

  it('releases owned meshes, materials, bone texture and actions exactly once', () => {
    const asset = buildRobotAsset(fallbackRoles[0]);
    const second = buildRobotAsset(fallbackRoles[0]);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    asset.root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      geometries.add(node.geometry);
      (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => materials.add(material));
    });
    expect(skinnedMeshes(asset)[0].geometry).not.toBe(skinnedMeshes(second)[0].geometry);
    const disposal = new Map<object, number>();
    asset.skeleton.computeBoneTexture();
    const owned = [...geometries, ...materials, asset.skeleton.boneTexture!];
    owned.forEach(resource => resource.addEventListener('dispose', () => disposal.set(resource, (disposal.get(resource) ?? 0) + 1)));
    asset.play('walk');
    asset.update(0.4);
    asset.dispose();
    asset.dispose();
    expect(owned.every(resource => disposal.get(resource) === 1)).toBe(true);
    expect(asset.root.children).toHaveLength(0);
    expect(asset.update(1)).toBe(false);
    second.play('walk');
    expect(second.update(0.2)).toBe(true);
    second.dispose();
  });
});
