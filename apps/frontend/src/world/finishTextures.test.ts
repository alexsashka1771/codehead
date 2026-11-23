import { describe, expect, it } from 'vitest';
import { LinearMipmapLinearFilter, NoColorSpace, SRGBColorSpace } from 'three';
import { createAtelierTextures } from './finishes';

describe('stable atelier surface textures', () => {
  it('separates display colour from linear height data', () => {
    const textures = createAtelierTextures();
    try {
      for (const key of ['wood', 'stone', 'metal', 'fabric'] as const) {
        expect(textures.color[key].colorSpace).toBe(SRGBColorSpace);
        expect(textures.height[key].colorSpace).toBe(NoColorSpace);
        expect(textures.height[key]).not.toBe(textures.color[key]);
        expect(textures.height[key].image.data).toBe(textures.color[key].image.data);
        expect(textures.height[key].minFilter).toBe(LinearMipmapLinearFilter);
        expect(textures.height[key].generateMipmaps).toBe(true);
      }
    } finally { Object.values(textures.color).forEach(map => map.dispose()); Object.values(textures.height).forEach(map => map.dispose()); textures.woodRoughness.dispose(); }
  });
});
