import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { ArrowLeft, Factory, Maximize2, Pause, Play } from 'lucide-react';
import { OrthographicCamera } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Role, RoleDefinition } from '../../../../packages/contracts';
import { fallbackRoles, roleDetails } from '../features/roles';
import { fitFactoryCamera } from './camera';
import { ATELIER_BACKGROUND } from './finishes';
import { AtelierLighting } from './lighting';
import type { Position3 } from './layout';
import { RiggedAgentBot } from './RiggedAgentBot';
import type { AgentRig, RobotClip } from './robotRig';
import { SceneBoundary, SceneFallback } from './SceneFallback';
import { SceneContextGuard } from './SceneContextGuard';
import { ScenePrecompiler } from './ScenePrecompiler';
import type { ScenePreparationStatus } from './shaderPreparation';
import type { RigRegistry } from './actorController';
import { useReducedMotion } from './useReducedMotion';
import { OrbitFrameDamping } from './OrbitFrameDamping';
import { ATELIER_GL_OPTIONS, configureAtelierRenderer, DEFAULT_RENDER_DENSITY, STUDIO_CAMERA_OPTIONS,
  type RenderDensity } from './renderer';

const clips: { id: RobotClip; name: string; description: string }[] = [
  { id: 'idle', name: 'Покой', description: 'Модель в исходной позе.' },
  { id: 'walk', name: 'Ходьба', description: 'Движения ног и рук для переходов между рабочими местами.' },
  { id: 'work', name: 'Работа', description: 'Рабочие жесты выбранной роли.' },
  { id: 'handoff', name: 'Передача', description: 'Просмотр жеста передачи. В фабрике он требует реального события процесса.' },
  { id: 'meeting', name: 'Обсуждение', description: 'Повороты головы и жесты во время обсуждения.' },
  { id: 'blocked', name: 'Блокировка', description: 'Остановка действий и поза ожидания решения.' },
  { id: 'failed', name: 'Сбой', description: 'Завершённая поза остановившейся модели.' },
];
const STUDIO_ORIGIN: Position3 = [0, 0.18, 0];
const STUDIO_BOUNDS = { min: [-1.9, -0.18, -1.9] as const, max: [1.9, 3.7, 1.9] as const };
const ignoreSelection = () => {};

function StudioCamera({ revision, reducedMotion }: { revision: number; reducedMotion: boolean }) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as OrbitControlsImpl | null;
  const { width, height } = useThree(state => state.size);
  const invalidate = useThree(state => state.invalidate);
  useLayoutEffect(() => {
    if (!(camera instanceof OrthographicCamera) || !controls || !width || !height) return;
    controls.enableDamping = false;
    controls.update();
    const frame = fitFactoryCamera(STUDIO_BOUNDS, { width, height }, 1, undefined, [0.55, 0.65, 1.6]);
    camera.position.fromArray(frame.position);
    camera.left = frame.left;
    camera.right = frame.right;
    camera.top = frame.top;
    camera.bottom = frame.bottom;
    camera.near = frame.near;
    camera.far = frame.far;
    camera.zoom = 1;
    controls.target.fromArray(frame.target);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    controls.enableDamping = !reducedMotion;
    controls.update();
    invalidate();
  }, [camera, controls, width, height, revision, reducedMotion, invalidate]);
  return <><OrbitFrameDamping /><OrbitControls makeDefault enableDamping={!reducedMotion} dampingFactor={0.13}
    minPolarAngle={0.18} maxPolarAngle={Math.PI * 0.465} minZoom={0.7} maxZoom={2.3} /></>;
}

