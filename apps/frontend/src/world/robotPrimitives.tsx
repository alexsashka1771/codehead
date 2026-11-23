import { extend, type ThreeElement, type ThreeElements } from '@react-three/fiber';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

extend({ RoundedBoxGeometry });
declare module '@react-three/fiber' {
  interface ThreeElements { roundedBoxGeometry: ThreeElement<typeof RoundedBoxGeometry> }
}

type Point3 = [number, number, number];
type MeshProps = Omit<ThreeElements['mesh'], 'position'>;
type Finish = {
  color: string;
  glow?: number;
  metalness?: number;
  roughness?: number;
  opacity?: number;
};

// Robot finishes are independent of the architecture's theme and material provider.
export function robotPalette(night: boolean) {
  return {
    enamel: night ? '#dce6e8' : '#cfdee3',
    alloy: night ? '#a9c3d1' : '#99b4c4',
    joint: '#4a6575',
    visor: '#173242',
    paper: '#eef0de',
    ink: '#648493',
  };
}
export type RobotPalette = ReturnType<typeof robotPalette>;

export function Box({ at = [0, 0, 0], size = [1, 1, 1], color, glow = 0,
  metalness = 0.16, roughness = 0.36, opacity = 1, ...props
}: { at?: Point3; size?: Point3 } & Finish & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <boxGeometry args={size} />
    <meshStandardMaterial color={color} metalness={metalness} roughness={roughness}
      emissive={color} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}

/** Low segment count keeps rounded manufactured shells inexpensive and genuinely volumetric. */
export function Rounded({ at = [0, 0, 0], size = [1, 1, 1], radius = 0.08, color, glow = 0,
  metalness = 0.16, roughness = 0.36, opacity = 1, ...props
}: { at?: Point3; size?: Point3; radius?: number } & Finish & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <roundedBoxGeometry args={[...size, 1, radius]} />
    <meshStandardMaterial color={color} metalness={metalness} roughness={roughness}
      emissive={color} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}

export function Cylinder({ at = [0, 0, 0], radius = 0.1, topRadius = radius, height = 0.1, sides = 16,
  color, glow = 0, metalness = 0.16, roughness = 0.36, opacity = 1, ...props
}: { at?: Point3; radius?: number; topRadius?: number; height?: number; sides?: number } & Finish & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <cylinderGeometry args={[topRadius, radius, height, sides]} />
    <meshStandardMaterial color={color} metalness={metalness} roughness={roughness}
      emissive={color} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}

export function Orb({ at = [0, 0, 0], radius = 0.1, sides = 12, rings = 8, thetaLength = Math.PI,
  color, glow = 0, metalness = 0.16, roughness = 0.36, opacity = 1, ...props
}: { at?: Point3; radius?: number; sides?: number; rings?: number; thetaLength?: number } & Finish & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <sphereGeometry args={[radius, sides, rings, 0, Math.PI * 2, 0, thetaLength]} />
    <meshStandardMaterial color={color} metalness={metalness} roughness={roughness}
      emissive={color} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}

export function Ring({ at = [0, 0, 0], radius = 0.1, tube = 0.025, sides = 20, arc = Math.PI * 2,
  color, glow = 0, metalness = 0.52, roughness = 0.32, opacity = 1, ...props
}: { at?: Point3; radius?: number; tube?: number; sides?: number; arc?: number } & Finish & MeshProps) {
  return <mesh position={at} castShadow receiveShadow {...props}>
    <torusGeometry args={[radius, tube, 6, sides, arc]} />
    <meshStandardMaterial color={color} metalness={metalness} roughness={roughness}
      emissive={color} emissiveIntensity={glow} transparent={opacity < 1} opacity={opacity} />
  </mesh>;
}
