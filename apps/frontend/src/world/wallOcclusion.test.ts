import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera, Vector3 } from 'three';
import { setGlassCutaway, setWallCutaway, SHADOW_ONLY_LAYER, wallOccludesPoint } from './wallOcclusion';

describe('selected model wall cutaway', () => {
  it('keeps transmissive glass optically transparent without changing shader features during camera cutaway', () => {
    const glass = new MeshPhysicalMaterial({ transmission: 0.97, opacity: 1, clearcoat: 0.45, envMapIntensity: 1.25 });
    const original = { transmission: glass.transmission, clearcoat: glass.clearcoat, reflection: glass.envMapIntensity,
      specular: glass.specularIntensity, version: glass.version };
    try {
      setGlassCutaway(glass, 0.34);
      expect(glass.opacity).toBe(1);
      expect(glass.transmission).toBeGreaterThanOrEqual(original.transmission);
      expect(glass.clearcoat).toBeLessThan(original.clearcoat);
      expect(glass.envMapIntensity).toBeLessThan(original.reflection);
      expect(glass.version).toBe(original.version);
      setGlassCutaway(glass, 0);
      expect(glass.version).toBe(original.version);
      setGlassCutaway(glass, 1);
      expect(glass.transmission).toBe(original.transmission);
      expect(glass.clearcoat).toBe(original.clearcoat);
      expect(glass.envMapIntensity).toBe(original.reflection);
      expect(glass.specularIntensity).toBe(original.specular);
    } finally { glass.dispose(); }
  });

  it('leaves opaque physical frame materials unchanged by a glass cutaway', () => {
    const frame = new MeshPhysicalMaterial({ metalness: 0.7, clearcoat: 0.2 });
    const original = { opacity: frame.opacity, clearcoat: frame.clearcoat, reflection: frame.envMapIntensity, version: frame.version };
    try {
      setGlassCutaway(frame, 0.34);
      expect({ opacity: frame.opacity, clearcoat: frame.clearcoat, reflection: frame.envMapIntensity, version: frame.version }).toEqual(original);
    } finally { frame.dispose(); }
  });

  it('reduces thin glass glare without enabling a filtering transmission pass', () => {
    const glass = new MeshPhysicalMaterial({ transparent: true, opacity: 1, clearcoat: 0.45, envMapIntensity: 1.25 });
    glass.userData.atelierThinGlass = true;
    const version = glass.version;
    try {
      setGlassCutaway(glass, 0.34);
      expect(glass.opacity).toBeLessThan(1);
      expect(glass.opacity).toBeGreaterThan(0);
      expect(glass.transmission).toBe(0);
      expect(glass.version).toBe(version);
      setGlassCutaway(glass, 1);
      expect(glass.opacity).toBe(1);
    } finally { glass.dispose(); }
  });

  it('keeps physical casters visible to the light when the viewing camera cuts them away', () => {
    const group = new Group();
    const wall = new Mesh(new BoxGeometry(2, 3, 0.2), new MeshStandardMaterial());
    wall.castShadow = true;
    group.add(wall);
    const view = new OrthographicCamera();
    const shadow = new OrthographicCamera();
    shadow.layers.enable(SHADOW_ONLY_LAYER);
    try {
      setWallCutaway(group, true);
      expect(group.visible).toBe(true);
      expect(wall.castShadow).toBe(true);
      expect(wall.layers.test(view.layers)).toBe(false);
      expect(wall.layers.test(shadow.layers)).toBe(true);
      setWallCutaway(group, false);
      expect(wall.layers.test(view.layers)).toBe(true);
      expect(wall.layers.test(shadow.layers)).toBe(true);
    } finally { wall.geometry.dispose(); wall.material.dispose(); }
  });

  it('detects a neighbouring studio wall between the actual camera and the selected torso', () => {
    const camera = new OrthographicCamera(-20, 20, 10, -10, 0.1, 200);
    camera.position.set(28.9, 41.4, 58);
    camera.lookAt(0, 1.72, 0.24);
    camera.updateMatrixWorld(true);
    const wall = new Box3(new Vector3(-10.4, 0.16, -1.55), new Vector3(-3.7, 3.65, -1.22));
    expect(wallOccludesPoint(camera, wall, new Vector3(-7.35, 1.55, -3.35))).toBe(true);
    expect(wallOccludesPoint(camera, wall, new Vector3(-7.35, 3.25, -3.35))).toBe(false);
  });

  it('uses parallel viewing rays for off-centre orthographic subjects', () => {
    const camera = new OrthographicCamera(-12, 12, 12, -12, 0.1, 100);
    camera.position.set(0, 10, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const target = new Vector3(7, 1, 0);
    const wall = new Box3(new Vector3(6.8, 3, 4.8), new Vector3(7.2, 4, 5.2));
    expect(wallOccludesPoint(camera, wall, target)).toBe(true);
    const behind = new Box3(new Vector3(6.8, -2, -5.2), new Vector3(7.2, 0, -4.8));
    expect(wallOccludesPoint(camera, behind, target)).toBe(false);
  });
});
