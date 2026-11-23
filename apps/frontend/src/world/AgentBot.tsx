import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { roleDetails } from '../features/roles';
import { Box, Cylinder, Orb, Ring, Rounded, robotPalette, type RobotPalette } from './robotPrimitives';
import { avatarPosition, ROBOT_SCALE } from './layout';
import { resolveAppearance, type ProceduralVariant } from './appearance';

type Props = {
  definition: RoleDefinition;
  agent?: AgentView;
  selected: boolean;
  onSelect: () => void;
  night: boolean;
};
type RobotDetails = { variant: ProceduralVariant; accent: string; shell: string; p: RobotPalette; glow: number };
const metal = { metalness: 0.52, roughness: 0.32 };
const mechanism = { metalness: 0.38, roughness: 0.4 };
const glass = { metalness: 0.24, roughness: 0.18 };

function RobotHead({ variant, accent, shell, p, glow }: RobotDetails) {
  if (variant === 'optic') return <group name="optic-head">
    <Rounded name="head-shell" at={[0, 1.67, 0]} size={[0.61, 0.49, 0.47]} radius={0.14} color={p.enamel} />
    <Rounded name="face-visor" at={[0, 1.67, 0.243]} size={[0.46, 0.33, 0.26]}
      radius={0.11} scale={[1, 1, 0.2]} color={p.visor} {...glass} />
    <Cylinder at={[0, 1.67, 0.273]} radius={0.223} height={0.12} sides={24}
      color={p.alloy} rotation={[Math.PI / 2, 0, 0]} {...metal} />
    <Ring at={[0, 1.67, 0.336]} radius={0.175} tube={0.023} sides={24} color={p.joint} {...mechanism} />
    <Cylinder at={[0, 1.67, 0.337]} radius={0.167} height={0.02} sides={24}
      color={accent} rotation={[Math.PI / 2, 0, 0]} />
    <Cylinder at={[0, 1.67, 0.351]} radius={0.108} height={0.017} sides={24}
      color={p.visor} rotation={[Math.PI / 2, 0, 0]} {...glass} />
    <Orb at={[-0.042, 1.72, 0.364]} radius={0.022} sides={8} rings={6} color={p.paper} scale={[1, 1, 0.3]} />
    {[-0.17, 0.17].map(x => <group key={x}>
      <Cylinder at={[x, 1.98, -0.04]} radius={0.023} height={0.16} sides={12} color={p.alloy} {...metal} />
      <Orb at={[x, 2.06, -0.04]} radius={0.031} sides={8} rings={6} color={accent} />
    </group>)}
  </group>;

  const headWidth = variant === 'projector' ? 0.72 : variant === 'lead' ? 0.65 : 0.62;
  const front = variant === 'interface' ? 0.315 : 0.252;
  return <group name="robot-head">
    {variant === 'interface'
      ? <Orb name="head-shell" at={[0, 1.68, 0]} radius={0.36} sides={20} rings={12}
        scale={[1, 0.88, 0.88]} color={p.enamel} />
      : <Rounded name="head-shell" at={[0, 1.67, 0]} size={[headWidth, variant === 'lead' ? 0.53 : 0.47, 0.5]}
        radius={0.145} color={variant === 'terminal' ? shell : p.enamel} />}
    <Rounded name="face-visor" at={[0, 1.69, front]} size={[variant === 'projector' ? 0.62 : 0.54, 0.225, 0.26]}
      radius={0.105} scale={[1, 1, 0.24]} color={p.visor} {...glass} />
    {variant === 'projector'
      ? <Box at={[0, 1.7, front + 0.034]} size={[0.47, 0.03, 0.006]} color={accent} glow={glow} />
      : [-0.125, 0.125].map(x => <Orb key={x} at={[x, 1.7, front + 0.034]} radius={0.049}
        sides={10} rings={6} scale={[0.8, 0.85, 0.27]} color={accent} glow={glow} />)}
    <Box at={[0, 1.52, 0.243]} size={[0.12, 0.018, 0.018]} color={p.ink} />
    {variant !== 'clipboard' && [-1, 1].map(side => <Cylinder key={side}
      at={[side * (variant === 'interface' ? 0.36 : headWidth / 2 + 0.018), 1.67, -0.02]}
      radius={0.095} height={0.065} sides={16} color={p.alloy} rotation={[0, 0, Math.PI / 2]} {...metal} />)}
    {variant === 'terminal' && [-0.16, 0, 0.16].map(x => <Box key={x}
      at={[x, 1.903, -0.04]} size={[0.055, 0.032, 0.23]} color={p.ink} />)}
  </group>;
}

