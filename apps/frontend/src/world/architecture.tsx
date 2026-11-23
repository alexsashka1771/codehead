import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Group, Matrix4, Mesh, MeshPhysicalMaterial, Vector3 } from 'three';
import type { Location } from '../../../../packages/contracts';
import { ATELIER_ACCENTS, ATELIER_BACKGROUND, ROOM_FINISHES, type SurfaceSpec } from './finishes';
import { BatchedEnvironment, EnvironmentBuilder, type EnvironmentBatch } from './environmentBatch';
import { DECK_HEIGHT, roomFootprints, zonePositions } from './layout';
import { quarterArc, type Point2 } from './primitives';
import { setGlassCutaway, setWallCutaway, wallOccludesPoint } from './wallOcclusion';

type Wall = {
  id: string; zone: Location; path: Point2[]; height: number; normal: Point2; centre: Point2;
  glass?: boolean; ribs?: { from: Point2; to: Point2 }; warm?: boolean;
};

const OUTLINE: Point2[] = [
  [-10.36, -6.72], [-9.72, -7.15], [-4.35, -7.15], [-4.31, -7.91], [-3.82, -8.23],
  [2.72, -8.23], [3.31, -7.54], [9.68, -7.49], [10.38, -6.76], [10.44, 7.38],
  // Short chamfers keep the rounded entrance clear across the full stair width.
  [9.87, 8.14], [0.84, 8.18], [-0.04, 8.18], [-0.04, 7.75], [-0.14, 7.65],
  [-2.26, 7.65], [-2.36, 7.75], [-2.36, 8.71], [-3.02, 8.71],
  [-9.55, 8.71], [-10.43, 7.98], [-10.44, -0.14],
];

const STEEL: SurfaceSpec = { color: '#4b5e67', finish: 'metal', roughness: 0.50, metalness: 0.48 };
const DARK: SurfaceSpec = { color: '#1a2b39', finish: 'metal', roughness: 0.44 };
const SEAM: SurfaceSpec = { color: '#344b59', finish: 'metal', roughness: 0.52 };
const FLOOR_LAYER_GAP = 0.008;

function arc(center: Point2, radius: number, start: number, end: number) {
  return quarterArc(center, radius, start, end, 16);
}

