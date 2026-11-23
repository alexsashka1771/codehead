import { BackSide, DoubleSide, LinearSRGBColorSpace, Mesh, MeshPhysicalMaterial, NoToneMapping, WebGLRenderTarget,
  type Camera, type Scene, type WebGLRenderer } from 'three';

export type ScenePreparationStatus = 'loading' | 'ready' | 'failed';
export type PreparationScheduler = (work: () => void) => () => void;

const scheduleMicrotask: PreparationScheduler = work => {
  let cancelled = false;
  queueMicrotask(() => { if (!cancelled) work(); });
  return () => { cancelled = true; };
};

type PreparationGeneration = {
  key: string;
  state: 'pending' | 'compiled' | 'failed';
  matches: () => boolean;
  cancelScheduled: () => void;
  presented: boolean;
};

function preparationError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Preparation owns the draw gate, while Fiber keeps running all camera and rig hooks. */
export class ScenePreparationGate {
  private generation: PreparationGeneration | null = null;
  private disposed = false;

  constructor(private readonly onStatus: (status: ScenePreparationStatus, error?: Error) => void,
    private readonly invalidate: () => void, private readonly schedule: PreparationScheduler = scheduleMicrotask) {}

  prepare(key: string, compile: (isCurrent: () => boolean) => Promise<void>, matches: () => boolean = () => true) {
    if (this.disposed || this.generation?.key === key) return;
    this.generation?.cancelScheduled();
    const generation: PreparationGeneration = {
      key, state: 'pending', matches, cancelScheduled: () => {}, presented: false,
    };
    this.generation = generation;
    const isCurrent = () => !this.disposed && this.generation === generation && generation.matches();
    this.onStatus('loading');
    generation.cancelScheduled = this.schedule(() => {
      if (!isCurrent()) return;
      Promise.resolve().then(() => { if (isCurrent()) return compile(isCurrent); }).then(() => {
        if (!isCurrent()) return;
        generation.state = 'compiled';
        this.invalidate();
      }, error => {
        if (!isCurrent()) return;
        generation.state = 'failed';
        this.onStatus('failed', preparationError(error));
      });
    });
  }

  wait() {
    if (this.disposed || !this.generation) return;
    this.generation.cancelScheduled();
    this.generation = null;
    this.onStatus('loading');
  }

  draw(render: () => void): boolean {
    const generation = this.generation;
    if (this.disposed || !generation || generation.state !== 'compiled' || !generation.matches()) return false;
    try {
      render();
    } catch (error) {
      generation.state = 'failed';
      this.onStatus('failed', preparationError(error));
      return false;
    }
    if (!generation.presented) {
      generation.presented = true;
      this.onStatus('ready');
    }
    return true;
  }

  dispose() {
    this.disposed = true;
    this.generation?.cancelScheduled();
    this.generation = null;
  }
}

const rendererPreparations = new WeakMap<WebGLRenderer, Promise<void>>();

function transmissionMaterials(scene: Scene): MeshPhysicalMaterial[] {
  const transmissive = new Set<MeshPhysicalMaterial>();
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof MeshPhysicalMaterial && material.transmission > 0) transmissive.add(material);
    }
  });
  return [...transmissive];
}

function compileLinearVariant(renderer: WebGLRenderer, scene: Scene, camera: Camera,
  backFaces: readonly MeshPhysicalMaterial[] = []): ReturnType<WebGLRenderer['compileAsync']> {
  const target = new WebGLRenderTarget(1, 1, { colorSpace: LinearSRGBColorSpace, depthBuffer: false });
  const originalTarget = renderer.getRenderTarget();
  const originalFace = renderer.getActiveCubeFace();
  const originalLevel = renderer.getActiveMipmapLevel();
  const originalMapping = renderer.toneMapping;
  const originalSides = new Map(backFaces.map(material => [material, material.side]));
  try {
    renderer.setRenderTarget(target);
    renderer.toneMapping = NoToneMapping;
    for (const material of backFaces) { material.side = BackSide; material.needsUpdate = true; }
    return renderer.compileAsync(scene, camera);
  } finally {
    // compileAsync captures each program synchronously; polling needs neither temporary state nor target.
    for (const [material, side] of originalSides) { material.side = side; material.needsUpdate = true; }
    renderer.setRenderTarget(originalTarget, originalFace, originalLevel);
    renderer.toneMapping = originalMapping;
    target.dispose();
  }
}

/** Three r187 polls material.currentProgram, so every renderer's variants must be awaited in sequence. */
export function prepareSceneShaders(renderer: WebGLRenderer, scene: Scene, camera: Camera,
  isCurrent: () => boolean = () => true): Promise<void> {
  const previous = rendererPreparations.get(renderer) ?? Promise.resolve();
  const preparation = previous.then(async () => {
    if (!isCurrent()) return;
    await renderer.compileAsync(scene, camera);
    if (!isCurrent()) return;
    const transmissive = transmissionMaterials(scene);
    if (!transmissive.length) return;

    // Native transmission draws opaque surfaces in linear working space without tone mapping.
    await compileLinearVariant(renderer, scene, camera);
    if (!isCurrent()) return;
    const backFaces = transmissive.filter(material => material.side === DoubleSide);
    // r187 adds transmissive back faces when the multisampled render-to-texture path is unavailable.
    if (backFaces.length && !renderer.extensions.has('WEBGL_multisampled_render_to_texture')) {
      await compileLinearVariant(renderer, scene, camera, backFaces);
    }
  });
  // A failed generation is reported to its owner without blocking the next queued generation.
  const settled = preparation.then(() => {}, () => {});
  rendererPreparations.set(renderer, settled);
  void settled.then(() => { if (rendererPreparations.get(renderer) === settled) rendererPreparations.delete(renderer); });
  return preparation;
}
