import { isValidElement, type ReactNode } from 'react';
import { Color, MeshStandardMaterial, SkinnedMesh, Vector3, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import type { RoleDefinition } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import { AgentBot } from './AgentBot';
import { resolveAppearance } from './appearance';
import { buildRobotAsset, type RobotAsset } from './robotAsset';
import { ROBOT_JOINTS } from './robotRig';

type RecipeProps = { children?: ReactNode; args?: number[]; color?: string; name?: string };
type RecipeShape = { type: string; args: number[]; names: string[] };

function shapes(node: ReactNode, names: string[] = []): RecipeShape[] {
  if (Array.isArray(node)) return node.flatMap(child => shapes(child, names));
  if (!isValidElement<RecipeProps>(node)) return [];
  if (typeof node.type === 'function') return shapes((node.type as (props: RecipeProps) => ReactNode)(node.props), names);
  const path = node.props.name ? [...names, node.props.name] : names;
  const own = typeof node.type === 'string' && node.type.endsWith('Geometry')
    ? [{ type: node.type, args: node.props.args ?? [], names: path }] : [];
  return [...own, ...shapes(node.props.children, path)];
}

function meshes(asset: RobotAsset) {
  const result: SkinnedMesh<BufferGeometry, MeshStandardMaterial | MeshStandardMaterial[]>[] = [];
  asset.root.traverse(node => { if (node instanceof SkinnedMesh) result.push(node); });
  return result;
}

function recipe(definition: RoleDefinition) {
  return shapes(AgentBot({ definition, night: true, selected: false, onSelect: () => {} }));
}

describe('refined native robot models', () => {
  it.each(fallbackRoles)('gives $role real rounded hulls without high segment counts', definition => {
    const rounded = recipe(definition).filter(shape => shape.type === 'roundedBoxGeometry');
    expect(rounded.length).toBeGreaterThanOrEqual(9);
    expect(rounded.every(shape => shape.args[3] === 1 && shape.args[4] > 0)).toBe(true);
    expect(rounded.some(shape => shape.names.includes('torso-shell') && shape.args[4] >= 0.1)).toBe(true);
    expect(rounded.some(shape => shape.names.includes('face-visor') && shape.args[4] >= 0.07)).toBe(true);
  });

  it('keeps seven readable colored shell finishes and distinct role silhouettes', () => {
    const silhouettes = fallbackRoles.map(definition => JSON.stringify(recipe(definition)
      .map(({ type, args }) => ({ type, args }))));
    expect(new Set(silhouettes).size).toBe(7);
    for (const definition of fallbackRoles) {
      const { shell, id } = resolveAppearance(definition.appearance_id).appearance;
      const color = new Color(shell);
      const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
      expect(luminance, `${id} shell must remain readable in the night scene`).toBeGreaterThan(0.3);
      const asset = buildRobotAsset(definition, undefined, true);
      try {
        const materials = meshes(asset).flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
        expect(materials.some(material => material.color.equals(color) && material.metalness <= 0.22)).toBe(true);
        expect(new Set(materials.map(material => material.color.getHexString())).size).toBeGreaterThanOrEqual(5);
      } finally { asset.dispose(); }
    }
  });

  it.each(fallbackRoles)('weights actual hulls and hands to all 13 joints of $role', definition => {
    const asset = buildRobotAsset(definition);
    try {
      const weighted = new Set<string>();
      for (const mesh of meshes(asset)) {
        const skin = mesh.geometry.getAttribute('skinIndex');
        for (let index = 0; index < skin.count; index++) weighted.add(asset.skeleton.bones[skin.getX(index)].name);
      }
      expect([...weighted].sort()).toEqual([...ROBOT_JOINTS].sort());
      const wrist = asset.skeleton.getBoneByName('rightWrist')!;
      const wristIndex = asset.skeleton.bones.indexOf(wrist);
      const surface = meshes(asset).find(mesh => Array.from(mesh.geometry.getAttribute('skinIndex').array)
        .some((value, index) => index % 4 === 0 && value === wristIndex))!;
      const skins = surface.geometry.getAttribute('skinIndex');
      let vertexIndex = 0;
      while (skins.getX(vertexIndex) !== wristIndex) vertexIndex++;
      asset.root.updateMatrixWorld(true);
      asset.skeleton.update();
      const restVertex = surface.getVertexPosition(vertexIndex, new Vector3()).clone();
      const before = wrist.quaternion.clone();
      asset.play('work');
      asset.update(0.39);
      expect(wrist.quaternion.angleTo(before)).toBeGreaterThan(0.01);
      asset.root.updateMatrixWorld(true);
      asset.skeleton.update();
      expect(surface.getVertexPosition(vertexIndex, new Vector3()).distanceTo(restVertex)).toBeGreaterThan(0.001);
    } finally { asset.dispose(); }
  });

  it('bounds native geometry cost for the seven separate models', () => {
    const counts = fallbackRoles.map(definition => {
      const asset = buildRobotAsset(definition, undefined, true);
      try {
        const surfaces = meshes(asset);
        const drawCalls = surfaces.reduce((sum, mesh) => sum + mesh.geometry.groups.length, 0);
        const triangles = surfaces.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0);
        expect(drawCalls, definition.role).toBeLessThanOrEqual(20);
        expect(triangles, definition.role).toBeLessThanOrEqual(7200);
        return { role: definition.role, meshes: surfaces.length, drawCalls, triangles };
      } finally { asset.dispose(); }
    });
    console.info('Robot native geometry budget:', JSON.stringify(counts));
  });

  it('owns independent rounded geometry across a StrictMode setup-cleanup-setup cycle', () => {
    const definition = fallbackRoles[0];
    const discarded = buildRobotAsset(definition);
    const firstGeometry = meshes(discarded)[0].geometry;
    let releases = 0;
    firstGeometry.addEventListener('dispose', () => { releases++; });
    discarded.dispose();
    const surviving = buildRobotAsset(definition);
    try {
      expect(meshes(surviving)[0].geometry).not.toBe(firstGeometry);
      expect(releases).toBe(1);
      surviving.play('walk');
      expect(surviving.update(0.26)).toBe(true);
      surviving.root.updateMatrixWorld(true);
      surviving.skeleton.update();
      expect(meshes(surviving)[0].getVertexPosition(0, new Vector3()).toArray().every(Number.isFinite)).toBe(true);
    } finally { surviving.dispose(); }
  });
});