const walls: Wall[] = [
  { id: 'product-rear-corner', zone: 'product', centre: zonePositions.product, normal: [0, -1], height: 3.35, warm: true,
    path: [[-10.02, -5.94], ...arc([-9.19, -5.94], 0.83, Math.PI, Math.PI * 1.5), [-5.25, -6.77], ...arc([-5.25, -6.06], 0.71, Math.PI * 1.5, Math.PI * 2)],
    ribs: { from: [-9.11, -6.66], to: [-5.33, -6.66] } },
  { id: 'product-west-return', zone: 'product', centre: zonePositions.product, normal: [-1, 0], height: 3.35, warm: true,
    path: [[-10.02, -5.94], [-10.02, -1.69]], ribs: { from: [-9.91, -5.8], to: [-9.91, -1.91] } },
  { id: 'product-curved-entry', zone: 'product', centre: zonePositions.product, normal: [1, 0], height: 2.8, glass: true,
    path: [[-4.54, -6.06], [-4.54, -3.65], ...arc([-5.12, -3.65], 0.58, 0, Math.PI / 2)] },
  { id: 'product-front-glazing', zone: 'product', centre: zonePositions.product, normal: [0, 1], height: 2.45, glass: true,
    path: [[-10.02, -1.69], ...arc([-9.39, -1.69], 0.63, Math.PI, Math.PI / 2), [-6.8, -1.06]] },
  { id: 'architecture-rear-gallery', zone: 'architecture', centre: zonePositions.architecture, normal: [0, -1], height: 3.65,
    path: [[-4.12, -7.03], ...arc([-3.4, -7.03], 0.72, Math.PI, Math.PI * 1.5), [0.79, -7.75]],
    ribs: { from: [-3.31, -7.64], to: [0.64, -7.64] } },
  { id: 'architecture-west-return', zone: 'architecture', centre: zonePositions.architecture, normal: [-1, 0], height: 3.65,
    path: [[-4.12, -7.03], [-4.12, -3.73]], ribs: { from: [-4.01, -6.9], to: [-4.01, -3.91] } },
  { id: 'security-burgundy-corner', zone: 'security', centre: zonePositions.security, normal: [0, -1], height: 3.45,
    path: [[0.79, -7.75], [2.28, -7.75], ...arc([2.28, -7.03], 0.72, Math.PI * 1.5, Math.PI * 2)],
    ribs: { from: [0.94, -7.64], to: [2.19, -7.64] } },
  { id: 'security-side-return', zone: 'security', centre: zonePositions.security, normal: [1, 0], height: 3.45,
    path: [[3.0, -7.03], [3.0, -4.31]], ribs: { from: [2.89, -6.87], to: [2.89, -4.47] } },
  { id: 'security-shared-curved-glass', zone: 'security', centre: zonePositions.security, normal: [-1, 0], height: 2.8, glass: true,
    path: [[0.82, -7.61], [0.82, -4.84], ...arc([1.38, -4.84], 0.56, Math.PI, Math.PI / 2), [1.6, -4.28]] },
  { id: 'architecture-glass-vestibule', zone: 'architecture', centre: zonePositions.architecture, normal: [0, 1], height: 2.55, glass: true,
    path: [[-4.12, -3.73], ...arc([-3.54, -3.73], 0.58, Math.PI, Math.PI / 2), [-2.23, -3.15]] },
  { id: 'architecture-glass-east-leaf', zone: 'architecture', centre: zonePositions.architecture, normal: [0, 1], height: 2.55, glass: true,
    path: [[-0.82, -3.15], [0.58, -3.15]] },
  { id: 'research-rear-corner', zone: 'research', centre: zonePositions.research, normal: [0, -1], height: 3.38,
    path: [[4.35, -6.34], ...arc([5.14, -6.34], 0.79, Math.PI, Math.PI * 1.5), [9.32, -7.13], ...arc([9.32, -6.32], 0.81, Math.PI * 1.5, Math.PI * 2)],
    ribs: { from: [5.23, -7.02], to: [9.19, -7.02] } },
  { id: 'devops-east-service-wall', zone: 'devops', centre: [7.15, -3.6], normal: [1, 0], height: 3.24,
    path: [[10.13, -6.32], [10.13, -0.65]], ribs: { from: [10.02, -6.14], to: [10.02, -0.84] } },
  { id: 'devops-west-smoked-leaf', zone: 'devops', centre: zonePositions.devops, normal: [-1, 0], height: 2.7, glass: true,
    path: [[4.24, -4.4], [4.24, -1.72]] },
  { id: 'devops-front-curved-glass', zone: 'devops', centre: zonePositions.devops, normal: [0, 1], height: 2.7, glass: true,
    path: [[4.24, -0.16], ...arc([4.88, -0.16], 0.64, Math.PI, Math.PI / 2), [9.35, 0.48], ...arc([9.35, -0.3], 0.78, Math.PI / 2, 0)] },
  { id: 'development-rear-tool-wall', zone: 'development', centre: zonePositions.development, normal: [0, -1], height: 3.1,
    path: [[-10.12, -0.43], ...arc([-9.42, -0.43], 0.7, Math.PI, Math.PI * 1.5), [-4.5, -1.13], ...arc([-4.5, -0.4], 0.73, Math.PI * 1.5, Math.PI * 2)],
    ribs: { from: [-9.32, -1.02], to: [-4.59, -1.02] } },
  { id: 'development-west-return', zone: 'development', centre: zonePositions.development, normal: [-1, 0], height: 3.1,
    path: [[-10.12, -0.43], [-10.12, 3.32]], ribs: { from: [-10.01, -0.24], to: [-10.01, 3.12] } },
  { id: 'development-east-upper-glass', zone: 'development', centre: zonePositions.development, normal: [1, 0], height: 2.65, glass: true,
    path: [[-3.77, -0.4], [-3.77, 1.32]] },
  { id: 'development-front-lens', zone: 'development', centre: zonePositions.development, normal: [0, 1], height: 2.65, glass: true,
    path: [[-10.12, 3.32], ...arc([-9.42, 3.32], 0.7, Math.PI, Math.PI / 2), [-4.43, 4.02], ...arc([-4.43, 3.36], 0.66, Math.PI / 2, 0)] },
  { id: 'meeting-walnut-corner', zone: 'meeting', centre: zonePositions.meeting, normal: [0, -1], height: 2.85, warm: true,
    path: [[-9.87, 5.52], ...arc([-9.21, 5.52], 0.66, Math.PI, Math.PI * 1.5), [-7.72, 4.86]],
    ribs: { from: [-9.1, 4.97], to: [-7.81, 4.97] } },
  { id: 'meeting-west-return', zone: 'meeting', centre: zonePositions.meeting, normal: [-1, 0], height: 2.85, warm: true,
    path: [[-9.87, 5.52], [-9.87, 7.79]], ribs: { from: [-9.76, 5.72], to: [-9.76, 7.59] } },
  { id: 'meeting-north-glass', zone: 'meeting', centre: zonePositions.meeting, normal: [0, -1], height: 2.65, glass: true,
    path: [[-7.71, 4.86], [-3.12, 4.86], ...arc([-3.12, 5.46], 0.6, Math.PI * 1.5, Math.PI * 2), [-2.52, 5.8]] },
  { id: 'meeting-front-curve', zone: 'meeting', centre: zonePositions.meeting, normal: [0, 1], height: 2.65, glass: true,
    path: [[-9.87, 7.79], ...arc([-9.14, 7.79], 0.73, Math.PI, Math.PI / 2), [-3.24, 8.52], ...arc([-3.24, 7.8], 0.72, Math.PI / 2, 0)] },
  { id: 'qa-north-tempered-wall', zone: 'qa', centre: zonePositions.qa, normal: [0, -1], height: 2.7, glass: true,
    path: [[0.7, 3.02], ...arc([1.43, 3.02], 0.73, Math.PI, Math.PI * 1.5), [6.33, 2.29]] },
  { id: 'qa-west-glass-return', zone: 'qa', centre: zonePositions.qa, normal: [-1, 0], height: 2.7, glass: true,
    path: [[0.7, 4.15], [0.7, 7.1], ...arc([1.47, 7.1], 0.77, Math.PI, Math.PI / 2), [2.54, 7.87]] },
  { id: 'qa-front-tempered-wall', zone: 'qa', centre: zonePositions.qa, normal: [0, 1], height: 2.7, glass: true,
    path: [[2.55, 7.87], [6.45, 7.87]] },
  { id: 'production-copper-corner', zone: 'production', centre: zonePositions.production, normal: [0, -1], height: 2.85, warm: true,
    path: [[8.38, 2.15], [9.24, 2.15], ...arc([9.24, 2.94], 0.79, Math.PI * 1.5, Math.PI * 2)],
    ribs: { from: [8.47, 2.26], to: [9.18, 2.26] } },
  { id: 'production-east-metal-return', zone: 'production', centre: zonePositions.production, normal: [1, 0], height: 2.85,
    path: [[10.03, 2.94], [10.03, 7.08]], ribs: { from: [9.92, 3.11], to: [9.92, 6.91] } },
  { id: 'production-front-curve', zone: 'production', centre: zonePositions.production, normal: [0, 1], height: 2.6, glass: true,
    path: [[6.46, 7.87], [9.24, 7.87], ...arc([9.24, 7.08], 0.79, Math.PI / 2, 0)] },
];

