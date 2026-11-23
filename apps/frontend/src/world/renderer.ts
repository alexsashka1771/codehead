import { ACESFilmicToneMapping } from 'three';
import type { RootState } from '@react-three/fiber';

export type RenderDensity = number | [number, number];
export const DEFAULT_RENDER_DENSITY: RenderDensity = [1, 1.5];
export const ATELIER_GL_OPTIONS = { antialias: true, powerPreference: 'high-performance' as const, preserveDrawingBuffer: false };
export const FACTORY_CAMERA_OPTIONS = { manual: true, near: 0.1, far: 200, position: [25, 30, 40] as [number, number, number] };
export const STUDIO_CAMERA_OPTIONS = { manual: true, position: [4, 5, 10] as [number, number, number] };

export function configureAtelierRenderer({ gl }: RootState): RenderDensity {
  gl.toneMapping = ACESFilmicToneMapping;
  gl.toneMappingExposure = 0.96;
  gl.transmissionResolutionScale = 0.7;
  const context = gl.getContext();
  const info = context.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(context.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER));
  return /swiftshader|llvmpipe|software rasterizer/i.test(renderer) ? 0.8 : DEFAULT_RENDER_DENSITY;
}
