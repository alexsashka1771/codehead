import { describe, expect, it } from 'vitest';
import { EnvironmentBuilder } from './environmentBatch';
import { environmentRounded } from './environmentGeometry';
import { buildAtelierDeck, buildAtelierWallBatches } from './architecture';
import { buildAtelierFurniture } from './furniture';
import { buildCentralHub } from './CentralHub';

describe('static environment batching', () => {
  it('merges opaque parts by material while preserving transforms, UVs and shadow policy', () => {
    const author = new EnvironmentBuilder('batch-contract');
    const wood = { color: '#956747', finish: 'wood' as const };
    author.box([1, 1, 2], [1, 0.2, 2], wood);
    author.group([3, 0, -2], [0, Math.PI / 2, 0], () => author.box([0, 1, 0], [2, 0.2, 1], wood));
    author.box([0, 0, 0], [0.1, 0.1, 0.1], wood, { castShadow: false });
    const batches = author.finish();
    expect(batches).toHaveLength(2);
    const geometry = batches.find(batch => batch.castShadow)!.geometry;
    expect(geometry.index?.count).toBe(72);
    expect(geometry.getAttribute('position').count).toBe(48);
    expect(geometry.getAttribute('uv').count).toBe(48);
    expect(geometry.boundingBox!.min.x).toBeCloseTo(0.5);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(3.5);
    expect(geometry.boundingBox!.min.z).toBeCloseTo(-3);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(3);
    expect(batches.every(batch => batch.surface.finish === 'wood')).toBe(true);
    for (const batch of batches) batch.geometry.dispose();
  });

  it('keeps optically different glass volumes in separate material batches', () => {
    const author = new EnvironmentBuilder('optical-material-contract');
    const thin = { color: '#c8e4e7', finish: 'glass' as const, glassMode: 'volume' as const, transmission: 0.9, thickness: 0.03 };
    const solid = { ...thin, transmission: 0.72, thickness: 0.16 };
    author.box([0, 0, 0], [1, 1, 0.03], thin);
    author.box([2, 0, 0], [1, 1, 0.16], solid);
    const batches = author.finish();
    try { expect(batches).toHaveLength(2); }
    finally { for (const batch of batches) batch.geometry.dispose(); }
  });

  it('keeps tiny furniture details indexed and under a small geometry budget', () => {
    const trim = environmentRounded([1, 0.008, 0.03], 0.013);
    const knob = environmentRounded([0.4, 0.07, 0.25], 0.11);
    expect(trim.index?.count).toBe(36);
    expect(knob.getAttribute('position').count).toBeLessThan(300);
    expect(knob.index).not.toBeNull();
    trim.dispose();
    knob.dispose();
  });

  it('assembles compatible buffers and keeps identical geometry in both lighting themes', () => {
    const night = [...buildAtelierDeck(true), ...buildAtelierWallBatches(true), ...buildAtelierFurniture(true), ...buildCentralHub(true)];
    const day = [...buildAtelierDeck(false), ...buildAtelierWallBatches(false), ...buildAtelierFurniture(false), ...buildCentralHub(false)];
    expect(night).toHaveLength(day.length);
    let vertices = 0;
    let triangles = 0;
    for (let index = 0; index < night.length; index++) {
      const geometry = night[index].geometry;
      const other = day[index].geometry;
      const positions = geometry.getAttribute('position');
      expect(geometry.index).not.toBeNull();
      expect(positions.count).toBe(geometry.getAttribute('normal').count);
      expect(positions.count).toBe(geometry.getAttribute('uv').count);
      expect(positions.array).toEqual(other.getAttribute('position').array);
      expect(geometry.index!.array).toEqual(other.index!.array);
      vertices += positions.count;
      triangles += geometry.index!.count / 3;
    }
    console.info('Atelier static geometry:', { meshes: night.length, shadowCasters: night.filter(batch => batch.castShadow).length, vertices, triangles });
    for (const batch of [...night, ...day]) batch.geometry.dispose();
  });
});
