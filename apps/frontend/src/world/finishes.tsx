import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { DataTexture, DoubleSide, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import type { Location } from '../../../../packages/contracts';
import { markThinGlass, shadeThinGlass, thinGlassProgramKey } from './thinGlass';

export const ATELIER_ACCENTS = { cyan: '#64cce9', amber: '#f3ad73' } as const;
export const ATELIER_BACKGROUND = { night: '#131b29', day: '#d2dce2' } as const;

export type FinishKind = 'wood' | 'stone' | 'metal' | 'paint' | 'fabric' | 'ceramic' | 'glass' | 'rubber';
export type RoomFinish = {
  wall: string; floor: string; rib: string; upholstery: string; edge: string;
  wallKind: FinishKind; floorKind: FinishKind;
};

// Room identity is architectural decoration, independent of planned or agent state.
export const ROOM_FINISHES: Record<Location, RoomFinish> = {
  product: { wall: '#754d35', floor: '#976e4e', rib: '#ad855f', upholstery: '#514236', edge: '#918a78', wallKind: 'wood', floorKind: 'wood' },
  architecture: { wall: '#34596f', floor: '#3a5669', rib: '#6e9aaf', upholstery: '#294356', edge: '#6b8799', wallKind: 'paint', floorKind: 'stone' },
  development: { wall: '#3c647d', floor: '#557f92', rib: '#79a4b5', upholstery: '#263f53', edge: '#7995a6', wallKind: 'paint', floorKind: 'stone' },
  qa: { wall: '#8eabb9', floor: '#a8c3ce', rib: '#c2d6dd', upholstery: '#607e8d', edge: '#99b6c4', wallKind: 'ceramic', floorKind: 'stone' },
  security: { wall: '#843747', floor: '#914858', rib: '#bb6374', upholstery: '#412b34', edge: '#976d79', wallKind: 'paint', floorKind: 'stone' },
  devops: { wall: '#304858', floor: '#3c5362', rib: '#67869a', upholstery: '#2c3c4a', edge: '#607d8d', wallKind: 'paint', floorKind: 'metal' },
  production: { wall: '#916044', floor: '#af8058', rib: '#d0a177', upholstery: '#664736', edge: '#b88b64', wallKind: 'wood', floorKind: 'wood' },
  research: { wall: '#346e58', floor: '#4e8069', rib: '#82ad94', upholstery: '#2c4d52', edge: '#72999b', wallKind: 'paint', floorKind: 'stone' },
  meeting: { wall: '#7e563c', floor: '#9e7755', rib: '#b79069', upholstery: '#746452', edge: '#aa947c', wallKind: 'wood', floorKind: 'wood' },
  core: { wall: '#2f6372', floor: '#284c5b', rib: '#76bac8', upholstery: '#345c6a', edge: '#6aadb9', wallKind: 'glass', floorKind: 'metal' },
};

type FinishTextureKey = 'wood' | 'stone' | 'metal' | 'fabric';
type TextureSet = Record<FinishTextureKey, DataTexture>;
type FinishTextures = { color: TextureSet; height: TextureSet; woodRoughness: DataTexture };
const TextureContext = createContext<FinishTextures | null>(null);

function noise(x: number, y: number) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function texture(kind: FinishTextureKey, width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0.92;
      if (kind === 'wood') {
        const u = x / width * 5;
        const v = y / height * 3;
        const grain = Math.sin(v * 4.5 + Math.sin(u * 0.7) * 0.9 + Math.sin(u * 1.7) * 0.21);
        const fine = Math.sin(v * 16 + Math.sin(u * 1.2) * 0.6);
        const knot = Math.hypot((u - 3.2) * 0.45, (v - 1.6) * 2.0);
        const rings = Math.sin(knot * 9) * Math.exp(-knot * 1.9);
        value = 0.90 + grain * 0.027 + fine * 0.005 + rings * 0.019 + noise(Math.floor(x / 3), Math.floor(y / 3)) * 0.009;
      } else if (kind === 'metal') {
        value = 0.91 + noise(Math.floor(x / 3), Math.floor(y / 4)) * 0.025 + Math.sin(y * 0.38) * 0.004;
      } else if (kind === 'fabric') {
        value = 0.87 + ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 0.025 : 0.005) + noise(x, y) * 0.01;
      } else {
        value = 0.91 + noise(Math.floor(x / 2), Math.floor(y / 2)) * 0.022 + noise(Math.floor(x / 7), Math.floor(y / 7)) * 0.012;
      }
      const offset = (y * width + x) * 4;
      const shade = Math.min(255, Math.max(0, Math.round(value * 255)));
      data[offset] = shade;
      data[offset + 1] = kind === 'wood' ? shade - 3 : shade;
      data[offset + 2] = kind === 'wood' ? shade - 8 : shade;
      data[offset + 3] = 255;
    }
  }
  const result = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  result.colorSpace = SRGBColorSpace;
  result.wrapS = result.wrapT = RepeatWrapping;
  result.magFilter = LinearFilter;
  result.minFilter = LinearMipmapLinearFilter;
  result.generateMipmaps = true;
  result.anisotropy = 8;
  result.needsUpdate = true;
  return result;
}

