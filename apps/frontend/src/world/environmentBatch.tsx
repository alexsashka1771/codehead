import { useEffect, useRef } from 'react';
import { BufferGeometry, Euler, Matrix4, Quaternion, TorusGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SurfaceMaterial, type SurfaceSpec } from './finishes';
import { environmentAnnulus, environmentBox, environmentCable, environmentProfile, environmentRibbon, environmentRod, environmentRounded, type EnvironmentPoint2, type EnvironmentPoint3 } from './environmentGeometry';

type Point3 = EnvironmentPoint3;
type Point2 = EnvironmentPoint2;
type Placement = { rotation?: Point3; castShadow?: boolean; receiveShadow?: boolean };
export type EnvironmentBatch = { geometry: BufferGeometry; surface: SurfaceSpec; castShadow: boolean; receiveShadow: boolean; name: string };

export class EnvironmentBuilder {
  private source = new Map<string, BufferGeometry>();
  private buckets = new Map<string, { geometries: BufferGeometry[]; surface: SurfaceSpec; castShadow: boolean; receiveShadow: boolean }>();
  private transform = new Matrix4();

  constructor(private name: string) {}

  group(at: Point3, rotation: Point3, author: () => void) {
    const previous = this.transform;
    const matrix = new Matrix4().compose(new Vector3(...at), new Quaternion().setFromEuler(new Euler(...rotation)), new Vector3(1, 1, 1));
    this.transform = previous.clone().multiply(matrix);
    author();
    this.transform = previous;
  }

  private add(key: string, make: () => BufferGeometry, at: Point3, surface: SurfaceSpec, placement: Placement = {}) {
    let source = this.source.get(key);
    if (!source) { source = make(); this.source.set(key, source); }
    const matrix = new Matrix4().compose(new Vector3(...at), new Quaternion().setFromEuler(new Euler(...(placement.rotation ?? [0, 0, 0]))), new Vector3(1, 1, 1));
    const geometry = source.clone().applyMatrix4(this.transform.clone().multiply(matrix));
    geometry.clearGroups();
    const castShadow = placement.castShadow ?? true;
    const receiveShadow = placement.receiveShadow ?? true;
    const materialKey = JSON.stringify([surface.color, surface.finish ?? 'metal', surface.roughness, surface.metalness,
      surface.emissive, surface.glow, surface.opacity, surface.transmission, surface.thickness, surface.glassMode, castShadow, receiveShadow]);
    let bucket = this.buckets.get(materialKey);
    if (!bucket) {
      bucket = { geometries: [], surface, castShadow, receiveShadow };
      this.buckets.set(materialKey, bucket);
    }
    bucket.geometries.push(geometry);
  }

  box(at: Point3, size: Point3, surface: SurfaceSpec, placement?: Placement) {
    this.add('box:' + size.join(','), () => environmentBox(size), at, surface, placement);
  }

  rounded(at: Point3, size: Point3, radius: number, surface: SurfaceSpec, placement?: Placement, bevel = 0.014) {
    this.add('round:' + [...size, radius, bevel].join(','), () => environmentRounded(size, radius, bevel), at, surface, placement);
  }

  profile(at: Point3, points: Point2[], height: number, radius: number, surface: SurfaceSpec, placement?: Placement) {
    this.add('profile:' + JSON.stringify([points, height, radius]), () => environmentProfile(points, height, radius), at, surface, placement);
  }

  ribbon(at: Point3, path: Point2[], thickness: number, height: number, surface: SurfaceSpec, placement?: Placement) {
    this.add('ribbon:' + JSON.stringify([path, thickness, height]), () => environmentRibbon(path, thickness, height), at, surface, placement);
  }

  rod(at: Point3, radius: number, height: number, surface: SurfaceSpec, placement?: Placement, topRadius = radius, sides?: number) {
    this.add('rod:' + [radius, topRadius, height, sides].join(','), () => environmentRod(radius, topRadius, height, sides), at, surface, placement);
  }

  cable(points: Point3[], radius: number, surface: SurfaceSpec) {
    this.add('cable:' + JSON.stringify([points, radius]), () => environmentCable(points, radius), [0, 0, 0], surface, { castShadow: false });
  }

  annulus(at: Point3, outer: number, inner: number, height: number, surface: SurfaceSpec, placement?: Placement, segments = 48) {
    this.add('annulus:' + [outer, inner, height, segments].join(','), () => environmentAnnulus(outer, inner, height, segments), at, surface, placement);
  }

  torus(at: Point3, radius: number, tube: number, surface: SurfaceSpec, placement?: Placement, segments = 48) {
    this.add('torus:' + [radius, tube, segments].join(','), () => new TorusGeometry(radius, tube, 6, segments), at, surface, placement);
  }

  geometry(at: Point3, id: string, make: () => BufferGeometry, surface: SurfaceSpec, placement?: Placement) {
    this.add(id, make, at, surface, placement);
  }

  finish(): EnvironmentBatch[] {
    const batches = Array.from(this.buckets.values()).map((bucket, index) => {
      const geometry = mergeGeometries(bucket.geometries, false);
      if (!geometry) throw new Error('Incompatible indexed environment geometry in ' + this.name);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      for (const part of bucket.geometries) part.dispose();
      return { geometry, surface: bucket.surface, castShadow: bucket.castShadow, receiveShadow: bucket.receiveShadow, name: this.name + '-' + index };
    });
    for (const geometry of this.source.values()) geometry.dispose();
    this.source.clear();
    this.buckets.clear();
    return batches;
  }
}

const ignorePicking = () => {};

export function BatchedEnvironment({ batches }: { batches: EnvironmentBatch[] }) {
  const ownership = useRef({ active: new Set<BufferGeometry>(), pending: new Set<BufferGeometry>(), scheduled: false });
  useEffect(() => {
    const state = ownership.current;
    const geometries = new Set(batches.map(batch => batch.geometry));
    state.active = geometries;
    return () => {
      state.active = new Set();
      for (const geometry of geometries) state.pending.add(geometry);
      if (state.scheduled) return;
      state.scheduled = true;
      queueMicrotask(() => {
        state.scheduled = false;
        const pending = [...state.pending];
        state.pending.clear();
        // StrictMode replay and reused batches retain their live CPU/GPU geometry.
        for (const geometry of pending) if (!state.active.has(geometry)) geometry.dispose();
      });
    };
  }, [batches]);
  return <>{batches.map(batch => <mesh key={batch.name} name={batch.name} geometry={batch.geometry}
    castShadow={batch.castShadow} receiveShadow={batch.receiveShadow} raycast={ignorePicking}
    userData={{ staticEnvironment: true }}>
    <SurfaceMaterial {...batch.surface} />
  </mesh>)}</>;
}
