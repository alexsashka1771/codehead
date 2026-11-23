import { useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Object3D, Scene, WebGLRenderer } from 'three';
import type { Role } from '../../../../packages/contracts';
import type { RigRegistry } from './actorController';
import { deferSceneWork } from './deferredSceneWork';
import { prepareSceneShaders, ScenePreparationGate, type ScenePreparationStatus } from './shaderPreparation';

type ScenePrecompilerProps = {
  registry: RigRegistry;
  expectedRoles: readonly Role[];
  resourceRevision: string;
  onStatus: (status: ScenePreparationStatus) => void;
};

function attachedToScene(object: Object3D, scene: Scene): boolean {
  for (let parent = object.parent; parent; parent = parent.parent) if (parent === scene) return true;
  return false;
}

function preparationKey(scene: Scene, renderer: WebGLRenderer, cameraLayers: number,
  { registry, expectedRoles, resourceRevision }: ScenePrecompilerProps): string | null {
  if (!scene.environment) return null;
  const roots: string[] = [];
  for (const role of expectedRoles) {
    const rig = registry.rigs.get(role);
    if (!rig || !attachedToScene(rig.root, scene)) return null;
    roots.push(role + ':' + rig.root.uuid);
  }
  return [resourceRevision, scene.environment.uuid, scene.environment.version, roots.join(','),
    cameraLayers, renderer.outputColorSpace, renderer.toneMapping, renderer.shadowMap.enabled, renderer.shadowMap.type].join('|');
}

/** One positive subscriber gates automatic drawing without blocking camera, rig or projection hooks. */
export function ScenePrecompiler(props: ScenePrecompilerProps) {
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);
  const get = useThree(state => state.get);
  const invalidate = useThree(state => state.invalidate);
  const current = useRef<ScenePreparationGate | null>(null);
  const latest = useRef(props);
  const [failure, setFailure] = useState<Error | null>(null);
  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => {
    const gate = new ScenePreparationGate((status, error) => {
      latest.current.onStatus(status);
      if (error) setFailure(error);
    }, invalidate, deferSceneWork);
    current.current = gate;
    latest.current.onStatus('loading');
    return () => { gate.dispose(); if (current.current === gate) current.current = null; };
  }, [gl, scene, invalidate]);

  useFrame(state => {
    const gate = current.current;
    if (!gate) return;
    const key = preparationKey(scene, gl, state.camera.layers.mask, latest.current);
    if (!key) { gate.wait(); return; }
    const matches = () => preparationKey(scene, gl, get().camera.layers.mask, latest.current) === key;
    gate.prepare(key, isCurrent => prepareSceneShaders(gl, scene, get().camera, isCurrent), matches);
    gate.draw(() => gl.render(scene, state.camera));
  }, 1);

  // Canvas bridges render errors to the existing HTML SceneBoundary.
  if (failure) throw failure;
  return null;
}