function AnimationPlayer({ rig, clip, playing, revision, onFinished }: {
  rig: AgentRig | null; clip: RobotClip; playing: boolean; revision: number; onFinished: () => void;
}) {
  const invalidate = useThree(state => state.invalidate);
  const shadowMap = useThree(state => state.gl.shadowMap);
  const completed = useRef(false);
  const lastFrame = useRef(performance.now() / 1000);
  useLayoutEffect(() => {
    if (!rig) return;
    completed.current = false;
    rig.stop();
    rig.play(clip);
    rig.update(0);
    shadowMap.needsUpdate = true;
    lastFrame.current = performance.now() / 1000;
    invalidate();
  }, [rig, clip, revision, invalidate, shadowMap]);
  useLayoutEffect(() => { if (playing) { lastFrame.current = performance.now() / 1000; invalidate(); } }, [playing, invalidate]);
  useEffect(() => {
    const resume = () => { if (!document.hidden && playing) { lastFrame.current = performance.now() / 1000; invalidate(); } };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [playing, invalidate]);
  useFrame(state => {
    if (!rig || !playing || document.hidden || completed.current) return;
    const now = performance.now() / 1000;
    const active = rig.update(Math.min(1, Math.max(0, now - lastFrame.current)));
    lastFrame.current = now;
    state.gl.shadowMap.needsUpdate = true;
    if (active) state.invalidate();
    else { completed.current = true; onFinished(); }
  }, -0.5);
  return null;
}

const StudioViewport = memo(function StudioViewport({ definition, clip, playing, revision, viewRevision,
  onFinished, onLost, onStatus, reducedMotion }: {
  definition: RoleDefinition; clip: RobotClip; playing: boolean; revision: number; viewRevision: number;
  onFinished: () => void; onLost: () => void; onStatus: (status: ScenePreparationStatus) => void; reducedMotion: boolean;
}) {
  const [rig, setRig] = useState<AgentRig | null>(null);
  const [registry] = useState<RigRegistry>(() => ({ rigs: new Map(), revision: 0 }));
  const registerRig = useCallback((next: AgentRig | null) => {
    if (next) registry.rigs.set(definition.role, next);
    else registry.rigs.delete(definition.role);
    registry.revision++;
    setRig(next);
  }, [definition.role, registry]);
  const [density, setDensity] = useState<RenderDensity>(DEFAULT_RENDER_DENSITY);
  const rendererReady = useCallback((state: RootState) => { setDensity(configureAtelierRenderer(state)); }, []);
  return <Canvas orthographic camera={STUDIO_CAMERA_OPTIONS} frameloop="demand" dpr={density}
    shadows="percentage" gl={ATELIER_GL_OPTIONS} fallback={<SceneFallback />}
    onCreated={rendererReady}>
    <color attach="background" args={[ATELIER_BACKGROUND.night]} />
    <ScenePrecompiler registry={registry} expectedRoles={[definition.role]}
      resourceRevision={'night:' + definition.role + ':' + definition.appearance_id} onStatus={onStatus} />
    <AtelierLighting night />
    <StudioCamera revision={viewRevision} reducedMotion={reducedMotion} />
    <AnimationPlayer rig={rig} clip={clip} playing={playing} revision={revision} onFinished={onFinished} />
    <SceneContextGuard onLost={onLost} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.18, 0]}>
      <planeGeometry args={[120, 120]} /><meshBasicMaterial color={ATELIER_BACKGROUND.night} toneMapped={false} />
    </mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.17, 0]} receiveShadow>
      <planeGeometry args={[120, 120]} /><shadowMaterial transparent opacity={0.30} />
    </mesh>
    <mesh position={[0, -0.02, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[1.62, 1.7, 0.36, 64]} />
      <meshStandardMaterial color="#263d50" metalness={0.62} roughness={0.38} />
    </mesh>
    <mesh position={[0, 0.13, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1.62, 0.024, 8, 64]} />
      <meshStandardMaterial color="#b98a61" metalness={0.7} roughness={0.36} />
    </mesh>
    <RiggedAgentBot definition={definition} selected onSelect={ignoreSelection} night origin={STUDIO_ORIGIN} onRigReady={registerRig} />
  </Canvas>;
});