export function createAtelierTextures(): FinishTextures {
  const color: TextureSet = {
    wood: texture('wood', 256, 256), stone: texture('stone', 128, 128),
    metal: texture('metal', 128, 128), fabric: texture('fabric', 64, 64),
  };
  const height = Object.fromEntries(Object.entries(color).map(([key, map]) => {
    const heightMap = map.clone();
    heightMap.colorSpace = NoColorSpace;
    heightMap.needsUpdate = true;
    return [key, heightMap];
  })) as TextureSet;
  const woodPixels = color.wood.image.data;
  if (!woodPixels) throw new Error('Missing procedural wood texture pixels');
  const data = new Uint8Array(woodPixels.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    const shade = Math.round(255 * Math.min(0.92, Math.max(0.55, 0.68 + (woodPixels[offset] / 255 - 0.87) * 2.2)));
    data[offset] = data[offset + 1] = data[offset + 2] = shade;
    data[offset + 3] = 255;
  }
  const woodRoughness = new DataTexture(data, color.wood.image.width, color.wood.image.height, RGBAFormat, UnsignedByteType);
  woodRoughness.colorSpace = NoColorSpace;
  woodRoughness.wrapS = woodRoughness.wrapT = RepeatWrapping;
  woodRoughness.magFilter = LinearFilter;
  woodRoughness.minFilter = LinearMipmapLinearFilter;
  woodRoughness.generateMipmaps = true;
  woodRoughness.anisotropy = 8;
  woodRoughness.needsUpdate = true;
  return { color, height, woodRoughness };
}

export function AtelierMaterials({ children }: { children: ReactNode }) {
  const textures = useMemo(createAtelierTextures, []);
  useEffect(() => {
    const maps = [...Object.values(textures.color), ...Object.values(textures.height), textures.woodRoughness];
    for (const map of maps) map.needsUpdate = true;
    return () => { for (const map of maps) map.dispose(); };
  }, [textures]);
  return <TextureContext.Provider value={textures}>{children}</TextureContext.Provider>;
}

export type SurfaceSpec = {
  color: string; finish?: FinishKind; roughness?: number; metalness?: number;
  emissive?: string; glow?: number; opacity?: number;
  transmission?: number; thickness?: number;
  glassMode?: 'thin' | 'volume';
};

export function SurfaceMaterial({
  color, finish = 'metal', roughness, metalness, emissive = color, glow = 0, opacity = 1,
  transmission = 0, thickness = 0.045,
  glassMode = 'thin',
}: SurfaceSpec) {
  const textures = useContext(TextureContext);
  if (finish === 'glass' && glassMode === 'thin') return <meshPhysicalMaterial color={color}
    roughness={roughness ?? 0.085} metalness={0} transparent opacity={opacity} side={DoubleSide} depthWrite={false}
    transmission={0}
    envMapIntensity={1.25} clearcoat={0.45} clearcoatRoughness={0.08} ior={1.46}
    emissive={emissive} emissiveIntensity={glow} onBeforeCompile={shadeThinGlass}
    customProgramCacheKey={thinGlassProgramKey} onUpdate={markThinGlass} />;
  if (finish === 'glass') return <meshPhysicalMaterial color={color}
    roughness={roughness ?? 0.085} metalness={0} transparent={transmission === 0}
    opacity={transmission > 0 ? 1 : opacity === 1 ? 0.28 : opacity}
    transmission={transmission} thickness={thickness} ior={1.46} attenuationColor={color} attenuationDistance={3}
    side={DoubleSide} depthWrite={transmission > 0} envMapIntensity={1.25} clearcoat={0.45} clearcoatRoughness={0.08}
    emissive={emissive} emissiveIntensity={glow} />;
  const key = finish === 'wood' ? 'wood' : finish === 'fabric' ? 'fabric' : finish === 'metal' ? 'metal' : 'stone';
  const map = textures?.color[key];
  const bump = textures?.height[key];
  if (finish === 'wood' || finish === 'ceramic') return <meshPhysicalMaterial color={color}
    map={map} bumpMap={bump} bumpScale={finish === 'wood' ? 0.006 : 0.002}
    roughnessMap={finish === 'wood' ? textures?.woodRoughness : undefined}
    roughness={roughness ?? (finish === 'wood' ? 0.48 : 0.29)} metalness={metalness ?? 0.02}
    clearcoat={finish === 'wood' ? 0.22 : 0.5} clearcoatRoughness={finish === 'wood' ? 0.42 : 0.35} envMapIntensity={1.0}
    emissive={emissive} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />;
  if (finish === 'paint') return <meshPhysicalMaterial color={color} map={map} bumpMap={bump} bumpScale={0.001}
    roughness={roughness ?? 0.64} metalness={metalness ?? 0.02} envMapIntensity={1.0}
    clearcoat={0.22} clearcoatRoughness={0.42} emissive={emissive} emissiveIntensity={glow}
    transparent={opacity < 1} opacity={opacity} />;
  return <meshStandardMaterial color={color} map={map} bumpMap={bump}
    bumpScale={finish === 'fabric' ? 0.003 : finish === 'metal' ? 0.002 : 0.004}
    roughness={roughness ?? (finish === 'fabric' || finish === 'rubber' ? 0.94 : finish === 'stone' ? 0.77 : 0.48)}
    metalness={metalness ?? (finish === 'metal' ? 0.48 : 0.02)} envMapIntensity={1.0}
    emissive={emissive} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />;
}