function floor(author: EnvironmentBuilder, points: Point2[], zone: Location, radius: number, lift = 0) {
  const finish = ROOM_FINISHES[zone];
  author.profile([0, DECK_HEIGHT - 0.009 + lift, 0], points, 0.018, radius, {
    color: finish.floor, finish: finish.floorKind, roughness: zone === 'devops' ? 0.59 : undefined,
  }, { castShadow: false },);
}

function timberBoards(author: EnvironmentBuilder, x: number, z: number, width: number, depth: number, colors: string[]) {
  const rows = Math.max(1, Math.floor(depth / 0.52));
  const boardWidth = depth / rows;
  const length = 1.95;
  for (let row = 0; row < rows; row++) {
    const shift = row % 2 ? length * 0.42 : 0;
    for (let column = 0; column < Math.ceil((width + shift) / length); column++) {
      const from = Math.max(-width / 2, -width / 2 + column * length - shift);
      const to = Math.min(width / 2, -width / 2 + (column + 1) * length - shift);
      if (to - from < 0.02) continue;
      const variant = (row * 3 + column) % colors.length;
      author.box([x + (from + to) / 2, DECK_HEIGHT + 0.004, z - depth / 2 + (row + 0.5) * boardWidth],
        [to - from - 0.008, 0.008, boardWidth - 0.012],
        { color: colors[variant], finish: 'wood', roughness: 0.43 + variant * 0.035 }, { castShadow: false });
    }
  }
}

