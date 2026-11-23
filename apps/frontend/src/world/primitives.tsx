import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { ThreeElements } from '@react-three/fiber';
import { SurfaceMaterial, type SurfaceSpec } from './finishes';
import { environmentCable, environmentProfile, environmentRibbon, environmentRod, environmentRounded } from './environmentGeometry';

export type Point3 = [number, number, number];
export type Point2 = [number, number];

type MeshProps = Omit<ThreeElements['mesh'], 'position' | 'scale' | 'geometry'>;
type SolidProps = SurfaceSpec & MeshProps & { at?: Point3 };

export function RoundedSolid({
  at = [0, 0, 0], size, radius = 0.14, bevel = 0.018, color, finish, roughness, metalness, emissive, glow, opacity, ...props
}: SolidProps & { size: Point3; radius?: number; bevel?: number }) {
  const [width, height, depth] = size;
  const geometry = useMemo(() => environmentRounded([width, height, depth], radius, bevel), [width, height, depth, radius, bevel]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh position={at} geometry={geometry} castShadow receiveShadow {...props}>
    <SurfaceMaterial color={color} finish={finish} roughness={roughness} metalness={metalness} emissive={emissive} glow={glow} opacity={opacity} />
  </mesh>;
}

export function ProfileSolid({
  points, height, radius = 0.3, at = [0, 0, 0], color, finish, roughness, metalness, emissive, glow, opacity, ...props
}: SolidProps & { points: Point2[]; height: number; radius?: number }) {
  const signature = JSON.stringify(points);
  const geometry = useMemo(() => environmentProfile(points, height, radius), [signature, height, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh position={at} geometry={geometry} castShadow receiveShadow {...props}>
    <SurfaceMaterial color={color} finish={finish} roughness={roughness} metalness={metalness} emissive={emissive} glow={glow} opacity={opacity} />
  </mesh>;
}

export function Ribbon({
  path, thickness, height, at = [0, 0, 0], color, finish, roughness, metalness, emissive, glow, opacity, ...props
}: SolidProps & { path: Point2[]; thickness: number; height: number }) {
  const signature = JSON.stringify(path);
  const geometry = useMemo(() => environmentRibbon(path, thickness, height), [signature, thickness, height]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh position={at} geometry={geometry} castShadow receiveShadow {...props}>
    <SurfaceMaterial color={color} finish={finish} roughness={roughness} metalness={metalness} emissive={emissive} glow={glow} opacity={opacity} />
  </mesh>;
}

export function Rod({
  at = [0, 0, 0], radius = 0.1, topRadius = radius, height = 1, color, finish, roughness, metalness, emissive, glow, opacity, sides, ...props
}: SolidProps & { radius?: number; topRadius?: number; height?: number; sides?: number }) {
  const geometry = useMemo(() => environmentRod(radius, topRadius, height, sides), [radius, topRadius, height, sides]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh position={at} geometry={geometry} castShadow receiveShadow {...props}>
    <SurfaceMaterial color={color} finish={finish} roughness={roughness} metalness={metalness} emissive={emissive} glow={glow} opacity={opacity} />
  </mesh>;
}

export function Cable({ points, radius = 0.022, color = '#415460' }: { points: Point3[]; radius?: number; color?: string }) {
  const signature = JSON.stringify(points);
  const geometry = useMemo(() => environmentCable(points, radius), [signature, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry}>
    <SurfaceMaterial color={color} finish="rubber" />
  </mesh>;
}

export type BoxInstance = { at: Point3; size: Point3; rotation?: Point3 };
export function BoxInstances({ boxes, color, finish, roughness, metalness, emissive, glow, castShadow = false }: { boxes: BoxInstance[]; castShadow?: boolean } & SurfaceSpec) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    const rotation = new Quaternion();
    const euler = new Euler();
    boxes.forEach((box, index) => {
      position.set(...box.at);
      scale.set(...box.size);
      euler.set(...(box.rotation ?? [0, 0, 0]));
      rotation.setFromEuler(euler);
      ref.current!.setMatrixAt(index, matrix.compose(position, rotation, scale));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingBox();
    ref.current.computeBoundingSphere();
  }, [boxes]);
  if (!boxes.length) return null;
  return <instancedMesh ref={ref} args={[undefined, undefined, boxes.length]} castShadow={castShadow} receiveShadow>
    <boxGeometry args={[1, 1, 1]} />
    <SurfaceMaterial color={color} finish={finish} roughness={roughness} metalness={metalness} emissive={emissive} glow={glow} />
  </instancedMesh>;
}

export function quarterArc(center: Point2, radius: number, start: number, end: number, steps = 12): Point2[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = start + (end - start) * index / steps;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  });
}
