import { BoxGeometry, BufferGeometry, CatmullRomCurve3, CylinderGeometry, ExtrudeGeometry, Path, Shape, TubeGeometry, Vector2, Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export type EnvironmentPoint2 = [number, number];
export type EnvironmentPoint3 = [number, number, number];

function finishGeometry(geometry: BufferGeometry) {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  if (uv) for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    if (Math.abs(normals.getY(index)) > 0.6) uv.setXY(index, x * 0.4, z * 0.4);
    else uv.setXY(index, (Math.abs(normals.getX(index)) > 0.6 ? z : x) * 0.4, y * 0.4);
  }
  geometry.clearGroups();
  const result = geometry.index ? geometry : mergeVertices(geometry, 0.00001);
  if (result !== geometry) geometry.dispose();
  return result;
}

export function environmentBox(size: EnvironmentPoint3) {
  return finishGeometry(new BoxGeometry(...size));
}

export function environmentRounded(size: EnvironmentPoint3, radius = 0.14, bevel = 0.018) {
  const [width, height, depth] = size;
  // Subpixel handles and seams do not need an extrusion with hundreds of faces.
  if (radius <= 0.035 || Math.min(width, depth) <= 0.055) return environmentBox(size);
  const edge = Math.min(bevel, height / 4, width / 8, depth / 8);
  const w = width - edge * 2;
  const d = depth - edge * 2;
  const r = Math.max(0.001, Math.min(radius - edge, w / 2, d / 2));
  const x = -w / 2;
  const z = -d / 2;
  const shape = new Shape();
  shape.moveTo(x + r, z);
  shape.lineTo(x + w - r, z);
  shape.quadraticCurveTo(x + w, z, x + w, z + r);
  shape.lineTo(x + w, z + d - r);
  shape.quadraticCurveTo(x + w, z + d, x + w - r, z + d);
  shape.lineTo(x + r, z + d);
  shape.quadraticCurveTo(x, z + d, x, z + d - r);
  shape.lineTo(x, z + r);
  shape.quadraticCurveTo(x, z, x + r, z);
  const geometry = new ExtrudeGeometry(shape, {
    depth: height - edge * 2, steps: 1, bevelEnabled: edge > 0,
    bevelThickness: edge, bevelSize: edge, bevelSegments: 1,
    curveSegments: r <= 0.16 ? 4 : r <= 0.45 ? 7 : 12,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -(height - edge * 2) / 2, 0);
  return finishGeometry(geometry);
}

export function environmentProfile(points: EnvironmentPoint2[], height: number, radius = 0.3) {
  const shape = new Shape();
  const corners = points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const previousDistance = Math.hypot(previous[0] - point[0], previous[1] - point[1]) || 1;
    const nextDistance = Math.hypot(next[0] - point[0], next[1] - point[1]) || 1;
    const distance = Math.min(radius, previousDistance / 2, nextDistance / 2);
    return {
      point,
      before: [point[0] + (previous[0] - point[0]) * distance / previousDistance, point[1] + (previous[1] - point[1]) * distance / previousDistance],
      after: [point[0] + (next[0] - point[0]) * distance / nextDistance, point[1] + (next[1] - point[1]) * distance / nextDistance],
    };
  });
  shape.moveTo(corners[0].before[0], -corners[0].before[1]);
  for (let index = 0; index < corners.length; index++) {
    const corner = corners[index];
    if (index) shape.lineTo(corner.before[0], -corner.before[1]);
    shape.quadraticCurveTo(corner.point[0], -corner.point[1], corner.after[0], -corner.after[1]);
  }
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: radius <= 0.16 ? 4 : 10 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2, 0);
  return finishGeometry(geometry);
}

export function environmentRibbon(path: EnvironmentPoint2[], thickness: number, height: number) {
  const sides = path.map(([x, z], index) => {
    const previous = path[Math.max(0, index - 1)];
    const next = path[Math.min(path.length - 1, index + 1)];
    const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]) || 1;
    const dx = -(next[1] - previous[1]) / length * thickness / 2;
    const dz = (next[0] - previous[0]) / length * thickness / 2;
    return { left: [x + dx, z + dz] as EnvironmentPoint2, right: [x - dx, z - dz] as EnvironmentPoint2 };
  });
  const outline = [...sides.map(side => side.left), ...sides.slice().reverse().map(side => side.right)];
  const shape = new Shape(outline.map(([x, z]) => new Vector2(x, -z)));
  const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2, 0);
  return finishGeometry(geometry);
}

export function environmentRod(radius: number, topRadius: number, height: number, sides?: number) {
  const segments = sides ?? (Math.max(radius, topRadius) <= 0.08 ? 8 : radius < 0.35 ? 16 : radius < 1 ? 28 : 48);
  return finishGeometry(new CylinderGeometry(topRadius, radius, height, segments));
}

export function environmentCable(points: EnvironmentPoint3[], radius: number) {
  return finishGeometry(new TubeGeometry(new CatmullRomCurve3(points.map(point => new Vector3(...point))), points.length * 4, radius, 4, false));
}

export function environmentAnnulus(outer: number, inner: number, height: number, segments = 48) {
  const shape = new Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: segments / 2 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2, 0);
  return finishGeometry(geometry);
}
