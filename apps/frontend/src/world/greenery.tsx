import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3,
} from 'three';
import { Cable, Rod, type Point3 } from './primitives';
import { BatchedEnvironment, EnvironmentBuilder } from './environmentBatch';
import { DECK_HEIGHT } from './layout';

function leafGeometry() {
  const vertices: number[] = [];
  const indices: number[] = [];
  const segments = 6;
  for (let row = 0; row <= segments; row++) {
    const t = row / segments;
    const width = Math.max(0.002, Math.pow(Math.sin(Math.PI * t), 0.8) * 0.22);
    const bow = Math.sin(Math.PI * t) * 0.12;
    vertices.push(-width, t, bow * 0.28, 0, t, bow, width * 0.93, t, bow * 0.3);
    if (row < segments) {
      const offset = row * 3;
      indices.push(offset, offset + 3, offset + 1, offset + 1, offset + 3, offset + 4);
      indices.push(offset + 1, offset + 4, offset + 2, offset + 2, offset + 4, offset + 5);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function Foliage({ height, cool }: { height: number; cool: boolean }) {
  const ref = useRef<InstancedMesh>(null);
  const geometry = useMemo(leafGeometry, []);
  const count = 15;
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const matrix = new Matrix4();
    const scale = new Vector3();
    const position = new Vector3();
    const direction = new Vector3();
    const up = new Vector3(0, 1, 0);
    const orientation = new Quaternion();
    const turn = new Quaternion();
    const colors = cool ? ['#467779', '#386061', '#5e8e86', '#719993'] : ['#426752', '#587c5e', '#748d65', '#3b5a46'];
    for (let index = 0; index < count; index++) {
      const angle = index * 2.399963;
      const fraction = index / (count - 1);
      const reach = height * (0.39 + (index % 4) * 0.065);
      position.set(Math.cos(angle) * 0.07, height * (0.28 + fraction * 0.48), Math.sin(angle) * 0.07);
      direction.set(Math.cos(angle) * (0.55 + fraction * 0.3), 0.55 + (index % 3) * 0.2, Math.sin(angle) * 0.7).normalize();
      orientation.setFromUnitVectors(up, direction);
      turn.setFromAxisAngle(up, angle);
      orientation.multiply(turn);
      scale.set(reach * 1.1, reach, reach);
      ref.current.setMatrixAt(index, matrix.compose(position, orientation, scale));
      ref.current.setColorAt(index, new Color(colors[index % colors.length]));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
    ref.current.computeBoundingBox();
    ref.current.computeBoundingSphere();
  }, [height, cool]);
  return <instancedMesh ref={ref} args={[geometry, undefined, count]} castShadow receiveShadow>
    <meshStandardMaterial color="#ffffff" roughness={0.8} metalness={0.02} side={DoubleSide} />
  </instancedMesh>;
}

export function Plant({ at, height = 1.18, radius = 0.29, cool = false, ceramic = '#b8bcb2' }: {
  at: Point3; height?: number; radius?: number; cool?: boolean; ceramic?: string;
}) {
  const potHeight = radius * 1.5;
  return <group position={at} name="ceramic-botanical-planter">
    <Rod at={[0, 0.025, 0]} radius={radius * 0.9} height={0.05} color="#344a52" roughness={0.55} />
    <Rod at={[0, potHeight / 2 + 0.06, 0]} radius={radius * 0.76} topRadius={radius} height={potHeight}
      color={ceramic} finish="ceramic" sides={32} />
    <Rod at={[0, potHeight + 0.045, 0]} radius={radius * 0.85} height={0.016} color="#2c3831" finish="stone" />
    <Rod at={[0, potHeight + 0.04, 0]} radius={radius * 1.005} height={0.04} color={ceramic} finish="ceramic" sides={32} />
    <Rod at={[0, potHeight + 0.064, 0]} radius={radius * 0.86} height={0.015} color="#334037" finish="stone" />
    <group position={[0, potHeight + 0.05, 0]}>
      <Cable points={[[0, 0, 0], [-0.028, height * 0.4, 0.03], [0.015, height * 0.89, 0]]} radius={0.021} color="#566753" />
      <Cable points={[[0, height * 0.24, 0], [0.16, height * 0.43, 0.05], [0.23, height * 0.59, 0.08]]} radius={0.013} color="#61745b" />
      <Foliage height={height} cool={cool} />
    </group>
  </group>;
}

type AtelierPlant = { at: Point3; height: number; radius: number; warm?: boolean };
const atelierPlants: AtelierPlant[] = [
  { at: [-9.42, DECK_HEIGHT, -1.8], height: 1.0, radius: 0.27, warm: true },
  { at: [-3.67, DECK_HEIGHT, -7.12], height: 0.94, radius: 0.25 },
  { at: [-9.79, DECK_HEIGHT, 3.25], height: 1.26, radius: 0.32 },
  { at: [-4.33, DECK_HEIGHT, 3.6], height: 0.82, radius: 0.24 },
  { at: [9.45, DECK_HEIGHT, -0.6], height: 1.17, radius: 0.29 },
  { at: [9.45, DECK_HEIGHT, -5.11], height: 0.97, radius: 0.24 },
  { at: [1.3, DECK_HEIGHT, 7.45], height: 1.13, radius: 0.28 },
  { at: [9.46, DECK_HEIGHT, 6.85], height: 1.12, radius: 0.28, warm: true },
  { at: [-9.38, DECK_HEIGHT, 7.5], height: 1.1, radius: 0.28, warm: true },
  { at: [-0.93, DECK_HEIGHT, 7.6], height: 1.18, radius: 0.3 },
  { at: [3.48, DECK_HEIGHT, -6.63], height: 0.82, radius: 0.23 },
];

function pots() {
  const author = new EnvironmentBuilder('atelier-botanical-vessels');
  for (const plant of atelierPlants) {
    const [x, y, z] = plant.at;
    const h = plant.radius * 1.5;
    const ceramic = { color: plant.warm ? '#9eaa9d' : '#8ea7ac', finish: 'ceramic' as const, roughness: 0.36 };
    author.rod([x, y + h / 2 + 0.04, z], plant.radius * 0.76, h, ceramic, undefined, plant.radius, 24);
    author.rod([x, y + h + 0.035, z], plant.radius * 1.01, 0.05, ceramic, { castShadow: false }, undefined, 24);
    author.rod([x, y + h + 0.065, z], plant.radius * 0.87, 0.012, { color: '#263630', finish: 'stone' }, { castShadow: false }, undefined, 24);
    author.cable([[x, y + h, z], [x - 0.03, y + h + plant.height * 0.4, z + 0.04], [x + 0.015, y + h + plant.height * 0.83, z]], 0.021, { color: '#50695a', finish: 'rubber' });
  }
  return author.finish();
}

export function AtelierGreenery() {
  const geometry = useMemo(leafGeometry, []);
  const vessels = useMemo(pots, []);
  const leaves = useRef<InstancedMesh>(null);
  const perPlant = 13;
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    const mesh = leaves.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const scale = new Vector3();
    const position = new Vector3();
    const direction = new Vector3();
    const up = new Vector3(0, 1, 0);
    const orientation = new Quaternion();
    const turn = new Quaternion();
    const cool = ['#3d686d', '#426e70', '#5c8885', '#6b938a'];
    const warm = ['#4e7055', '#66825c', '#738c68', '#3c6656'];
    for (let plantIndex = 0; plantIndex < atelierPlants.length; plantIndex++) {
      const plant = atelierPlants[plantIndex];
      for (let index = 0; index < perPlant; index++) {
        const angle = index * 2.399963 + plantIndex * 0.45;
        const fraction = index / (perPlant - 1);
        const reach = plant.height * (0.4 + (index % 4) * 0.062);
        position.set(plant.at[0] + Math.cos(angle) * 0.06, plant.at[1] + plant.radius * 1.5 + 0.05 + plant.height * (0.21 + fraction * 0.42), plant.at[2] + Math.sin(angle) * 0.06);
        direction.set(Math.cos(angle) * (0.5 + fraction * 0.32), 0.58 + (index % 3) * 0.21, Math.sin(angle) * 0.76).normalize();
        orientation.setFromUnitVectors(up, direction);
        turn.setFromAxisAngle(up, angle);
        orientation.multiply(turn);
        scale.set(reach * 1.1, reach, reach);
        mesh.setMatrixAt(plantIndex * perPlant + index, matrix.compose(position, orientation, scale));
        mesh.setColorAt(plantIndex * perPlant + index, new Color((plant.warm ? warm : cool)[index % 4]));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }, []);
  return <group name="atelier-living-botany">
    <BatchedEnvironment batches={vessels} />
    <instancedMesh ref={leaves} args={[geometry, undefined, perPlant * atelierPlants.length]} receiveShadow raycast={() => {}} dispose={null}>
      <meshStandardMaterial color="#ffffff" roughness={0.83} metalness={0.02} side={DoubleSide} />
    </instancedMesh>
  </group>;
}