function Accessories({ variant, accent, shell, p, glow }: RobotDetails) {
  switch (variant) {
    case 'clipboard': return <group name="clipboard-and-headset">
      <group name="joint-head">
        <Ring at={[0, 1.69, -0.02]} radius={0.35} tube={0.034} sides={24} arc={Math.PI} color={p.alloy} />
        {[-0.36, 0.36].map(x => <Cylinder key={x} at={[x, 1.65, -0.02]} radius={0.121}
          height={0.09} sides={20} color={p.joint} rotation={[0, 0, Math.PI / 2]} {...mechanism} />)}
        <Box at={[0.32, 1.51, 0.19]} size={[0.028, 0.025, 0.3]} color={p.alloy} rotation={[0, 0.32, 0]} {...metal} />
        <Orb at={[0.27, 1.51, 0.337]} radius={0.038} sides={10} rings={6} scale={[1.1, 0.7, 0.7]} color={p.joint} {...mechanism} />
      </group>
      <group name="joint-leftWrist" position={[-0.56, 0.99, 0.32]} rotation={[0.06, -0.16, 0.14]}>
        <Rounded size={[0.41, 0.56, 0.1]} radius={0.048} color="#bb8b5e" />
        <Box at={[0, 0, 0.057]} size={[0.33, 0.44, 0.008]} color={p.paper} />
        <Box at={[0, 0.247, 0.057]} size={[0.16, 0.065, 0.024]} color={p.alloy} {...metal} />
        {[0.11, 0.02, -0.07].map((y, index) => <Box key={y} at={[-0.03, y, 0.064]}
          size={[index === 2 ? 0.16 : 0.23, 0.017, 0.006]} color={p.ink} />)}
        <Cylinder at={[0.117, -0.16, 0.064]} radius={0.028} height={0.005} sides={12}
          color={accent} rotation={[Math.PI / 2, 0, 0]} />
      </group>
      <Box name="joint-torso" at={[0.18, 1.26, 0.239]} size={[0.105, 0.035, 0.015]} color={p.paper} />
    </group>;
    case 'projector': return <group name="visor-and-projector">
      <group name="joint-head">
        <Cylinder at={[-0.23, 2.018, -0.03]} radius={0.021} height={0.23} sides={12} color={p.alloy} {...metal} />
        <Orb at={[-0.23, 2.14, -0.03]} radius={0.047} sides={12} rings={8} color={accent} />
        <Cylinder at={[-0.365, 1.66, 0.15]} radius={0.092} height={0.1} sides={16}
          color={p.alloy} rotation={[Math.PI / 2, 0, 0]} {...metal} />
        <Cylinder at={[-0.365, 1.66, 0.207]} radius={0.056} height={0.017} sides={16}
          color={p.visor} rotation={[Math.PI / 2, 0, 0]} {...glass} />
      </group>
      <group name="joint-rightWrist" position={[0.58, 0.99, 0.36]} rotation={[0.08, -0.3, 0.08]}>
        <Rounded at={[0, -0.19, 0]} size={[0.46, 0.07, 0.43]} radius={0.03} color={p.alloy} {...metal} />
        {[-0.19, 0.19].flatMap(x => [-0.19, 0.19].map(z => <Box key={x + '-' + z}
          at={[x, 0.014, z]} size={[0.027, 0.39, 0.027]} color={accent} />))}
        {[-0.19, 0.19].map(z => <group key={z}>
          <Box at={[0, 0.2, z]} size={[0.4, 0.026, 0.026]} color={accent} />
          <Box at={[0, -0.17, z]} size={[0.4, 0.026, 0.026]} color={accent} />
        </group>)}
        <Box at={[0, 0.014, 0]} size={[0.18, 0.32, 0.18]} color={p.paper} />
        <Box at={[0.095, -0.046, 0.04]} size={[0.11, 0.2, 0.2]} color={shell} />
      </group>
      <Box name="joint-torso" at={[0, 1.21, 0.239]} size={[0.31, 0.034, 0.015]} color={accent} />
    </group>;
    case 'lead': return <group name="lead-jacket">
      <Rounded at={[0, 1.13, 0.235]} size={[0.27, 0.48, 0.17]} radius={0.072}
        scale={[1, 1, 0.35]} color={p.paper} />
      <Box at={[0, 1.15, 0.274]} size={[0.066, 0.29, 0.015]} color={accent} />
      {[-1, 1].map(side => <group key={side}>
        <Box at={[side * 0.175, 1.22, 0.255]} size={[0.12, 0.3, 0.04]} color={p.alloy}
          rotation={[0, 0, side * -0.30]} {...metal} />
        <Rounded name={'joint-' + (side < 0 ? 'leftShoulder' : 'rightShoulder')}
          at={[side * 0.41, 1.34, 0]} size={[0.21, 0.105, 0.31]} radius={0.049} color={p.enamel} />
        <Box at={[side * 0.41, 1.4, 0.005]} size={[0.12, 0.018, 0.18]} color={accent} />
      </group>)}
      <Box at={[0.23, 1.04, 0.245]} size={[0.09, 0.022, 0.018]} color={accent} />
    </group>;
    case 'terminal': return <group name="terminal-and-heatsink">
      <Rounded at={[0, 1.1, 0.224]} size={[0.53, 0.36, 0.16]} radius={0.07}
        scale={[1, 1, 0.4]} color={p.enamel} />
      {[0.995, 1.075, 1.155].map(y => <Box key={y} at={[0, y, 0.264]}
        size={[0.37, 0.025, 0.016]} color={p.ink} />)}
      <Box at={[0, 1.255, 0.239]} size={[0.34, 0.023, 0.014]} color={accent} />
      <group name="joint-rightWrist" position={[0.57, 0.98, 0.34]} rotation={[-0.08, -0.2, -0.12]}>
        <Rounded size={[0.52, 0.36, 0.1]} radius={0.048} color={p.alloy} {...metal} />
        <Box at={[0, 0, 0.059]} size={[0.44, 0.27, 0.014]} color={p.visor} {...glass} />
        {[0.075, 0, -0.075].map((y, row) => <Box key={y} at={[-0.018, y, 0.069]}
          size={[row === 1 ? 0.24 : 0.34, 0.016, 0.005]} color={accent} glow={glow} />)}
      </group>
      <Rounded at={[0, 1.1, -0.31]} size={[0.49, 0.57, 0.23]} radius={0.075} color={p.alloy} {...metal} />
      {[-0.13, 0, 0.13].map(x => <Box key={x} at={[x, 1.1, -0.435]}
        size={[0.027, 0.33, 0.015]} color={p.ink} />)}
    </group>;
    case 'interface': return <group name="interface-display">
      <Rounded at={[0, 1.11, 0.244]} size={[0.54, 0.43, 0.18]} radius={0.085}
        scale={[1, 1, 0.37]} color={p.alloy} {...metal} />
      <Box at={[0, 1.11, 0.284]} size={[0.43, 0.33, 0.009]} color={p.paper} />
      <Box at={[0, 1.225, 0.292]} size={[0.35, 0.029, 0.008]} color={p.ink} />
      <Box at={[-0.095, 1.1, 0.292]} size={[0.13, 0.12, 0.008]} color="#91c5b7" />
      <Box at={[0.075, 1.1, 0.292]} size={[0.17, 0.12, 0.008]} color={accent} />
      <Box at={[0, 0.997, 0.292]} size={[0.34, 0.019, 0.008]} color={p.ink} />
      <group name="joint-leftWrist">
        <Cylinder at={[-0.545, 0.96, 0.22]} radius={0.022} height={0.35} sides={12}
          color={p.alloy} rotation={[0, 0, -0.22]} {...metal} />
        <Orb at={[-0.581, 1.14, 0.22]} radius={0.034} sides={8} rings={6} color={accent} />
      </group>
    </group>;
    case 'optic': return <group name="inspection-optic">
      <Box at={[0, 1.1, 0.245]} size={[0.58, 0.055, 0.022]} color={accent} rotation={[0, 0, -0.26]} />
      <group name="joint-leftWrist">
        <Ring at={[-0.57, 1.04, 0.23]} radius={0.144} tube={0.03} sides={24} color={p.alloy} />
        <Cylinder at={[-0.57, 0.81, 0.23]} radius={0.027} height={0.26} sides={12} color={p.joint} {...mechanism} />
        <Cylinder at={[-0.57, 1.04, 0.23]} radius={0.116} height={0.009} sides={20}
          color={accent} opacity={0.28} rotation={[Math.PI / 2, 0, 0]} castShadow={false} receiveShadow={false} {...glass} />
      </group>
      <Rounded name="joint-rightShoulder" at={[0.47, 1.17, 0.04]}
        size={[0.15, 0.18, 0.18]} radius={0.055} color={accent} />
    </group>;
    case 'tools': return <group name="helmet-and-tools">
      <group name="joint-head">
        <Orb at={[0, 1.85, 0]} radius={0.37} sides={20} rings={10}
          thetaLength={Math.PI / 2} scale={[1, 0.58, 0.96]} color={shell} />
        <Cylinder at={[0, 1.849, 0.02]} radius={0.401} height={0.052} sides={24} color={shell} />
        <Rounded at={[0, 1.986, -0.015]} size={[0.063, 0.1, 0.4]} radius={0.025} color={p.paper} />
      </group>
      <Rounded at={[0, 1.11, -0.3]} size={[0.59, 0.6, 0.29]} radius={0.088} color={p.alloy} {...metal} />
      {[-0.345, 0.345].map(x => <Cylinder key={x} at={[x, 1.09, -0.28]} radius={0.077}
        height={0.49} sides={12} color={p.joint} {...mechanism} />)}
      <group name="joint-rightWrist">
        <Cylinder at={[0.58, 0.965, 0.19]} radius={0.031} height={0.43} sides={12}
          color={p.alloy} rotation={[0, 0, -0.13]} {...metal} />
        <Ring at={[0.608, 1.21, 0.19]} radius={0.104} tube={0.039} sides={18}
          arc={Math.PI * 1.55} rotation={[0, 0, Math.PI / 4]} color={p.alloy} />
      </group>
      <group name="joint-leftWrist" position={[-0.56, 0.93, 0.15]}>
        <Rounded size={[0.35, 0.31, 0.28]} radius={0.062} color="#87aabb" />
        <Ring at={[0, 0.181, 0]} radius={0.067} tube={0.018} sides={14} arc={Math.PI} color={p.alloy} />
        <Box at={[0, 0, 0.148]} size={[0.31, 0.025, 0.015]} color={p.alloy} {...metal} />
      </group>
      <Box at={[0, 1.1, 0.24]} size={[0.35, 0.065, 0.02]} color={p.joint} {...mechanism} />
      <Box at={[0, 1.1, 0.254]} size={[0.085, 0.069, 0.012]} color={accent} />
    </group>;
    case 'generic': return null;
  }
}