export function buildAtelierDeck(night: boolean): EnvironmentBatch[] {
  const author = new EnvironmentBuilder('shared-atelier-shell');
  author.profile([0, -0.225, 0], OUTLINE, 0.65, 0.66, DARK);
  author.profile([0, 0.076, 0], OUTLINE, 0.062, 0.66, STEEL);
  // Recess the substrate's top; coplanar room finishes otherwise fight for depth.
  author.profile([0, 0.129 - FLOOR_LAYER_GAP / 2, 0], OUTLINE, 0.062 - FLOOR_LAYER_GAP, 0.66,
    { color: '#304653', finish: 'stone', roughness: 0.72 }, { castShadow: false });
  author.ribbon([0, -0.165, 0], [...OUTLINE, OUTLINE[0]], 0.09, 0.075, { color: '#536d7d', roughness: 0.31 }, { castShadow: false });
  floor(author, [[-10.13, -6.91], [-4.47, -6.91], [-4.47, -1.13], [-10.13, -1.13]], 'product', 0.76);
  floor(author, [[-4.22, -7.93], [3.16, -7.93], [3.16, -3.07], [-4.22, -3.07]], 'architecture', 0.73);
  floor(author, [[0.84, -7.77], [3.0, -7.77], [3.0, -4.16], [0.84, -4.16]], 'security', 0.14, FLOOR_LAYER_GAP);
  floor(author, [[4.3, -7.25], [10.2, -7.25], [10.2, 0.58], [4.3, 0.58]], 'devops', 0.77);
  floor(author, [[4.38, -7.14], [10.07, -7.14], [10.07, -4.38], [4.38, -4.38]], 'research', 0.66, FLOOR_LAYER_GAP);
  floor(author, [[-10.15, -1.13], [-3.71, -1.13], [-3.71, 4.16], [-10.15, 4.16]], 'development', 0.74);
  floor(author, [[-9.97, 4.76], [-2.42, 4.76], [-2.42, 8.59], [-9.97, 8.59]], 'meeting', 0.77);
  floor(author, [[0.61, 2.19], [6.48, 2.19], [6.48, 7.99], [0.61, 7.99]], 'qa', 0.73);
  floor(author, [[6.48, 2.08], [10.14, 2.08], [10.14, 7.99], [6.48, 7.99]], 'production', 0.69);
  timberBoards(author, -7.31, -3.97, 4.82, 4.94, ['#9e7756', '#aa805b', '#956e4f', '#a57b54']);
  timberBoards(author, -6.19, 6.67, 6.6, 3.13, ['#a7825f', '#b08a65', '#9e7855', '#a88259']);
  timberBoards(author, 8.3, 5.0, 2.5, 4.8, ['#b18a64', '#bc946b', '#a9825c', '#b68d62']);
  for (const z of [-2.3, 1.95]) {
    author.box([0, DECK_HEIGHT + 0.002, z], [5.1, 0.004, 0.028], SEAM, { castShadow: false });
  }
  author.ribbon([0, DECK_HEIGHT + 0.004, 0], [
    [-2.34, -1.59], ...arc([-1.57, -1.59], 0.77, Math.PI, Math.PI * 1.5),
    [1.57, -2.36], ...arc([1.57, -1.59], 0.77, Math.PI * 1.5, Math.PI * 2), [2.34, 1.27],
    ...arc([1.57, 1.27], 0.77, 0, Math.PI / 2), [-1.57, 2.04], ...arc([-1.57, 1.27], 0.77, Math.PI / 2, Math.PI), [-2.34, -1.59],
  ], 0.024, 0.008, { color: '#6ba5b6', emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.29 : 0.08 }, { castShadow: false });
  for (const wall of walls) {
    const finish = ROOM_FINISHES[wall.zone];
    author.ribbon([0, DECK_HEIGHT + (wall.glass ? 0.072 : 0.235), 0], wall.path, wall.glass ? 0.16 : 0.255,
      wall.glass ? 0.144 : 0.47, { color: wall.glass ? '#334b5b' : finish.wall, finish: wall.glass ? 'metal' : finish.wallKind });
  }
  for (let index = 0; index < 4; index++) {
    const top = DECK_HEIGHT - index * 0.1775;
    const height = top + 0.55;
    author.rounded([-1.2, top - height / 2, 7.82 + index * 0.265], [2.12, height, 0.39], 0.12, STEEL);
    author.box([-1.2, top + 0.003, 7.91 + index * 0.265], [1.92, 0.005, 0.018], { color: '#89a3af' }, { castShadow: false });
  }
  return author.finish();
}

