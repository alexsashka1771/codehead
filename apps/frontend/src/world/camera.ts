import { Camera, OrthographicCamera, Vector3 } from 'three';

type Point3 = readonly [number, number, number];
export type CameraBounds = { min: Point3; max: Point3 };
export type ViewportSize = { width: number; height: number };
export type CameraFrame = {
  position: Point3;
  target: Point3;
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
  zoom: number;
};

export const MIN_MAGNIFICATION = 0.7;
export const MAX_MAGNIFICATION = 2.3;

export function cameraDampingFactor(deltaSeconds: number): number {
  const elapsed = Math.min(0.75, Math.max(0.001, Number.isFinite(deltaSeconds) ? deltaSeconds : 1 / 60));
  return 1 - Math.exp(-elapsed / 0.12);
}

export function nextMagnification(current: number, action: 'in' | 'out' | 'reset'): number {
  if (action === 'reset') return 1;
  return Math.min(MAX_MAGNIFICATION, Math.max(MIN_MAGNIFICATION, current * (action === 'in' ? 1.18 : 1 / 1.18)));
}

function cameraFromFrame(frame: CameraFrame) {
  const camera = new OrthographicCamera(frame.left, frame.right, frame.top, frame.bottom, frame.near, frame.far);
  camera.position.set(...frame.position);
  camera.lookAt(...frame.target);
  camera.zoom = frame.zoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

export function fitFactoryCamera(bounds: CameraBounds, viewport: ViewportSize, magnification = 1, focus?: Point3,
  viewDirection: Point3 = [0.8, 1.1, 1.6]): CameraFrame {
  const minimum = new Vector3(...bounds.min);
  const maximum = new Vector3(...bounds.max);
  const target = new Vector3().addVectors(minimum, maximum).multiplyScalar(0.5);
  const diagonal = maximum.clone().sub(minimum).length();
  const distance = diagonal * 2 + 20;
  const position = target.clone().add(new Vector3(...viewDirection).normalize().multiplyScalar(distance));
  const frame: CameraFrame = {
    target: target.toArray() as [number, number, number],
    position: position.toArray() as [number, number, number],
    left: -1,
    right: 1,
    top: 1,
    bottom: -1,
    near: 0.1,
    far: distance + diagonal + 10,
    zoom: 1,
  };
  const camera = cameraFromFrame(frame);
  let halfWidth = 0;
  let halfHeight = 0;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const corner = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        halfWidth = Math.max(halfWidth, Math.abs(corner.x));
        halfHeight = Math.max(halfHeight, Math.abs(corner.y));
      }
    }
  }
  const aspect = Math.max(1, viewport.width) / Math.max(1, viewport.height);
  const fittedHalfHeight = Math.max(halfHeight, halfWidth / aspect, 0.1) * 1.11;
  // Fit the complete factory once; zoom changes magnification, not the fit bounds.
  const fitted: CameraFrame = {
    ...frame,
    left: -fittedHalfHeight * aspect,
    right: fittedHalfHeight * aspect,
    top: fittedHalfHeight,
    bottom: -fittedHalfHeight,
    zoom: Math.min(MAX_MAGNIFICATION, Math.max(MIN_MAGNIFICATION, magnification)),
  };
  if (!focus) return fitted;
  const shift = new Vector3(...focus).sub(new Vector3(...fitted.target));
  return { ...fitted, target: [...focus], position: new Vector3(...fitted.position).add(shift).toArray() as [number, number, number] };
}

export function projectAnchors(anchors: Record<string, Point3>, frame: CameraFrame, viewport: ViewportSize): Record<string, { left: number; top: number }> {
  const camera = cameraFromFrame(frame);
  return projectCameraAnchors(anchors, camera, viewport);
}

export function projectCameraAnchors(anchors: Record<string, Point3>, camera: Camera, viewport: ViewportSize): Record<string, { left: number; top: number }> {
  camera.updateMatrixWorld(true);
  return Object.fromEntries(Object.entries(anchors).map(([id, point]) => {
    const projected = new Vector3(...point).project(camera);
    return [id, { left: (projected.x + 1) * viewport.width / 2, top: (1 - projected.y) * viewport.height / 2 }];
  }));
}
