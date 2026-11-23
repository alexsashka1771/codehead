import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls } from 'three-stdlib';
import { cameraDampingFactor } from './camera';

export function OrbitFrameDamping() {
  const controls = useThree(state => state.controls) as OrbitControls | null;
  useFrame((_state, delta) => {
    if (controls?.enableDamping) controls.dampingFactor = cameraDampingFactor(delta);
  }, -2);
  return null;
}
