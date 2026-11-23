import { act } from 'react';
import { createRoot } from '@react-three/fiber';
import type { WebGLRenderer } from 'three';

export async function mountHook<T>(useValue: () => T) {
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1 }) as unknown as HTMLCanvasElement;
  // Use the project's existing React reconciler; the GPU boundary stays idle.
  const renderer = { render() {}, domElement: canvas, setPixelRatio() {}, setSize() {},
    xr: { isPresenting: false, addEventListener() {}, removeEventListener() {} },
  } as unknown as WebGLRenderer;
  const root = createRoot(canvas);
  let value!: T;
  function Probe() { value = useValue(); return null; }
  await root.configure({ gl: renderer, frameloop: 'never', dpr: 1,
    size: { width: 1, height: 1, left: 0, top: 0 } });
  const rerender = () => act(async () => { root.render(<Probe />); });
  await rerender();
  return { get value() { return value; }, rerender, unmount: () => act(async () => { root.unmount(); }) };
}
