import { useCallback, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { OrthographicCamera, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { AgentView, Role, RoleDefinition } from '../../../../packages/contracts';
import type { RigRegistry } from './actorController';
import { fitFactoryCamera, MAX_MAGNIFICATION, MIN_MAGNIFICATION, nextMagnification, projectCameraAnchors } from './camera';
import { avatarPosition, FACTORY_BOUNDS, labelAnchors, roomFocusBounds, type Position3 } from './layout';
import type { ProjectedLabels } from './WorldLabels';
import { OrbitFrameDamping } from './OrbitFrameDamping';

export type CameraCommand = { id: number; type: 'none' | 'in' | 'out' | 'reset' | 'focus' };

export function SceneCamera({ roles, agents, registry, selected, focusRequest, command, onProject, onZoom, reducedMotion }: {
  roles: RoleDefinition[]; agents: AgentView[]; registry: RigRegistry; selected: Role; focusRequest: number;
  command: CameraCommand; onProject: (labels: ProjectedLabels) => void; onZoom: (value: number) => void;
  reducedMotion: boolean;
}) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as OrbitControlsImpl | null;
  const { width, height } = useThree(state => state.size);
  const invalidate = useThree(state => state.invalidate);
  const initialized = useRef(false);
  const view = useRef<'room' | 'overview'>('overview');
  const handledCommand = useRef(0);
  const previousSelection = useRef({ selected, focusRequest });
  const baseAnchors = useRef<Record<string, Position3>>({});
  const head = useRef(new Vector3());
  const definition = roles.find(role => role.role === selected) ?? roles[0];
  const agent = agents.find(item => item.role === selected);
  const location = agent?.location ?? definition?.location ?? 'product';

  useLayoutEffect(() => { baseAnchors.current = labelAnchors(roles, agents); }, [roles, agents]);

  const applyFrame = useCallback((overview: boolean, keepOrientation: boolean, focus?: Position3) => {
    if (!(camera instanceof OrthographicCamera) || !controls || width <= 0 || height <= 0) return;
    const direction: Position3 = keepOrientation
      ? camera.position.clone().sub(controls.target).toArray() : [0.8, 1.1, 1.6];
    const frame = fitFactoryCamera(overview ? FACTORY_BOUNDS : roomFocusBounds(location), { width, height },
      keepOrientation && initialized.current ? camera.zoom : 1, focus, direction);
    camera.left = frame.left;
    camera.right = frame.right;
    camera.top = frame.top;
    camera.bottom = frame.bottom;
    camera.near = frame.near;
    camera.far = frame.far;
    camera.zoom = frame.zoom;
    camera.position.fromArray(frame.position);
    controls.target.fromArray(frame.target);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    controls.update();
    onZoom(camera.zoom);
    invalidate();
  }, [camera, controls, width, height, location, onZoom, invalidate]);

  const focusSelected = useCallback(() => {
    if (!(camera instanceof OrthographicCamera) || !controls || !definition) return;
    // Finish a pending drag before moving the camera to the chosen model.
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
    const rig = registry.rigs.get(selected);
    const position = rig ? rig.labelPosition(head.current).toArray() as Position3 : avatarPosition(definition, agent);
    if (!rig) position[1] += 2.8;
    if (width < 721) {
      view.current = 'room';
      applyFrame(false, true, position);
    } else {
      const shift = new Vector3(...position).sub(controls.target);
      camera.position.add(shift);
      controls.target.fromArray(position);
      camera.lookAt(controls.target);
      camera.updateMatrixWorld(true);
      controls.update();
      invalidate();
    }
  }, [camera, controls, definition, agent, registry, selected, width, applyFrame, invalidate]);

  useLayoutEffect(() => {
    if (!controls || width <= 0 || height <= 0) return;
    const first = !initialized.current;
    if (first) view.current = width < 721 ? 'room' : 'overview';
    const target = first ? undefined : controls.target.toArray() as Position3;
    applyFrame(view.current === 'overview', !first, target);
    initialized.current = true;
  }, [camera, controls, width, height]);

  useLayoutEffect(() => {
    const previous = previousSelection.current;
    if (!initialized.current || !controls) return;
    previousSelection.current = { selected, focusRequest };
    if (previous.selected !== selected || previous.focusRequest !== focusRequest) focusSelected();
  }, [selected, focusRequest, controls, focusSelected]);

  useLayoutEffect(() => {
    if (!initialized.current || !controls || !(camera instanceof OrthographicCamera) || handledCommand.current === command.id) return;
    handledCommand.current = command.id;
    if (command.type === 'reset') {
      view.current = 'overview';
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
      applyFrame(true, false);
    } else if (command.type === 'focus') focusSelected();
    else if (command.type === 'in' || command.type === 'out') {
      camera.zoom = nextMagnification(camera.zoom, command.type);
      camera.updateProjectionMatrix();
      controls.update();
      onZoom(camera.zoom);
      invalidate();
    }
  }, [command, controls, camera, applyFrame, focusSelected, onZoom, invalidate]);

  useFrame(() => {
    if (!initialized.current) return;
    const anchors = { ...baseAnchors.current };
    for (const [role, rig] of registry.rigs) anchors['agent.' + role] = rig.labelPosition(head.current).toArray() as Position3;
    onProject(projectCameraAnchors(anchors, camera, { width, height }));
  });

  return <><OrbitFrameDamping /><OrbitControls makeDefault enableDamping={!reducedMotion} dampingFactor={0.13}
    minPolarAngle={0.18} maxPolarAngle={Math.PI * 0.465} minZoom={MIN_MAGNIFICATION} maxZoom={MAX_MAGNIFICATION}
    rotateSpeed={0.65} zoomSpeed={0.8} panSpeed={0.8}
    onChange={() => { if (camera instanceof OrthographicCamera) onZoom(camera.zoom); }} /></>;
}
