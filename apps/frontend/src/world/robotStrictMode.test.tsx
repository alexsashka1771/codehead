import { act, StrictMode } from 'react';
import { createRoot, _roots, reconciler } from '@react-three/fiber';
import { Mesh, type BufferGeometry, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fallbackRoles } from '../features/roles';
import { RiggedAgentBot } from './RiggedAgentBot';
import type { AgentRig } from './robotRig';

describe('native robot React ownership', () => {
  it('survives actual StrictMode effect replay and releases each discarded native asset once', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const canvas = Object.assign(new EventTarget(), { width: 100, height: 100 }) as unknown as HTMLCanvasElement;
    // CPU-only Fiber reconciles real Three objects; the GPU boundary is the only stub.
    const render = vi.fn();
    const renderer = { render, domElement: canvas, setPixelRatio() {}, setSize() {},
      xr: { isPresenting: false, addEventListener() {}, removeEventListener() {} },
    } as unknown as WebGLRenderer;
    // A nested StrictMode skips initial effect replay in React 19. Model the app's root StrictMode.
    const createContainer = reconciler.createContainer.bind(reconciler);
    const strictContainer = vi.spyOn(reconciler, 'createContainer').mockImplementation((...args) => {
      args[3] = true;
      return createContainer(...args);
    });
    const root = createRoot(canvas);
    strictContainer.mockRestore();
    const ready: AgentRig[] = [];
    const changes: Array<AgentRig | null> = [];
    const releases = new Map<BufferGeometry, number>();
    const owned = new Map<AgentRig, Set<BufferGeometry>>();
    const onRigReady = (rig: AgentRig | null) => {
      changes.push(rig);
      if (!rig) return;
      ready.push(rig);
      const geometry = new Set<BufferGeometry>();
      rig.root.traverse(node => { if (node instanceof Mesh) geometry.add(node.geometry); });
      geometry.forEach(value => value.addEventListener('dispose', () => releases.set(value, (releases.get(value) ?? 0) + 1)));
      owned.set(rig, geometry);
    };
    const definition = fallbackRoles[0];
    try {
      await root.configure({ gl: renderer, frameloop: 'never', dpr: 1, size: { width: 100, height: 100, left: 0, top: 0 } });
      await act(async () => {
        root.render(<StrictMode><RiggedAgentBot definition={definition} night selected={false}
          onSelect={() => {}} onRigReady={onRigReady} /></StrictMode>);
      });
      expect(ready).toHaveLength(2);
      expect(changes).toEqual([ready[0], null, ready[1]]);
      expect(ready[0].root.children).toHaveLength(0);
      expect([...owned.get(ready[0])!].every(geometry => releases.get(geometry) === 1)).toBe(true);
      const surviving = ready[1];
      expect(_roots.get(canvas)?.store.getState().scene.getObjectByName(surviving.root.name)).toBe(surviving.root);
      expect([...owned.get(surviving)!].every(geometry => !releases.has(geometry))).toBe(true);
      await act(async () => {
        root.render(<StrictMode><RiggedAgentBot definition={definition} night={false} selected
          onSelect={() => {}} onRigReady={onRigReady} /></StrictMode>);
      });
      expect(ready).toHaveLength(2);
      expect(surviving.root.getObjectByName('selection-ring')?.visible).toBe(true);
      expect(render).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); });
      expect(changes).toEqual([ready[0], null, surviving, null]);
      expect(surviving.root.children).toHaveLength(0);
      expect([...owned.get(surviving)!].every(geometry => releases.get(geometry) === 1)).toBe(true);
      expect(_roots.has(canvas)).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      vi.unstubAllGlobals();
    }
  });
});
