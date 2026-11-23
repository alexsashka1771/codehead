import { Box3, Camera, Group, Mesh, MeshPhysicalMaterial, OrthographicCamera, Ray, Vector3 } from 'three';

export const SHADOW_ONLY_LAYER = 1;

/** Fade reflections rather than optical transparency; keep the compiled glass features. */
export function setGlassCutaway(material: MeshPhysicalMaterial, visibility: number) {
  const thin = material.userData.atelierThinGlass === true;
  if (!thin && material.transmission <= 0) return;
  const original = material.userData.atelierGlassCutaway ??= {
    transmission: material.transmission, clearcoat: material.clearcoat,
    reflection: material.envMapIntensity, specular: material.specularIntensity, opacity: material.opacity,
  };
  const factor = Math.max(0.02, Math.min(1, visibility));
  material.opacity = thin ? original.opacity * factor : 1;
  if (!thin) material.transmission = 1 - (1 - original.transmission) * factor;
  material.clearcoat = original.clearcoat * factor;
  material.envMapIntensity = original.reflection * factor;
  material.specularIntensity = original.specular * factor;
}

export function wallOccludesPoint(camera: Camera, box: Box3, target: Vector3): boolean {
  if (box.isEmpty()) return false;
  const direction = camera.getWorldDirection(new Vector3());
  let origin = camera.position.clone();
  if (camera instanceof OrthographicCamera) {
    const distance = target.clone().sub(origin).dot(direction);
    origin = target.clone().addScaledVector(direction, -distance);
  } else direction.copy(target).sub(origin).normalize();
  const hit = new Ray(origin, direction).intersectBox(box, new Vector3());
  return !!hit && origin.distanceTo(hit) < origin.distanceTo(target) - 0.02;
}

/** Physical walls remain in the shadow pass when the editor cuts away their view. */
export function setWallCutaway(group: Group, hidden: boolean) {
  group.visible = true;
  group.userData.cutawayHidden = hidden;
  group.traverse(object => {
    if (!(object instanceof Mesh)) return;
    object.layers.set(SHADOW_ONLY_LAYER);
    if (!hidden) object.layers.enable(0);
  });
}
