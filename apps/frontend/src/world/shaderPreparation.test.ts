import { ACESFilmicToneMapping, BackSide, DoubleSide, FrontSide, LinearSRGBColorSpace, Mesh, MeshPhysicalMaterial, MeshStandardMaterial,
  NoToneMapping, OrthographicCamera, Scene, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSceneShaders, ScenePreparationGate } from './shaderPreparation';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function rendererHarness(compile: () => Promise<void>, multisampledRenderToTexture = false) {
  let target: WebGLRenderTarget | null = null;
  let face = 0;
  let level = 0;
  const render = vi.fn();
  const renderer = {
    render, compileAsync: vi.fn(compile), toneMapping: ACESFilmicToneMapping,
    extensions: { has: vi.fn((name: string) => name === 'WEBGL_multisampled_render_to_texture' && multisampledRenderToTexture) },
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => level,
    setRenderTarget: vi.fn((next: WebGLRenderTarget | null, nextFace = 0, nextLevel = 0) => {
      target = next; face = nextFace; level = nextLevel;
    }),
  } as unknown as WebGLRenderer;
  return { renderer, render };
}

afterEach(() => vi.restoreAllMocks());

describe('shader preparation without drawing', () => {
  it('prepares the current output without allocating a target for an opaque scene', async () => {
    const compilation = deferred();
    const { renderer, render } = rendererHarness(() => compilation.promise);
    const scene = new Scene();
    scene.add(new Mesh(undefined, new MeshStandardMaterial()));
    const camera = new OrthographicCamera();
    const pending = prepareSceneShaders(renderer, scene, camera);
    await flush();
    expect(renderer.compileAsync).toHaveBeenCalledExactlyOnceWith(scene, camera);
    expect(renderer.setRenderTarget).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    compilation.resolve();
    await pending;
  });

  it('awaits output programs before preparing the linear transmission variant and restores state immediately', async () => {
    const output = deferred();
    const transmission = deferred();
    const observed: { target: WebGLRenderTarget | null; mapping: number }[] = [];
    const { renderer, render } = rendererHarness(() => {
      observed.push({ target: renderer.getRenderTarget(), mapping: renderer.toneMapping });
      return observed.length === 1 ? output.promise : transmission.promise;
    });
    const dispose = vi.spyOn(WebGLRenderTarget.prototype, 'dispose');
    const scene = new Scene();
    scene.add(new Mesh(undefined, new MeshPhysicalMaterial({ transmission: 0.97, thickness: 0.025 })));
    const camera = new OrthographicCamera();
    const pending = prepareSceneShaders(renderer, scene, camera);
    await flush();
    expect(observed).toEqual([{ target: null, mapping: ACESFilmicToneMapping }]);
    output.resolve();
    await flush();
    expect(observed).toHaveLength(2);
    expect(observed[1].target).toBeInstanceOf(WebGLRenderTarget);
    expect(observed[1].target!.width).toBe(1);
    expect(observed[1].target!.texture.colorSpace).toBe(LinearSRGBColorSpace);
    expect(observed[1].mapping).toBe(NoToneMapping);
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    transmission.resolve();
    await pending;
  });

  it('restores the active target, face, mip level and tone mapping when compilation throws', async () => {
    let calls = 0;
    const failure = new Error('driver rejected transmission programs');
    const { renderer } = rendererHarness(() => {
      if (++calls === 2) throw failure;
      return Promise.resolve();
    });
    const original = new WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(original, 2, 1);
    const dispose = vi.spyOn(WebGLRenderTarget.prototype, 'dispose');
    const scene = new Scene();
    scene.add(new Mesh(undefined, new MeshPhysicalMaterial({ transmission: 1 })));
    await expect(prepareSceneShaders(renderer, scene, new OrthographicCamera())).rejects.toBe(failure);
    expect(renderer.getRenderTarget()).toBe(original);
    expect(renderer.getActiveCubeFace()).toBe(2);
    expect(renderer.getActiveMipmapLevel()).toBe(1);
    expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(dispose).toHaveBeenCalledTimes(1);
    original.dispose();
  });

  it('serializes generations on the same renderer so currentProgram cannot race', async () => {
    const first = deferred();
    const second = deferred();
    let firstCurrent = true;
    let calls = 0;
    const { renderer } = rendererHarness(() => ++calls === 1 ? first.promise : second.promise);
    const scene = new Scene();
    const camera = new OrthographicCamera();
    const old = prepareSceneShaders(renderer, scene, camera, () => firstCurrent);
    await flush();
    const latest = prepareSceneShaders(renderer, scene, camera);
    await flush();
    expect(calls).toBe(1);
    firstCurrent = false;
    first.resolve();
    await old;
    await flush();
    expect(calls).toBe(2);
    second.resolve();
    await latest;
  });

  it('awaits opaque DoubleSide transmission back-face programs before permitting the first draw', async () => {
    const output = deferred();
    const linear = deferred();
    const back = deferred();
    const phases = [output, linear, back];
    const glass = new MeshPhysicalMaterial({ transmission: 0.97, thickness: 0.025, side: DoubleSide, transparent: false });
    const front = new MeshPhysicalMaterial({ transmission: 0.9, side: FrontSide });
    const opaque = new MeshPhysicalMaterial({ side: DoubleSide });
    const version = glass.version;
    const observed: { side: number; front: number; opaque: number; target: WebGLRenderTarget | null; mapping: number }[] = [];
    const { renderer, render } = rendererHarness(() => {
      observed.push({ side: glass.side, front: front.side, opaque: opaque.side,
        target: renderer.getRenderTarget(), mapping: renderer.toneMapping });
      return phases[observed.length - 1].promise;
    });
    const scene = new Scene();
    scene.add(new Mesh(undefined, glass), new Mesh(undefined, glass), new Mesh(undefined, front), new Mesh(undefined, opaque));
    const statuses: string[] = [];
    const gate = new ScenePreparationGate(status => statuses.push(status), () => {});
    gate.prepare('physical-glass', current => prepareSceneShaders(renderer, scene, new OrthographicCamera(), current));
    await flush();
    output.resolve();
    await flush();
    expect(observed).toHaveLength(2);
    linear.resolve();
    await flush();
    expect(observed).toHaveLength(3);
    expect(observed[2].side).toBe(BackSide);
    expect(observed[2].front).toBe(FrontSide);
    expect(observed[2].opaque).toBe(DoubleSide);
    expect(observed[2].target!.texture.colorSpace).toBe(LinearSRGBColorSpace);
    expect(observed[2].mapping).toBe(NoToneMapping);
    expect(glass.side).toBe(DoubleSide);
    expect(glass.version).toBe(version + 2);
    expect(renderer.getRenderTarget()).toBeNull();
    expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(gate.draw(render)).toBe(false);
    expect(statuses).not.toContain('ready');
    back.resolve();
    await flush();
    expect(gate.draw(render)).toBe(true);
    expect(statuses.at(-1)).toBe('ready');
    gate.dispose();
  });

  it('skips the back-face variant when native multisampled render-to-texture is available', async () => {
    const { renderer } = rendererHarness(async () => {}, true);
    const glass = new MeshPhysicalMaterial({ transmission: 0.97, side: DoubleSide, transparent: false });
    const version = glass.version;
    const scene = new Scene();
    scene.add(new Mesh(undefined, glass));
    await prepareSceneShaders(renderer, scene, new OrthographicCamera());
    expect(renderer.compileAsync).toHaveBeenCalledTimes(2);
    expect(glass.side).toBe(DoubleSide);
    expect(glass.version).toBe(version);
  });

  it('does not start back-face preparation for a cancelled generation after the ordinary linear phase', async () => {
    const linear = deferred();
    let calls = 0;
    let current = true;
    const { renderer } = rendererHarness(() => ++calls === 1 ? Promise.resolve() : linear.promise);
    const glass = new MeshPhysicalMaterial({ transmission: 0.97, side: DoubleSide, transparent: false });
    const version = glass.version;
    const scene = new Scene();
    scene.add(new Mesh(undefined, glass));
    const pending = prepareSceneShaders(renderer, scene, new OrthographicCamera(), () => current);
    await flush();
    expect(calls).toBe(2);
    current = false;
    linear.resolve();
    await pending;
    expect(calls).toBe(2);
    expect(glass.side).toBe(DoubleSide);
    expect(glass.version).toBe(version);
  });

  it.each(['throw', 'reject'] as const)('restores sides and renderer state after a back-face compilation %s', async outcome => {
    let calls = 0;
    const failure = new Error('back-face shader failed');
    const { renderer } = rendererHarness(() => {
      if (++calls !== 3) return Promise.resolve();
      if (outcome === 'throw') throw failure;
      return Promise.reject(failure);
    });
    const original = new WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(original, 2, 1);
    const dispose = vi.spyOn(WebGLRenderTarget.prototype, 'dispose');
    const glass = new MeshPhysicalMaterial({ transmission: 0.97, side: DoubleSide, transparent: false });
    const scene = new Scene();
    scene.add(new Mesh(undefined, glass));
    try {
      await expect(prepareSceneShaders(renderer, scene, new OrthographicCamera())).rejects.toBe(failure);
      expect(glass.side).toBe(DoubleSide);
      expect(renderer.getRenderTarget()).toBe(original);
      expect(renderer.getActiveCubeFace()).toBe(2);
      expect(renderer.getActiveMipmapLevel()).toBe(1);
      expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally { original.dispose(); }
  });

  it('holds a newer generation in the renderer queue until old back-face polling has finished', async () => {
    const back = deferred();
    let calls = 0;
    let oldCurrent = true;
    const { renderer } = rendererHarness(() => ++calls === 3 ? back.promise : Promise.resolve());
    const scene = new Scene();
    scene.add(new Mesh(undefined, new MeshPhysicalMaterial({ transmission: 0.97, side: DoubleSide, transparent: false })));
    const camera = new OrthographicCamera();
    const old = prepareSceneShaders(renderer, scene, camera, () => oldCurrent);
    await flush();
    expect(calls).toBe(3);
    oldCurrent = false;
    const latest = prepareSceneShaders(renderer, scene, camera);
    await flush();
    expect(calls).toBe(3);
    back.resolve();
    await old;
    await latest;
    expect(calls).toBe(6);
  });
});

describe('scene preparation generations', () => {
  it('does not enter the compiler after disposal between scheduling and its microtask', async () => {
    const compile = vi.fn(async () => {});
    const gate = new ScenePreparationGate(() => {}, () => {}, work => { work(); return () => {}; });
    gate.prepare('discarded-mount', compile);
    gate.dispose();
    await flush();
    expect(compile).not.toHaveBeenCalled();
  });

  it('blocks draw while pending and reports ready only after the first real frame', async () => {
    const compilation = deferred();
    const statuses: string[] = [];
    const invalidate = vi.fn();
    const gate = new ScenePreparationGate(status => statuses.push(status), invalidate);
    const draw = vi.fn();
    gate.prepare('scene-a', () => compilation.promise);
    await flush();
    expect(gate.draw(draw)).toBe(false);
    expect(draw).not.toHaveBeenCalled();
    compilation.resolve();
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(statuses).not.toContain('ready');
    expect(gate.draw(draw)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['loading', 'ready']);
    gate.dispose();
  });

  it('does not prepare another program for camera-only frames with unchanged resources', async () => {
    const compile = vi.fn(async () => {});
    const gate = new ScenePreparationGate(() => {}, () => {});
    const draw = vi.fn();
    gate.prepare('same-environment-and-rigs', compile);
    await flush();
    for (let i = 0; i < 12; i++) {
      gate.prepare('same-environment-and-rigs', compile);
      gate.draw(draw);
    }
    expect(compile).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(12);
    gate.dispose();
  });

  it('ignores an older completion while a newer generation is still pending', async () => {
    const first = deferred();
    const second = deferred();
    const statuses: string[] = [];
    const gate = new ScenePreparationGate(status => statuses.push(status), () => {});
    gate.prepare('old-environment', () => first.promise);
    await flush();
    gate.prepare('new-environment', () => second.promise);
    await flush();
    first.resolve();
    await flush();
    const draw = vi.fn();
    expect(gate.draw(draw)).toBe(false);
    expect(statuses).not.toContain('ready');
    second.resolve();
    await flush();
    expect(gate.draw(draw)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(1);
    gate.dispose();
  });

  it('checks native resources again before accepting completion or drawing', async () => {
    const compilation = deferred();
    const gate = new ScenePreparationGate(() => {}, () => {});
    let resourcesCurrent = true;
    gate.prepare('native-rigs', () => compilation.promise, () => resourcesCurrent);
    await flush();
    resourcesCurrent = false;
    compilation.resolve();
    await flush();
    const draw = vi.fn();
    expect(gate.draw(draw)).toBe(false);
    expect(draw).not.toHaveBeenCalled();
    gate.dispose();
  });

  it('reports a current rejection and suppresses a stale rejection after replacement or disposal', async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const statuses: { status: string; error?: Error }[] = [];
    const gate = new ScenePreparationGate((status, error) => statuses.push({ status, error }), () => {});
    gate.prepare('first', () => first.promise);
    await flush();
    gate.prepare('second', () => second.promise);
    await flush();
    first.reject(new Error('discarded program'));
    await flush();
    expect(statuses.some(item => item.status === 'failed')).toBe(false);
    const failure = new Error('current program rejected');
    second.reject(failure);
    await flush();
    expect(statuses.at(-1)).toEqual({ status: 'failed', error: failure });
    expect(gate.draw(vi.fn())).toBe(false);
    gate.prepare('third', () => third.promise);
    await flush();
    const beforeUnmount = statuses.length;
    gate.dispose();
    third.reject(new Error('unmounted program'));
    await flush();
    expect(statuses).toHaveLength(beforeUnmount);
  });
});