function buildWall(wall: Wall, night: boolean) {
  const author = new EnvironmentBuilder('structural-' + wall.id);
  const finish = ROOM_FINISHES[wall.zone];
  const sill = wall.glass ? 0.16 : 0.47;
  const height = wall.height - sill;
  author.ribbon([0, DECK_HEIGHT + sill + height / 2, 0], wall.path, wall.glass ? 0.046 : 0.255, height,
    wall.glass
      ? { color: wall.zone === 'security' ? '#f3e9ed' : wall.zone === 'meeting' ? '#edf5f4' : '#edf6f8',
        finish: 'glass', glassMode: 'thin', roughness: 0.055 }
      : { color: finish.wall, finish: finish.wallKind, roughness: 0.48 }, { castShadow: !wall.glass, receiveShadow: !wall.glass });
  author.ribbon([0, DECK_HEIGHT + wall.height + 0.012, 0], wall.path, wall.glass ? 0.143 : 0.31, wall.glass ? 0.07 : 0.115,
    STEEL, { castShadow: !wall.glass });
  author.ribbon([0, DECK_HEIGHT + sill + 0.024, 0], wall.path, wall.glass ? 0.12 : 0.285, 0.046, STEEL, { castShadow: false });
  for (const point of [wall.path[0], wall.path[wall.path.length - 1]]) {
    author.box([point[0], DECK_HEIGHT + wall.height / 2, point[1]], [wall.glass ? 0.105 : 0.17, wall.height, wall.glass ? 0.105 : 0.17], STEEL, { castShadow: !wall.glass });
  }
  if (wall.ribs) {
    const { from, to } = wall.ribs;
    const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const count = Math.floor(distance / (wall.warm ? 0.23 : 0.19));
    for (let index = 0; index <= count; index++) {
      const t = index / count;
      const vertical = Math.abs(to[0] - from[0]) < 0.2;
      author.box([from[0] + (to[0] - from[0]) * t, DECK_HEIGHT + 0.57 + (wall.height - 0.72) / 2, from[1] + (to[1] - from[1]) * t],
        vertical ? [0.056, wall.height - 0.72, 0.04] : [0.04, wall.height - 0.72, 0.056],
        { color: finish.rib, finish: finish.wallKind, roughness: 0.52 }, { castShadow: false });
    }
  }
  if (wall.warm || wall.zone === 'architecture') {
    author.ribbon([0, DECK_HEIGHT + wall.height - 0.095, 0], wall.path, 0.029, 0.015,
      { color: wall.warm ? '#bf8b5e' : '#6594aa', emissive: wall.warm ? ATELIER_ACCENTS.amber : ATELIER_ACCENTS.cyan, glow: night ? 0.42 : 0.12 },
      { castShadow: false, receiveShadow: false });
  }
  return author.finish();
}

export function buildAtelierWallBatches(night: boolean) {
  return walls.flatMap(wall => buildWall(wall, night));
}

