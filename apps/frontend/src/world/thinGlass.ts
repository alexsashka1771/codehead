import type { Material, MeshPhysicalMaterial } from 'three';

/** Thin architectural glass keeps the real scene sharp and reflects most at grazing angles. */
export const shadeThinGlass: Material['onBeforeCompile'] = shader => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
    float atelierFacing = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
    float atelierFresnel = pow(1.0 - atelierFacing, 4.0);
    diffuseColor.a *= 0.045 + 0.55 * atelierFresnel;
    #include <opaque_fragment>
  `);
};

export const thinGlassProgramKey = () => 'atelier-thin-glass-v1';

export function markThinGlass(material: MeshPhysicalMaterial) {
  material.userData.atelierThinGlass = true;
  delete material.userData.atelierGlassCutaway;
  material.needsUpdate = true;
}
