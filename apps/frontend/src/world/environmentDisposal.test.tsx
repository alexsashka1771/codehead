import { act, StrictMode } from 'react';
import { createRoot, _roots, reconciler, extend } from '@react-three/fiber';
import { BoxGeometry, Mesh, MeshPhysicalMaterial, type Material, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BatchedEnvironment, type EnvironmentBatch } from './environmentBatch';

extend({ Mesh, MeshPhysicalMaterial });

function batch(name: string, geometry: BoxGeometry): EnvironmentBatch {
  return { name, geometry, surface: { color: '#c8e4e7', finish: 'glass', transmission: 0.97, thickness: 0.025 },
    castShadow: false, receiveShadow: false };
}

async function nativeRoot(strict = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const canvas = Object.assign(new EventTarget(), { width: 100, height: 100 }) as unknown as HTMLCanvasElement;
  // The reconciler and Three resources are real; only the unused GPU boundary is stubbed.
  const renderer = { render: vi.fn(), domElement: canvas, setPixelRatio() {}, setSize() {},
    xr: { isPresenting: false, addEventListener() {}, removeEventListener() {} },
  } as unknown as WebGLRenderer;
  const createContainer = reconciler.createContainer.bind(reconciler);
  const strictContainer = strict ? vi.spyOn(reconciler, 'createContainer').mockImplementation((...args) => {
    args[3] = true;
    return createContainer(...args);
  }) : null;
  const root = createRoot(canvas);
  strictContainer?.mockRestore();
  await root.configure({ gl: renderer, frameloop: 'never', dpr: 1,
    size: { width: 100, height: 100, left: 0, top: 0 } });
  return {
    async render(batches: EnvironmentBatch[]) {
      await act(async () => {
        root.render(strict ? <StrictMode><BatchedEnvironment batches={batches} /></StrictMode>
          : <BatchedEnvironment batches={batches} />);
      });
    },
    material(name: string) {
      const mesh = _roots.get(canvas)!.store.getState().scene.getObjectByName(name) as Mesh;
      return mesh.material as Material;
    },
    async cleanup() {
      await act(async () => { root.unmount(); });
      vi.unstubAllGlobals();
    },
  };
}

describe('native environment resource ownership', () => {
  it('releases child materials and manually owned geometry when a batch is removed', async () => {
    const geometry = new BoxGeometry();
    const geometryDisposal = vi.spyOn(geometry, 'dispose');
    const scene = await nativeRoot();
    try {
      await scene.render([batch('owned-glass', geometry)]);
      const materialDisposal = vi.spyOn(scene.material('owned-glass'), 'dispose');
      await scene.render([]);
      expect(geometryDisposal).toHaveBeenCalledTimes(1);
      expect(materialDisposal).toHaveBeenCalledTimes(1);
      await scene.cleanup();
      expect(geometryDisposal).toHaveBeenCalledTimes(1);
      expect(materialDisposal).toHaveBeenCalledTimes(1);
    } finally { await scene.cleanup(); }
  });

  it('retains surviving geometry through actual root StrictMode effect replay', async () => {
    const geometry = new BoxGeometry();
    const geometryDisposal = vi.spyOn(geometry, 'dispose');
    const scene = await nativeRoot(true);
    try {
      await scene.render([batch('strict-glass', geometry)]);
      const materialDisposal = vi.spyOn(scene.material('strict-glass'), 'dispose');
      expect(geometryDisposal).not.toHaveBeenCalled();
      expect(materialDisposal).not.toHaveBeenCalled();
      await scene.render([]);
      expect(geometryDisposal).toHaveBeenCalledTimes(1);
      expect(materialDisposal).toHaveBeenCalledTimes(1);
    } finally { await scene.cleanup(); }
  });

  it('keeps reused geometry alive and releases each unique resource once on replacement', async () => {
    const shared = new BoxGeometry();
    const replacement = new BoxGeometry(2, 1, 1);
    const sharedDisposal = vi.spyOn(shared, 'dispose');
    const replacementDisposal = vi.spyOn(replacement, 'dispose');
    const scene = await nativeRoot();
    try {
      await scene.render([batch('shared-a', shared), batch('shared-b', shared)]);
      const materialA = vi.spyOn(scene.material('shared-a'), 'dispose');
      const materialB = vi.spyOn(scene.material('shared-b'), 'dispose');
      await scene.render([batch('reused', shared)]);
      expect(sharedDisposal).not.toHaveBeenCalled();
      expect(materialA).toHaveBeenCalledTimes(1);
      expect(materialB).toHaveBeenCalledTimes(1);
      await scene.render([batch('replacement', replacement)]);
      expect(sharedDisposal).toHaveBeenCalledTimes(1);
      expect(replacementDisposal).not.toHaveBeenCalled();
      await scene.cleanup();
      expect(sharedDisposal).toHaveBeenCalledTimes(1);
      expect(replacementDisposal).toHaveBeenCalledTimes(1);
    } finally { await scene.cleanup(); }
  });
});