/** The authoritative pure JSX recipe is shared by fallback and the native skinned asset builder. */
export function AgentBot({ definition, agent, selected, onSelect, night }: Props) {
  const role = definition.role;
  const resolution = resolveAppearance(agent?.appearance_id ?? definition.appearance_id, definition.appearance_id);
  const { variant, accent, shell } = resolution.appearance;
  const p = robotPalette(night);
  const glow = night ? 0.45 : 0.17;
  const wide = variant === 'lead' || variant === 'terminal' || variant === 'tools';
  const bodyWidth = wide ? 0.77 : variant === 'projector' ? 0.58 : 0.65;
  const details = { variant, accent, shell, p, glow };

  return <group name={resolution.appearance.id} position={avatarPosition(definition, agent)}
    userData={{ role, appearance_id: resolution.requestedId, requested_appearance_id: resolution.requestedId,
      resolved_appearance_id: resolution.appearance.id, appearance_source: resolution.source }}
    onClick={event => { event.stopPropagation(); if (event.delta < 6) onSelect(); }}>
    {selected && <mesh name="selection-ring" rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.018, 0]}>
      <ringGeometry args={[0.63, 0.7, 32]} />
      <meshBasicMaterial color={roleDetails[role].color} transparent opacity={0.9} />
    </mesh>}
    <group scale={ROBOT_SCALE} rotation={[0, -0.15, 0]} name={'robot-' + variant}>
      {[-0.19, 0.19].map(x => <group key={x} name="leg">
        <group name={'joint-' + (x < 0 ? 'leftHip' : 'rightHip')}>
          <Cylinder at={[x, 0.6, 0]} radius={0.105} height={0.23} sides={12}
            color={p.joint} rotation={[0, 0, Math.PI / 2]} {...mechanism} />
          <Rounded at={[x, 0.496, 0]} size={[0.215, 0.21, 0.25]} radius={0.07} color={shell} />
        </group>
        <group name={'joint-' + (x < 0 ? 'leftKnee' : 'rightKnee')}>
          <Orb at={[x, 0.38, 0]} radius={0.105} color={p.joint} {...mechanism} />
          <Cylinder at={[x, 0.38, 0.104]} radius={0.077} height={0.028} sides={12}
            color={p.alloy} rotation={[Math.PI / 2, 0, 0]} {...metal} />
          <Rounded at={[x, 0.273, 0]} size={[0.205, 0.2, 0.235]} radius={0.065} color={p.enamel} />
          <Rounded at={[x, 0.13, 0.085]} size={[0.28, 0.18, 0.4]} radius={0.06} color={p.enamel} />
          <Box at={[x, 0.044, 0.085]} size={[0.27, 0.044, 0.33]} color={p.joint} {...mechanism} />
        </group>
      </group>)}
      <Rounded name="joint-root" at={[0, 0.67, 0]} size={[bodyWidth * 0.78, 0.15, 0.38]}
        radius={0.055} color={p.alloy} {...metal} />
      <Rounded name="torso-shell" at={[0, 1.06, 0]} size={[bodyWidth, variant === 'lead' ? 0.72 : 0.64, 0.47]}
        radius={0.13} color={shell} />
      <Box at={[0, 0.758, 0]} size={[bodyWidth * 0.91, 0.05, 0.42]} color={p.joint} {...mechanism} />
      <Cylinder at={[0, 1.44, 0]} radius={0.098} height={0.14} sides={16} color={p.joint} {...mechanism} />
      {[-1, 1].map(side => <group key={side} name="arm" rotation={[0, 0, side * -0.055]}>
        <group name={'joint-' + (side < 0 ? 'leftShoulder' : 'rightShoulder')}>
          <Orb at={[side * (bodyWidth / 2 + 0.055), 1.29, 0]} radius={0.137} color={p.joint} {...mechanism} />
          <Cylinder at={[side * (bodyWidth / 2 + 0.12), 1.29, 0]} radius={0.105} height={0.063} sides={16}
            color={p.alloy} rotation={[0, 0, Math.PI / 2]} {...metal} />
          <Rounded at={[side * (bodyWidth / 2 + 0.13), 1.082, 0.033]} size={[0.2, 0.345, 0.235]}
            radius={0.074} color={variant === 'tools' ? shell : p.enamel} />
        </group>
        <group name={'joint-' + (side < 0 ? 'leftElbow' : 'rightElbow')}>
          <Orb at={[side * (bodyWidth / 2 + 0.13), 0.85, 0.07]} radius={0.105} color={p.joint} {...mechanism} />
          <Rounded at={[side * (bodyWidth / 2 + 0.13), 0.762, 0.105]} size={[0.184, 0.18, 0.215]}
            radius={0.062} color={p.enamel} />
        </group>
        <group name={'joint-' + (side < 0 ? 'leftWrist' : 'rightWrist')}>
          <Cylinder at={[side * (bodyWidth / 2 + 0.13), 0.688, 0.117]} radius={0.085} height={0.042}
            sides={12} color={p.alloy} {...metal} />
          <Orb at={[side * (bodyWidth / 2 + 0.13), 0.641, 0.132]} radius={0.092}
            scale={[1, 0.86, 0.87]} color={p.enamel} />
          <Orb at={[side * (bodyWidth / 2 + 0.2), 0.663, 0.154]} radius={0.036}
            sides={8} rings={6} color={p.enamel} />
        </group>
      </group>)}
      <RobotHead {...details} />
      <Accessories {...details} />
    </group>
  </group>;
}
