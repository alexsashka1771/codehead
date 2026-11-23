import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import { cameraDampingFactor, fitFactoryCamera, nextMagnification, projectAnchors, type CameraFrame } from './camera';
import { avatarPosition, FACTORY_BOUNDS, labelAnchors } from './layout';
import { fallbackRoles } from '../features/roles';

function threeCamera(frame: CameraFrame) {
  const camera = new OrthographicCamera(frame.left, frame.right, frame.top, frame.bottom, frame.near, frame.far);
  camera.position.set(...frame.position);
  camera.lookAt(...frame.target);
  camera.zoom = frame.zoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

function corners(bounds = FACTORY_BOUNDS) {
  return [bounds.min[0], bounds.max[0]].flatMap(x =>
    [bounds.min[1], bounds.max[1]].flatMap(y =>
      [bounds.min[2], bounds.max[2]].map(z => new Vector3(x, y, z))));
}

describe('factory camera framing', () => {
  it('settles camera inertia in the same elapsed time at slow and fast frame rates', () => {
    const remaining = (frames: number, seconds: number) => {
      let residual = 1;
      for (let index = 0; index < frames; index++) residual *= 1 - cameraDampingFactor(seconds / frames);
      return residual;
    };
    expect(remaining(36, 0.6)).toBeCloseTo(remaining(3, 0.6), 8);
    expect(cameraDampingFactor(1 / 60)).toBeCloseTo(0.13, 2);
    expect(cameraDampingFactor(0.68)).toBeGreaterThan(0.99);
  });

  it('preserves the orbit direction when fitting a resized viewport', () => {
    const direction = [-1.4, 1.1, -0.8] as const;
    const viewport = { width: 430, height: 700 };
    const frame = fitFactoryCamera(FACTORY_BOUNDS, viewport, 1, undefined, direction);
    const actualDirection = new Vector3(...frame.position).sub(new Vector3(...frame.target)).normalize();
    expect(actualDirection.distanceTo(new Vector3(...direction).normalize())).toBeLessThan(1e-6);
    for (const corner of corners()) {
      const projected = corner.project(threeCamera(frame));
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.94);
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(0.94);
    }
  });

  it.each([
    { width: 1366, height: 600 },
    { width: 1920, height: 920 },
    { width: 430, height: 600 },
  ])('fits every board and equipment corner in a $width × $height viewport', viewport => {
    const frame = fitFactoryCamera(FACTORY_BOUNDS, viewport);
    const camera = threeCamera(frame);
    for (const corner of corners()) {
      const projected = corner.clone().project(camera);
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.94);
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(0.94);
      expect(projected.z).toBeGreaterThanOrEqual(-1);
      expect(projected.z).toBeLessThanOrEqual(1);
    }
    const horizontalUnit = new Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
    const verticalUnit = new Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
    const origin = new Vector3(...frame.target).project(camera);
    const horizontal = new Vector3(...frame.target).add(horizontalUnit).project(camera);
    const vertical = new Vector3(...frame.target).add(verticalUnit).project(camera);
    expect(Math.abs(horizontal.x - origin.x) * viewport.width).toBeCloseTo(Math.abs(vertical.y - origin.y) * viewport.height, 5);
  });

  it('centres an offset factory instead of assuming a board at the origin', () => {
    const offset = new Vector3(31, 4, -19);
    const translated = {
      min: [FACTORY_BOUNDS.min[0] + offset.x, FACTORY_BOUNDS.min[1] + offset.y, FACTORY_BOUNDS.min[2] + offset.z] as const,
      max: [FACTORY_BOUNDS.max[0] + offset.x, FACTORY_BOUNDS.max[1] + offset.y, FACTORY_BOUNDS.max[2] + offset.z] as const,
    };
    const viewport = { width: 1366, height: 600 };
    const camera = threeCamera(fitFactoryCamera(translated, viewport));
    for (const corner of corners()) {
      const projected = corner.add(offset).project(camera);
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(0.94);
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(0.94);
    }
  });

  it('makes equipment larger on zoom in and smaller on zoom out', () => {
    const viewport = { width: 1366, height: 600 };
    const anchors = { left: [-1, 1, 0] as const, right: [1, 1, 0] as const };
    const apparentWidth = (zoom: number) => {
      const points = projectAnchors(anchors, fitFactoryCamera(FACTORY_BOUNDS, viewport, zoom), viewport);
      return Math.hypot(points.right.left - points.left.left, points.right.top - points.left.top);
    };
    const initialWidth = apparentWidth(1);
    expect(apparentWidth(nextMagnification(1, 'in'))).toBeGreaterThan(initialWidth);
    expect(apparentWidth(nextMagnification(1, 'out'))).toBeLessThan(initialWidth);
  });

  it('projects DOM anchors onto the same pixels as the Three camera', () => {
    const viewport = { width: 430, height: 600 };
    const frame = fitFactoryCamera(FACTORY_BOUNDS, viewport, 1.5);
    const anchors = { robot: [2.2, 2.4, -1.3] as const };
    const actual = new Vector3(...anchors.robot).project(threeCamera(frame));
    const projected = projectAnchors(anchors, frame, viewport).robot;
    expect(projected.left).toBeCloseTo((actual.x + 1) * viewport.width / 2, 5);
    expect(projected.top).toBeCloseTo((1 - actual.y) * viewport.height / 2, 5);
  });

  it('focuses a role after the user pans away without changing magnification or projection scale', () => {
    const viewport = { width: 1366, height: 600 };
    const manager = fallbackRoles.find(role => role.role === 'product_manager')!;
    const position = avatarPosition(manager);
    const focus = [position[0], position[1] + 1.35, position[2]] as const;
    const fitted = fitFactoryCamera(FACTORY_BOUNDS, viewport, 2.3);
    const original = { ...fitted,
      position: [fitted.position[0] + 12, fitted.position[1], fitted.position[2]] as const,
      target: [fitted.target[0] + 12, fitted.target[1], fitted.target[2]] as const,
    };
    const originalLabel = projectAnchors(labelAnchors([manager], []), original, viewport)['agent.product_manager'];
    expect(originalLabel.left).toBeLessThan(0);
    const focused = fitFactoryCamera(FACTORY_BOUNDS, viewport, 2.3, focus);
    const projected = projectAnchors({ torso: focus }, focused, viewport).torso;
    expect(projected.left).toBeCloseTo(viewport.width / 2, 5);
    expect(projected.top).toBeCloseTo(viewport.height / 2, 5);
    expect(focused.zoom).toBe(original.zoom);
    expect(focused.right - focused.left).toBe(original.right - original.left);
    expect(focused.top - focused.bottom).toBe(original.top - original.bottom);
  });

  it('resets a magnified camera to the initial full factory view', () => {
    const viewport = { width: 1920, height: 920 };
    const initial = fitFactoryCamera(FACTORY_BOUNDS, viewport);
    const magnified = nextMagnification(nextMagnification(1, 'in'), 'in');
    const reset = fitFactoryCamera(FACTORY_BOUNDS, viewport, nextMagnification(magnified, 'reset'));
    expect(reset).toEqual(initial);
    for (const corner of corners()) {
      expect(corner.clone().project(threeCamera(reset)).toArray()).toEqual(corner.clone().project(threeCamera(initial)).toArray());
    }
  });

  it('bounds repeated zoom commands and still allows reset', () => {
    let zoom = 1;
    for (let step = 0; step < 50; step++) zoom = nextMagnification(zoom, 'in');
    expect(zoom).toBeLessThanOrEqual(2.5);
    expect(zoom).toBeGreaterThan(1);
    for (let step = 0; step < 100; step++) zoom = nextMagnification(zoom, 'out');
    expect(zoom).toBeGreaterThanOrEqual(0.5);
    expect(zoom).toBeLessThan(1);
    expect(nextMagnification(zoom, 'reset')).toBe(1);
  });
});
