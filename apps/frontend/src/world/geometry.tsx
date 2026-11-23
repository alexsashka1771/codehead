import type { ThreeElements } from '@react-three/fiber';
import type { RefObject } from 'react';
import type { Vector3 } from 'three';
import type { Location } from '../../../../packages/contracts';
import { AtelierArchitecture } from './architecture';
import { AtelierFurniture } from './furniture';
import { AtelierMaterials } from './finishes';

type Point = [number, number, number];
type Size = [number, number];
type MeshProps = Omit<ThreeElements['mesh'], 'position' | 'scale'>;
type Surface = { color: string; emissive?: string; glow?: number; metalness?: number; roughness?: number; opacity?: number };

export const FACTORY_ACCENTS = { blue: '#25c8ff', orange: '#ff9c45' };

export const ZONE_GLOWS: Record<Location, string> = {
  product: FACTORY_ACCENTS.orange,
  architecture: FACTORY_ACCENTS.blue,
  development: FACTORY_ACCENTS.blue,
  qa: FACTORY_ACCENTS.blue,
  devops: FACTORY_ACCENTS.orange,
  core: FACTORY_ACCENTS.orange,
  security: '#7a8b9c',
  research: '#7a8b9c',
  meeting: '#7a8b9c',
  production: '#7a8b9c',
};

export function factoryPalette(night: boolean) {
  return {
    ground: night ? '#121a24' : '#d4dfe8',
    base: night ? '#151d28' : '#778b9e',
    deck: night ? '#293440' : '#c8d5e0',
    floor: night ? '#34414f' : '#e0e8ef',
    wall: night ? '#303e4c' : '#bacbd9',
    trim: night ? '#566b7f' : '#8299ad',
    frame: '#263442',
    alloy: night ? '#a9bdcc' : '#91a8b9',
    wood: night ? '#ac7957' : '#c8926c',
    paper: '#dce7ef',
  };
}

export function Box({
  at = [0, 0, 0], size = [1, 1, 1], color, emissive = color,
  glow = 0, metalness = 0.35, roughness = 0.55, opacity = 1, ...props
}: { at?: Point; size?: Point } & Surface & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <boxGeometry args={size} />
    <meshStandardMaterial color={color} roughness={roughness} metalness={metalness}
      emissive={emissive} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}

export function Cylinder({
  at = [0, 0, 0], radius = 0.3, topRadius = radius, height = 1, color, sides = 20,
  emissive = color, glow = 0, metalness = 0.45, roughness = 0.45, opacity = 1, ...props
}: { at?: Point; radius?: number; topRadius?: number; height?: number; sides?: number } & Surface & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <cylinderGeometry args={[topRadius, radius, height, sides]} />
    <meshStandardMaterial color={color} metalness={metalness} roughness={roughness}
      emissive={emissive} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}

export function GlowPlane({
  at = [0, 0, 0], size = [1, 1], size2d, color, opacity = 0.3, ...props
}: { at?: Point; size?: Size; size2d?: Size; color: string; opacity?: number } & MeshProps) {
  return <mesh position={at} rotation={[-Math.PI / 2, 0, 0]} {...props}>
    <planeGeometry args={size2d ?? size} />
    <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
  </mesh>;
}

export function FactoryGeometry({ night, selectedLocation, occlusionTarget }: {
  night: boolean; selectedLocation: Location; occlusionTarget?: RefObject<Vector3 | null>;
}) {
  return <AtelierMaterials>
    <group name="factory">
      <AtelierArchitecture night={night} selectedLocation={selectedLocation} occlusionTarget={occlusionTarget} />
      <AtelierFurniture night={night} />
    </group>
  </AtelierMaterials>;
}
