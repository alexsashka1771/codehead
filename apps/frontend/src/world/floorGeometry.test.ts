import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildAtelierDeck } from './architecture';
import { DECK_HEIGHT } from './layout';

const samples = [
  { name: 'product', x: -7.35, z: -3.95 },
  { name: 'architecture', x: -1.7, z: -5.55 },
  { name: 'security inset', x: 2.0, z: -6.08 },
  { name: 'development', x: -7.05, z: 1.45 },
  { name: 'devops', x: 7.15, z: -1.65 },
  { name: 'research inset', x: 7.15, z: -5.6 },
  { name: 'meeting', x: -6.15, z: 6.55 },
  { name: 'qa', x: 3.55, z: 5.05 },
  { name: 'production', x: 8.25, z: 4.95 },
  { name: 'product/development threshold', x: -7.27, z: -1.11 },
];

describe('floor surface depth separation', () => {
  it.each(samples)('keeps overlapping surfaces apart at $name', ({ x, z }) => {
    const batches = buildAtelierDeck(false);
    const material = new MeshBasicMaterial();
    const meshes = batches.map(batch => new Mesh(batch.geometry, material));
    const ray = new Raycaster(new Vector3(x, DECK_HEIGHT + 0.06, z), new Vector3(0, -1, 0));
    try {
      const hits = ray.intersectObjects(meshes, false).filter(hit =>
        hit.face!.normal.y > 0.99 && hit.point.y >= DECK_HEIGHT - 0.04);
      // A ray on a triangulation edge can hit two faces of the same surface.
      const layers = hits.filter((hit, index) => !hits.slice(0, index).some(previous =>
        previous.object === hit.object && Math.abs(previous.point.y - hit.point.y) < 0.00001));
      expect(layers.length).toBeGreaterThan(1);
      const conflicts = layers.flatMap((hit, index) => layers.slice(index + 1)
        .filter(other => Math.abs(other.point.y - hit.point.y) < 0.002)
        .map(other => ({ upper: hit.point.y, lower: other.point.y })));
      expect(conflicts).toEqual([]);
    } finally {
      material.dispose();
      for (const batch of batches) batch.geometry.dispose();
    }
  });
});

describe('entrance stair clearance', () => {
  it.each([
    { name: 'landing', z: 7.95, top: 0.16 },
    { name: 'second tread', z: 8.215, top: -0.0175 },
    { name: 'third tread', z: 8.48, top: -0.195 },
    { name: 'bottom tread', z: 8.745, top: -0.3725 },
  ])('keeps $name exposed across the stair width', ({ z, top }) => {
    const batches = buildAtelierDeck(false);
    const material = new MeshBasicMaterial();
    const meshes = batches.map(batch => new Mesh(batch.geometry, material));
    const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
    try {
      for (const x of [-2.08, -1.2, -0.32]) {
        ray.ray.origin.set(x, 1, z);
        const hit = ray.intersectObjects(meshes, false).find(item => item.face!.normal.y > 0.99);
        expect(hit, `Missing stair surface at ${x}, ${z}`).toBeDefined();
        expect(hit!.point.y, `Covered stair surface at ${x}, ${z}`).toBeCloseTo(top, 5);
      }
    } finally {
      material.dispose();
      for (const batch of batches) batch.geometry.dispose();
    }
  });
});