const CameraWall = memo(function CameraWall({ wall, night, occlusionTarget }: {
  wall: Wall; night: boolean; occlusionTarget?: RefObject<Vector3 | null>;
}) {
  const ref = useRef<Group>(null);
  const camera = useThree(state => state.camera);
  const batches = useMemo(() => buildWall(wall, night), [wall, night]);
  const box = useMemo(() => {
    const bounds = new Box3();
    for (const batch of batches) if (batch.geometry.boundingBox) bounds.union(batch.geometry.boundingBox);
    return bounds;
  }, [batches]);
  const last = useRef(new Vector3(Infinity, 0, Infinity));
  const lastMatrix = useRef(new Matrix4());
  const ready = useRef(false);
  const hidden = useRef(false);
  const lastTarget = useRef(new Vector3(Infinity, Infinity, Infinity));
  const direction = useMemo(() => new Vector3(), []);
  useEffect(() => { last.current.set(Infinity, 0, Infinity); ready.current = false; }, [batches, camera]);
  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    direction.set(camera.position.x - wall.centre[0], 0, camera.position.z - wall.centre[1]).normalize();
    const target = occlusionTarget?.current;
    const targetChanged = target ? target.distanceToSquared(lastTarget.current) > 0.000001 : Number.isFinite(lastTarget.current.x);
    if (ready.current && camera.matrixWorld.equals(lastMatrix.current) && !targetChanged) return;
    ready.current = true;
    lastMatrix.current.copy(camera.matrixWorld);
    last.current.copy(direction);
    if (target) lastTarget.current.copy(target); else lastTarget.current.set(Infinity, Infinity, Infinity);
    const facing = direction.x * wall.normal[0] + direction.z * wall.normal[1];
    const foreground = facing > (hidden.current ? 0.12 : 0.24);
    const blocksModel = !!target && wallOccludesPoint(camera, hidden.current ? box.clone().expandByScalar(0.045) : box, target);
    if (!wall.glass) {
      hidden.current = foreground || blocksModel;
      setWallCutaway(group, hidden.current);
    } else {
      group.traverse(object => {
        if (!(object instanceof Mesh) || !(object.material instanceof MeshPhysicalMaterial)) return;
        const progress = Math.max(0, Math.min(1, (facing + 0.1) / 0.45));
        const fade = progress * progress * (3 - 2 * progress);
        setGlassCutaway(object.material, blocksModel ? 0.34 : 1 - fade * 0.46);
      });
    }
  });
  return <group ref={ref} name={'camera-cutaway-' + wall.id} userData={{ cutaway: true, room: wall.zone }}>
    <BatchedEnvironment batches={batches} />
  </group>;
});

export const AtelierArchitecture = memo(function AtelierArchitecture({ night, selectedLocation, occlusionTarget }: {
  night: boolean; selectedLocation: Location; occlusionTarget?: RefObject<Vector3 | null>;
}) {
  const batches = useMemo(() => buildAtelierDeck(night), [night]);
  const selected = useMemo(() => {
    const [x, z] = zonePositions[selectedLocation];
    const { size, radius, offset } = roomFootprints[selectedLocation];
    const author = new EnvironmentBuilder('selected-logical-zone');
    author.box([x + offset[0], DECK_HEIGHT + 0.009, z + offset[1] + size[1] / 2 - 0.22],
      [Math.max(0.85, size[0] - radius * 1.6), 0.008, 0.036],
      { color: ATELIER_ACCENTS.amber, glow: night ? 0.46 : 0.15 }, { castShadow: false, receiveShadow: false });
    return author.finish();
  }, [selectedLocation, night]);
  return <group name="connected-engineering-atelier">
    <mesh name="unlit-continuous-backdrop" position={[0, -0.55, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => {}}>
      <planeGeometry args={[160, 160]} />
      <meshBasicMaterial color={night ? ATELIER_BACKGROUND.night : ATELIER_BACKGROUND.day} toneMapped={false} />
    </mesh>
    <mesh name="shadow-only-contact-ground" position={[0, -0.547, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow raycast={() => {}}>
      <planeGeometry args={[80, 80]} />
      <shadowMaterial transparent opacity={night ? 0.25 : 0.19} depthWrite={false} />
    </mesh>
    <BatchedEnvironment batches={batches} />
    {walls.map(wall => <CameraWall key={wall.id} wall={wall} night={night} occlusionTarget={occlusionTarget} />)}
    <BatchedEnvironment batches={selected} />
  </group>;
});
