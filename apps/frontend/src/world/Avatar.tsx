import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { roleDetails } from '../features/roles';
import { Box, Cylinder } from './geometry';
import { avatarPosition } from './layout';

export function Avatar({ definition, agent, selected, onSelect }: { definition: RoleDefinition; agent?: AgentView; selected: boolean; onSelect: () => void }) {
  const role = definition.role;
  const appearance = agent?.appearance_id ?? definition.appearance_id;
  const color = roleDetails[role].color;
  return <group name={appearance} position={avatarPosition(definition, agent)} onClick={(event) => { event.stopPropagation(); if (event.delta < 6) onSelect(); }}>
    {selected ? <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}><ringGeometry args={[0.34, 0.42, 32]} /><meshBasicMaterial color="#e2b56a" /></mesh> : null}
    <Box at={[-0.14, 0.22, 0]} size={[0.19, 0.38, 0.23]} color="#4c5953" /><Box at={[0.14, 0.22, 0]} size={[0.19, 0.38, 0.23]} color="#4c5953" />
    <Box at={[-0.14, 0.065, 0.06]} size={[0.2, 0.11, 0.32]} color="#35463e" /><Box at={[0.14, 0.065, 0.06]} size={[0.2, 0.11, 0.32]} color="#35463e" />
    <Cylinder at={[0, 0.63, 0]} radius={0.3} height={0.54} color={color} sides={8} />
    <Cylinder at={[-0.37, 0.64, 0]} radius={0.085} height={0.43} color={color} sides={8} rotation={[0, 0, -0.12]} />
    <Cylinder at={[0.37, 0.64, 0]} radius={0.085} height={0.43} color={color} sides={8} rotation={[0, 0, 0.12]} />
    <mesh position={[0, 1.08, 0]} castShadow><sphereGeometry args={[0.28, 16, 12]} /><meshStandardMaterial color="#e3c6a0" roughness={0.9} /></mesh>
    <Box at={[-0.092, 1.1, 0.245]} size={[0.039, 0.045, 0.035]} color="#394940" /><Box at={[0.092, 1.1, 0.245]} size={[0.039, 0.045, 0.035]} color="#394940" />
    {role === 'product_manager' ? <><Cylinder at={[0, 1.31, 0]} radius={0.31} height={0.09} color="#91623e" /><Box at={[0.34, 0.58, 0.14]} size={[0.3, 0.34, 0.055]} color="#e2d9b9" /></> : null}
    {role === 'architect' ? <><Cylinder at={[0, 1.32, 0]} radius={0.29} height={0.11} color="#e3dec4" /><Cylinder at={[0.36, 0.62, 0.08]} radius={0.05} height={0.5} color="#eadcc0" /></> : null}
    {role === 'cto' ? <><Box at={[0, 1.29, -0.055]} size={[0.46, 0.18, 0.34]} color="#766858" /><Box at={[0, 0.73, 0.285]} size={[0.1, 0.3, 0.025]} color="#d8c18f" /><Box at={[0, 1.11, 0.27]} size={[0.31, 0.06, 0.025]} color="#58604f" /></> : null}
    {role === 'backend' ? <><Cylinder at={[0, 1.3, -0.018]} radius={0.285} height={0.15} color="#547e86" /><Box at={[0, 1.26, 0.19]} size={[0.42, 0.04, 0.27]} color="#547e86" /></> : null}
    {role === 'frontend' ? <><mesh position={[0.14, 1.28, -0.15]} castShadow><sphereGeometry args={[0.19, 12, 8]} /><meshStandardMaterial color="#755b44" /></mesh><Box at={[-0.2, 0.75, 0.24]} size={[0.07, 0.15, 0.025]} color="#ebd59e" /></> : null}
    {role === 'qa' ? <><Cylinder at={[0, 1.27, -0.015]} radius={0.285} height={0.1} color="#878e68" /><Box at={[0, 1.1, 0.28]} size={[0.37, 0.12, 0.055]} color="#879f92" /><Box at={[0, 1.1, 0.314]} size={[0.3, 0.065, 0.02]} color="#c5d5bf" /></> : null}
    {role === 'devops' ? <><Cylinder at={[0, 1.31, 0]} radius={0.32} height={0.12} color="#c6b580" /><Box at={[0, 0.71, 0.277]} size={[0.065, 0.35, 0.027]} color="#e2d1a1" /><Box at={[-0.21, 0.57, 0.22]} size={[0.07, 0.08, 0.04]} color="#e2d1a1" /></> : null}
  </group>;
}
