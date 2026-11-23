import { act, Component, StrictMode, type ReactNode } from 'react';
import { createRoot, _roots, reconciler, useFrame } from '@react-three/fiber';
import { Group, Scene, Texture, type WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import type { RigRegistry } from './actorController';
import { RiggedAgentBot } from './RiggedAgentBot';
import type { AgentRig } from './robotRig';
import { ScenePrecompiler } from './ScenePrecompiler';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushPreparation() { await new Promise(resolve => setTimeout(resolve, 0)); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(compile: () => Promise<void>, strict = false) {
  const canvas = Object.assign(new EventTarget(), { width: 100, height: 100 }) as unknown as HTMLCanvasElement;
  const scene = new Scene();
  const order: string[] = [];
  const render = vi.fn(() => { order.push('draw'); });
  const renderer = {
    render, compileAsync: vi.fn(compile), domElement: canvas, setPixelRatio() {}, setSize() {},
    shadowMap: { enabled: false, needsUpdate: false },
    xr: { isPresenting: false, addEventListener() {}, removeEventListener() {} },
    getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget() {},
  } as unknown as WebGLRenderer;
  const cameraOptions = { manual: true, position: [4, 5, 10] as [number, number, number] };
  const configure = (dpr: number) => root.configure({ gl: renderer, scene, orthographic: true,
    camera: cameraOptions, frameloop: 'never', dpr, size: { width: 100, height: 100, left: 0, top: 0 } });
  const createContainer = reconciler.createContainer.bind(reconciler);
  const strictContainer = strict ? vi.spyOn(reconciler, 'createContainer').mockImplementation((...args) => {
    args[3] = true;
    return createContainer(...args);
  }) : null;
  const root = createRoot(canvas);
  strictContainer?.mockRestore();
  await configure(1);
  const registry: RigRegistry = { rigs: new Map(), revision: 0 };
  const registrations: (AgentRig | null)[] = [];
  const statuses: string[] = [];
  const handlers = new Map(fallbackRoles.map(definition => [definition.role, (rig: AgentRig | null) => {
    registrations.push(rig);
    if (rig) registry.rigs.set(definition.role, rig);
    else registry.rigs.delete(definition.role);
    registry.revision++;
  }]));
  const onStatus = (status: string) => { statuses.push(status); };
  const select = () => {};
  function FrameWork() {
    useFrame(state => { order.push('camera'); state.camera.updateMatrixWorld(); }, -1);
    useFrame(() => { order.push('rig'); for (const rig of registry.rigs.values()) rig.update(0); }, -0.5);
    return null;
  }
  function content(expected: RoleDefinition[], rendered = expected, agent?: AgentView) {
    return <><FrameWork /><ScenePrecompiler registry={registry} expectedRoles={expected.map(item => item.role)}
      resourceRevision="night" onStatus={onStatus} />
      {rendered.map(definition => <RiggedAgentBot key={definition.role} definition={definition} agent={agent}
        night selected={false} onSelect={select} onRigReady={handlers.get(definition.role)} />)}</>;
  }
  const renderScene = async (expected: RoleDefinition[], rendered = expected, agent?: AgentView) => {
    await act(async () => { root.render(strict ? <StrictMode>{content(expected, rendered, agent)}</StrictMode>
      : content(expected, rendered, agent)); });
  };
  let time = 0;
  const frame = async () => {
    await act(async () => { _roots.get(canvas)!.store.getState().advance(++time); await flushPreparation(); });
  };
  const unmount = async () => { await act(async () => { root.unmount(); }); };
  return { canvas, root, scene, renderer, registry, render, registrations, statuses, order,
    renderScene, frame, unmount, configure, content };
}

describe('native Fiber shader startup', () => {
  it('waits for the environment and all seven attached rigs, then draws once after lower-priority hooks', async () => {
    const compilation = deferred();
    const world = await fixture(() => compilation.promise);
    try {
      await world.renderScene(fallbackRoles, fallbackRoles.slice(0, 6));
      await world.frame();
      expect(world.renderer.compileAsync).not.toHaveBeenCalled();
      expect(world.render).not.toHaveBeenCalled();
      world.scene.environment = new Texture();
      await world.frame();
      expect(world.renderer.compileAsync).not.toHaveBeenCalled();
      await world.renderScene(fallbackRoles);
      await world.frame();
      expect(world.registry.rigs.size).toBe(7);
      expect(world.renderer.compileAsync).toHaveBeenCalledExactlyOnceWith(world.scene, _roots.get(world.canvas)!.store.getState().camera);
      expect(world.render).not.toHaveBeenCalled();
      expect(world.statuses).not.toContain('ready');
      await act(async () => { compilation.resolve(); await flushPreparation(); });
      world.order.length = 0;
      await world.frame();
      expect(world.order).toEqual(['camera', 'rig', 'draw']);
      expect(world.render).toHaveBeenCalledTimes(1);
      expect(world.statuses.at(-1)).toBe('ready');
    } finally { compilation.resolve(); await world.unmount(); }
  });

  it('preserves the native rig and camera across transport updates and a DPR change without recompiling', async () => {
    const world = await fixture(async () => {});
    const definition = fallbackRoles.find(item => item.role === 'backend')!;
    try {
      world.scene.environment = new Texture();
      await world.renderScene([definition]);
      await world.frame();
      await world.frame();
      const rig = world.registry.rigs.get(definition.role)!;
      const camera = _roots.get(world.canvas)!.store.getState().camera;
      camera.position.set(8, 4, 7);
      const agent: AgentView = { id: 'actor', run_id: 'run', role: definition.role, instructions_version: '1',
        appearance_id: definition.appearance_id, lifecycle: 'busy', activity: 'coding', location: 'development',
        current_task_id: 'task', allowed_operations: ['read'] };
      await world.renderScene([{ ...definition }], undefined, agent);
      rig.play('work');
      rig.update(0.2);
      await act(async () => { await world.configure(0.8); });
      for (let i = 0; i < 3; i++) await world.frame();
      expect(_roots.get(world.canvas)!.store.getState().camera).toBe(camera);
      expect(camera.position.toArray()).toEqual([8, 4, 7]);
      expect(world.registry.rigs.get(definition.role)).toBe(rig);
      expect(world.registrations.filter(Boolean)).toEqual([rig]);
      expect(world.renderer.compileAsync).toHaveBeenCalledTimes(1);
      expect(world.render).toHaveBeenCalledTimes(4);
    } finally { await world.unmount(); }
  });

  it('keeps a changed environment gated while an earlier preparation finishes', async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const world = await fixture(() => ++calls === 1 ? first.promise : second.promise);
    try {
      world.scene.environment = new Texture();
      await world.renderScene([fallbackRoles[0]]);
      await world.frame();
      world.scene.environment = new Texture();
      await world.frame();
      expect(calls).toBe(1);
      await act(async () => { first.resolve(); await flushPreparation(); });
      expect(calls).toBe(2);
      await world.frame();
      expect(world.render).not.toHaveBeenCalled();
      expect(world.statuses).not.toContain('ready');
      await act(async () => { second.resolve(); await flushPreparation(); });
      await world.frame();
      expect(world.render).toHaveBeenCalledTimes(1);
    } finally { first.resolve(); second.resolve(); await world.unmount(); }
  });

  it('rejects readiness for a replaced appearance even before the next Fiber frame observes it', async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const world = await fixture(() => ++calls === 1 ? first.promise : second.promise);
    const definition = fallbackRoles[0];
    try {
      world.scene.environment = new Texture();
      await world.renderScene([definition]);
      await world.frame();
      const discarded = world.registry.rigs.get(definition.role)!;
      await world.renderScene([{ ...definition, appearance_id: 'qa_v1' }]);
      expect(world.registry.rigs.get(definition.role)).not.toBe(discarded);
      expect(discarded.root.children).toHaveLength(0);
      await act(async () => { first.resolve(); await flushPreparation(); });
      expect(world.statuses).not.toContain('ready');
      expect(world.render).not.toHaveBeenCalled();
      await world.frame();
      expect(calls).toBe(2);
      await act(async () => { second.resolve(); await flushPreparation(); });
      await world.frame();
      expect(world.render).toHaveBeenCalledTimes(1);
    } finally { first.resolve(); second.resolve(); await world.unmount(); }
  });

  it('uses only the surviving StrictMode assets and ignores completion after unmount', async () => {
    const compilation = deferred();
    const world = await fixture(() => compilation.promise, true);
    world.scene.environment = new Texture();
    await world.renderScene([fallbackRoles[0]]);
    await world.frame();
    expect(world.registrations.filter(Boolean)).toHaveLength(2);
    expect(world.renderer.compileAsync).toHaveBeenCalledTimes(1);
    const statuses = [...world.statuses];
    await world.unmount();
    await act(async () => { compilation.resolve(); await flushPreparation(); });
    expect(world.statuses).toEqual(statuses);
    expect(world.render).not.toHaveBeenCalled();
    expect(_roots.has(world.canvas)).toBe(false);
  });

  it('rethrows a current preparation rejection through the scene error boundary', async () => {
    const compilation = deferred();
    const world = await fixture(() => compilation.promise);
    const caught: Error[] = [];
    const fallback = new Group();
    fallback.name = 'scene-unavailable';
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error: Error) { caught.push(error); }
      render() { return this.state.failed ? <primitive object={fallback} /> : this.props.children; }
    }
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      world.scene.environment = new Texture();
      await act(async () => { world.root.render(<Boundary>{world.content([fallbackRoles[0]])}</Boundary>); });
      await world.frame();
      const failure = new Error('GPU preparation failed');
      await act(async () => { compilation.reject(failure); await flushPreparation(); });
      expect(caught).toEqual([failure]);
      expect(world.scene.getObjectByName('scene-unavailable')).toBeDefined();
      expect(world.statuses.at(-1)).toBe('failed');
      expect(world.render).not.toHaveBeenCalled();
    } finally { errorOutput.mockRestore(); await world.unmount(); }
  });
});
