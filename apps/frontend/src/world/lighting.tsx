import { memo, useEffect, useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { BackSide, BoxGeometry, Color, DirectionalLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, PointLight, RectAreaLight, Scene, Vector3 } from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { ROOM_FINISHES } from './finishes';
import { deferSceneWork } from './deferredSceneWork';
import { SHADOW_ONLY_LAYER } from './wallOcclusion';

const practicalLights = [
  { at: [-8.7, 2.0, -4.68] as const, color: '#f2ba83', night: 6.2, day: 0.55, distance: 4.1 },
  { at: [-3.71, 2.0, -5.88] as const, color: '#edb581', night: 4.4, day: 0.35, distance: 3.6 },
  { at: [-9.4, 2.13, 6.56] as const, color: '#efbd8e', night: 8.3, day: 0.6, distance: 4.2 },
  { at: [0, 1.22, 0] as const, color: '#64c5dd', night: 8.2, day: 1.1, distance: 4.1 },
];

RectAreaLightUniformsLib.init();

// Broad ceiling bounce lights reveal the room surfaces without another shadow pass.
const roomLights = [
  { at: [-7.3, 4.4, -4.0] as const, size: [4.6, 4.2] as const, color: '#f5dcc1', night: 1.85, day: 0.40 },
  { at: [-0.6, 4.6, -5.5] as const, size: [5.5, 3.5] as const, color: '#d1e5eb', night: 1.50, day: 0.38 },
  { at: [2.0, 4.3, -6.0] as const, size: [1.8, 2.5] as const, color: '#f0c7cc', night: 1.90, day: 0.32 },
  { at: [-7.0, 4.4, 1.4] as const, size: [5.0, 4.0] as const, color: '#d1e4ed', night: 1.85, day: 0.40 },
  { at: [7.2, 5.0, -3.5] as const, size: [4.6, 5.8] as const, color: '#d0e2db', night: 1.75, day: 0.40 },
  { at: [-6.2, 4.4, 6.6] as const, size: [5.8, 2.6] as const, color: '#f5dfc8', night: 2.10, day: 0.38 },
  { at: [3.5, 4.4, 5.1] as const, size: [4.7, 4.5] as const, color: '#e3edf0', night: 1.85, day: 0.40 },
  { at: [8.3, 4.5, 5.1] as const, size: [2.6, 4.3] as const, color: '#f2d6bc', night: 2.00, day: 0.38 },
  { at: [0, 5.2, 0] as const, size: [3.8, 3.8] as const, color: '#dcebe6', night: 1.50, day: 0.25 },
];

// The reflection probe is built from the atelier's own coloured surfaces and lamps.
function reflectionRoom(night: boolean) {
  const environment = new Scene();
  environment.background = new Color(night ? '#253746' : '#9aaeba');
  const geometry = new BoxGeometry(1, 1, 1);
  const shell = new Mesh(geometry, new MeshStandardMaterial({ color: night ? '#374b5a' : '#b1c1ca', side: BackSide, roughness: 0.9 }));
  shell.position.set(0, 4.6, 0);
  shell.scale.set(26, 12, 24);
  environment.add(shell);
  const softboxes = [
    { at: [0, 8.5, 1.2], size: [10, 0.035, 5.8], color: '#efe4d5', strength: night ? 1.6 : 2.8 },
    { at: [-10, 4.5, 1.0], size: [0.035, 4.2, 5.2], color: '#e7c69f', strength: night ? 1.25 : 1.5 },
    { at: [5.5, 4.0, -8.0], size: [3.6, 3.5, 0.035], color: '#b7dce9', strength: night ? 1.6 : 1.2 },
    { at: [-3.5, 3.8, -7.0], size: [0.16, 3.4, 0.035], color: '#f6dcae', strength: night ? 1.8 : 0.8 },
    { at: [5.8, 3.8, 0.2], size: [0.035, 3.2, 0.19], color: '#abdce9', strength: night ? 2.0 : 0.8 },
  ];
  for (const softbox of softboxes) {
    const panel = new Mesh(geometry, new MeshBasicMaterial({ color: new Color(softbox.color).multiplyScalar(softbox.strength) }));
    panel.position.set(softbox.at[0], softbox.at[1], softbox.at[2]);
    panel.scale.set(softbox.size[0], softbox.size[1], softbox.size[2]);
    environment.add(panel);
  }
  const rooms = [
    { at: [-7.35, 0.16, -3.95], size: [5.75, 0.1, 5.8], zone: 'product' as const },
    { at: [-0.52, 0.16, -5.55], size: [7.4, 0.1, 4.9], zone: 'architecture' as const },
    { at: [2.0, 0.22, -6.08], size: [2.35, 0.1, 3.9], zone: 'security' as const },
    { at: [-7.05, 0.16, 1.45], size: [6.55, 0.1, 5.65], zone: 'development' as const },
    { at: [7.15, 0.16, -3.6], size: [5.95, 0.1, 7.8], zone: 'devops' as const },
    { at: [7.15, 0.22, -5.6], size: [5.75, 0.1, 3.0], zone: 'research' as const },
    { at: [-6.15, 0.16, 6.55], size: [7.55, 0.1, 3.65], zone: 'meeting' as const },
    { at: [3.55, 0.16, 5.05], size: [5.75, 0.1, 5.85], zone: 'qa' as const },
    { at: [8.25, 0.16, 4.95], size: [3.6, 0.1, 5.85], zone: 'production' as const },
  ];
  for (const room of rooms) {
    const finish = ROOM_FINISHES[room.zone];
    const floor = new Mesh(geometry, new MeshStandardMaterial({ color: finish.floor, roughness: 0.54, metalness: 0.16 }));
    floor.position.set(room.at[0], room.at[1], room.at[2]);
    floor.scale.set(room.size[0], room.size[1], room.size[2]);
    environment.add(floor);
    const wall = new Mesh(geometry, new MeshStandardMaterial({ color: finish.wall, roughness: 0.55, metalness: 0.08 }));
    wall.position.set(room.at[0], 1.8, room.at[2] - room.size[2] / 2);
    wall.scale.set(room.size[0], 3.2, 0.24);
    environment.add(wall);
  }
  for (const practical of practicalLights) {
    const light = new PointLight(practical.color, night ? practical.night : practical.day, practical.distance, 2);
    light.position.set(practical.at[0], practical.at[1], practical.at[2]);
    environment.add(light);
    const emitter = new Mesh(geometry, new MeshBasicMaterial({ color: practical.color }));
    emitter.position.set(practical.at[0], practical.at[1], practical.at[2]);
    emitter.scale.set(practical.at[0] === 0 ? 1.0 : 0.35, 0.025, practical.at[0] === 0 ? 1.0 : 0.35);
    environment.add(emitter);
  }
  for (const room of roomLights) {
    const light = new RectAreaLight(room.color, night ? room.night : room.day, room.size[0], room.size[1]);
    light.position.set(room.at[0], room.at[1], room.at[2]);
    light.rotation.x = -Math.PI / 2;
    environment.add(light);
  }
  const key = new PointLight(night ? '#d0dce1' : '#f2e7d7', night ? 225 : 380, 36, 2);
  key.position.set(-6, 10, 7);
  environment.add(key);
  return { environment, geometry };
}

function AtelierReflections({ night }: { night: boolean }) {
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);
  const invalidate = useThree(state => state.invalidate);
  useEffect(() => {
    const previous = scene.environment;
    let target: ReturnType<PMREMGenerator['fromScene']> | undefined;
    const cancel = deferSceneWork(() => {
      const { environment, geometry } = reflectionRoom(night);
      const generator = new PMREMGenerator(gl);
      target = generator.fromScene(environment, 0.06, 0.1, 45, { position: new Vector3(0, 1.2, 0) });
      scene.environment = target.texture;
      const materials = new Set<MeshBasicMaterial | MeshStandardMaterial>();
      environment.traverse(object => {
        if (object instanceof Mesh && !Array.isArray(object.material) && (object.material instanceof MeshBasicMaterial || object.material instanceof MeshStandardMaterial)) materials.add(object.material);
      });
      for (const material of materials) material.dispose();
      geometry.dispose();
      generator.dispose();
      invalidate();
    });
    return () => {
      cancel();
      if (target) { if (scene.environment === target.texture) scene.environment = previous; target.dispose(); }
    };
  }, [gl, scene, night, invalidate]);
  useLayoutEffect(() => {
    const intensity = scene.environmentIntensity;
    const exposure = gl.toneMappingExposure;
    scene.environmentIntensity = night ? 0.72 : 0.68;
    gl.toneMappingExposure = night ? 0.96 : 1.0;
    scene.traverse(object => {
      if (object instanceof DirectionalLight && object.castShadow) object.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
    });
    // Camera-only cutaways keep the same physical walls in a stable shadow map.
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    invalidate();
    return () => { scene.environmentIntensity = intensity; gl.toneMappingExposure = exposure; };
  }, [night, scene, gl, invalidate]);
  return null;
}