export default function AnimationStudio() {
  const [role, setRole] = useState<Role>(() => {
    const requested = new URLSearchParams(window.location.search).get('role');
    return fallbackRoles.find(definition => definition.role === requested)?.role ?? 'product_manager';
  });
  const [clip, setClip] = useState<RobotClip>('idle');
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [revision, setRevision] = useState(0);
  const [viewRevision, setViewRevision] = useState(0);
  const [lost, setLost] = useState(false);
  const [preparation, setPreparation] = useState<ScenePreparationStatus>('loading');
  const reducedMotion = useReducedMotion();
  const definition = fallbackRoles.find(item => item.role === role)!;
  const details = roleDetails[role];
  const selectedClip = clips.find(item => item.id === clip)!;
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.delete('view');
  returnUrl.searchParams.set('role', role);
  const returnHref = returnUrl.pathname + returnUrl.search;
  const handleFinished = useCallback(() => { setPlaying(false); setFinished(true); }, []);
  const handleLost = useCallback(() => { setLost(true); setPlaying(false); setPreparation('failed'); }, []);

  function chooseRole(next: Role) {
    if (next !== role) setPreparation('loading');
    setRole(next);
    setRevision(value => value + 1);
    setFinished(false);
    setPlaying(clip !== 'idle');
    const url = new URL(window.location.href);
    url.searchParams.set('role', next);
    window.history.replaceState(null, '', url.pathname + url.search);
  }
  function chooseClip(next: RobotClip) {
    setClip(next);
    setRevision(value => value + 1);
    setFinished(false);
    setPlaying(next !== 'idle');
  }
  function togglePlaying() {
    if (finished) { setRevision(value => value + 1); setFinished(false); }
    setPlaying(value => !value);
  }

  return <div className="app animation-app" data-theme="night">
    <header className="topbar animation-topbar">
      <a className="brand" href={returnHref} aria-label="CodeHead — фабрика разработки"><Factory size={24} /><span>CodeHead</span></a>
      <a className="studio-return" href={returnHref}><ArrowLeft size={16} />Вернуться к фабрике</a>
    </header>
    <main className="animation-workspace">
      <div className="animation-title"><h1>Предпросмотр анимации модели</h1>
        <p>Самостоятельный просмотр клипов. Состояния запуска — в фабрике.</p>
      </div>
      <div className="animation-stage" aria-label="Трёхмерная модель выбранной роли"
        data-scene-state={preparation} aria-busy={preparation === 'loading'}>
        <SceneBoundary>{lost ? <SceneFallback /> : <StudioViewport definition={definition} clip={clip} playing={playing}
          revision={revision} viewRevision={viewRevision} onFinished={handleFinished} onLost={handleLost}
          onStatus={setPreparation} reducedMotion={reducedMotion} />}</SceneBoundary>
        {!lost && preparation === 'loading' && <div className="scene-loading" role="status">Подготавливаем трёхмерный вид…</div>}
      </div>
      <aside className="animation-console" aria-label="Настройки просмотра модели">
        <label className="animation-role-picker"><span>Модель роли</span>
          <select aria-label="Модель роли" value={role} onChange={event => chooseRole(event.target.value as Role)}>
            {fallbackRoles.map(item => <option key={item.role} value={item.role}>{item.name}</option>)}
          </select>
        </label>
        <h2>{definition.name}</h2><p className="studio-role-description">{details.description}</p>
        <div className="animation-clips" role="group" aria-label="Движения модели">
          {clips.map(item => <button key={item.id} type="button" className={clip === item.id ? 'selected' : ''}
            aria-pressed={clip === item.id} disabled={lost} onClick={() => chooseClip(item.id)}>{item.name}</button>)}
        </div>
        <p className="clip-explanation">{selectedClip.description}</p>
        <div className="animation-playback">
          <button type="button" className="button primary" disabled={lost || clip === 'idle'} onClick={togglePlaying}>
            {playing ? <Pause size={16} /> : <Play size={16} />}{playing ? 'Пауза' : 'Воспроизвести'}
          </button>
          <button type="button" className="icon-button" disabled={lost} title="Сбросить вид" aria-label="Сбросить вид"
            onClick={() => setViewRevision(value => value + 1)}><Maximize2 size={18} /></button>
        </div>
        <p className="studio-gesture-help">Перетащите модель для вращения. Колесо меняет масштаб.</p>
      </aside>
    </main>
  </div>;
}