export const AtelierLighting = memo(function AtelierLighting({ night }: { night: boolean }) {
  return <>
    <AtelierReflections night={night} />
    <ambientLight intensity={night ? 0.22 : 0.30} color="#ced9df" />
    <hemisphereLight color="#cadbe3" groundColor="#3f464a" intensity={night ? 0.54 : 0.83} />
    <directionalLight position={[-7, 12, 7]} intensity={night ? 1.30 : 2.8} color={night ? '#c0d2e5' : '#fff0db'}
      castShadow shadow-mapSize={[1536, 1536]} shadow-camera-left={-14} shadow-camera-right={14}
      shadow-camera-top={14} shadow-camera-bottom={-14} shadow-camera-near={0.5}
      shadow-camera-far={45} shadow-bias={-0.00015} shadow-normalBias={0.035} shadow-radius={3.5} />
    <directionalLight position={[-6, 7, -11]} intensity={night ? 0.38 : 0.55} color="#6593bd" />
    {roomLights.map((light, index) => <rectAreaLight key={'room-' + index} position={light.at}
      rotation={[-Math.PI / 2, 0, 0]} width={light.size[0]} height={light.size[1]}
      color={light.color} intensity={night ? light.night : light.day} />)}
    {practicalLights.map((light, index) => <pointLight key={index} position={light.at}
      color={light.color} intensity={night ? light.night : light.day} distance={light.distance} decay={2} />)}
  </>;
});
