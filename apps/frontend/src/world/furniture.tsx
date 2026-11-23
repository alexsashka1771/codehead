import { memo, useMemo } from 'react';
import { Euler, Quaternion, Vector3 } from 'three';
import { ATELIER_ACCENTS, ROOM_FINISHES, type SurfaceSpec } from './finishes';
import { BatchedEnvironment, EnvironmentBuilder } from './environmentBatch';
import { AtelierGreenery } from './greenery';
import { DECK_HEIGHT, meetingPlaces, zonePositions } from './layout';
import type { Point2, Point3 } from './primitives';

const METAL: SurfaceSpec = { color: '#344f61', finish: 'metal', roughness: 0.35 };
const DARK: SurfaceSpec = { color: '#1c3040', finish: 'metal', roughness: 0.44 };
const WOOD: SurfaceSpec = { color: '#a47a53', finish: 'wood', roughness: 0.47 };
const WALNUT: SurfaceSpec = { color: '#866041', finish: 'wood', roughness: 0.48 };
const ALLOY: SurfaceSpec = { color: '#89a3ad', finish: 'metal', roughness: 0.29 };
const PEARL: SurfaceSpec = { color: '#a8c0c8', finish: 'ceramic', roughness: 0.32 };
const PAPER: SurfaceSpec = { color: '#bbc4ba', finish: 'fabric', roughness: 0.8 };
const NO_SHADOW = { castShadow: false };
type DisplayKind = 'code' | 'interface' | 'diagram';

function display(author: EnvironmentBuilder, at: Point3, width: number, height: number, night: boolean, kind: DisplayKind, accent: string = ATELIER_ACCENTS.cyan, yaw = 0) {
  author.group(at, [0, yaw, 0], () => {
    author.rounded([0, 0, 0], [width + 0.11, 0.09, height + 0.11], 0.055, DARK, { rotation: [Math.PI / 2, 0, 0], castShadow: false });
    author.box([0, 0, 0.052], [width, height, 0.012],
      { color: '#102c3e', emissive: accent, glow: night ? 0.10 : 0.025, roughness: 0.23 }, NO_SHADOW);
    const bright = { color: accent, emissive: accent, glow: night ? 0.42 : 0.12, roughness: 0.45 };
    const quiet = { color: '#749fad', glow: night ? 0.20 : 0.045 };
    if (kind === 'code') {
      for (let row = 0; row < 8; row++) {
        const y = height * 0.35 - row * height * 0.092;
        author.box([-width * 0.425, y, 0.062], [0.018, 0.009, 0.003], quiet, NO_SHADOW);
        author.box([-width * 0.14 + (row % 3) * 0.034, y, 0.063], [width * (0.36 + (row % 3) * 0.078), 0.012, 0.003], bright, NO_SHADOW);
        author.box([width * 0.28, y, 0.062], [width * (row % 2 ? 0.18 : 0.12), 0.009, 0.003], quiet, NO_SHADOW);
      }
    } else if (kind === 'interface') {
      author.box([-width * 0.32, 0, 0.062], [width * 0.16, height * 0.74, 0.003], quiet, NO_SHADOW);
      author.box([width * 0.11, height * 0.2, 0.062], [width * 0.55, height * 0.23, 0.003], bright, NO_SHADOW);
      for (let index = 0; index < 3; index++) {
        author.box([width * (-0.085 + index * 0.195), -height * 0.14, 0.062], [width * 0.14, height * 0.28, 0.003], quiet, NO_SHADOW);
      }
      author.box([width * 0.1, -height * 0.35, 0.062], [width * 0.54, 0.01, 0.003], bright, NO_SHADOW);
    } else {
      author.box([0, 0, 0.062], [width * 0.57, 0.012, 0.003], bright, NO_SHADOW);
      author.box([0, 0, 0.062], [0.012, height * 0.51, 0.003], bright, NO_SHADOW);
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        author.box([x * width * 0.28, y * height * 0.23, 0.065], [width * 0.27, height * 0.24, 0.005], quiet, NO_SHADOW);
        author.box([x * width * 0.28, y * height * 0.23, 0.069], [width * 0.17, 0.009, 0.002], bright, NO_SHADOW);
      }
    }
    author.box([0, -height / 2 - 0.025, 0.055], [0.027, 0.012, 0.005], ALLOY, NO_SHADOW);
  });
}

function keyboard(author: EnvironmentBuilder, at: Point3, compact = false) {
  author.group(at, [0, 0, 0], () => {
    const width = compact ? 0.63 : 0.78;
    author.rounded([0, 0, 0], [width, 0.04, 0.27], 0.052, DARK, NO_SHADOW);
    const columns = compact ? 9 : 11;
    for (let row = 0; row < 3; row++) for (let column = 0; column < columns; column++) {
      author.box([-width * 0.42 + column * width * 0.084, 0.028, -0.076 + row * 0.069], [width * 0.065, 0.01, 0.038], ALLOY, NO_SHADOW);
    }
    author.rounded([width / 2 + 0.17, 0.011, 0], [0.13, 0.055, 0.19], 0.055, PEARL, NO_SHADOW);
  });
}

function cup(author: EnvironmentBuilder, at: Point3) {
  author.rod([at[0], at[1] + 0.083, at[2]], 0.07, 0.162, PEARL, NO_SHADOW, 0.076);
  author.rod([at[0], at[1] + 0.166, at[2]], 0.06, 0.006, { color: '#483b2f', finish: 'rubber' }, NO_SHADOW);
  author.torus([at[0] + 0.084, at[1] + 0.087, at[2]], 0.039, 0.012, PEARL, { rotation: [0, Math.PI / 2, 0], castShadow: false }, 12);
}

function lamp(author: EnvironmentBuilder, at: Point3, night: boolean, floor = false) {
  author.group(at, [0, 0, 0], () => {
    const stem = floor ? 1.89 : 0.57;
    const base = floor ? 0.23 : 0.14;
    author.rod([0, 0.026, 0], base, 0.052, { color: '#8c7455', roughness: 0.29 }, NO_SHADOW);
    author.rod([0, stem / 2 + 0.04, 0], 0.024, stem, { color: '#ab8b5f', roughness: 0.26 }, NO_SHADOW);
    author.rod([0, stem + 0.17, 0], floor ? 0.285 : 0.215, floor ? 0.35 : 0.3,
      { color: '#c7b292', finish: 'fabric', emissive: ATELIER_ACCENTS.amber, glow: night ? 0.30 : 0.035 }, NO_SHADOW, floor ? 0.215 : 0.157, 24);
    author.rod([0, stem + 0.007, 0], floor ? 0.254 : 0.184, 0.016,
      { color: '#efb77f', emissive: ATELIER_ACCENTS.amber, glow: night ? 1.05 : 0.11, metalness: 0 }, NO_SHADOW, undefined, 24);
  });
}

function monitor(author: EnvironmentBuilder, at: Point3, night: boolean, kind: DisplayKind, width = 1.08, yaw = 0) {
  author.group(at, [0, yaw, 0], () => {
    author.rounded([0, 0.022, 0.03], [0.48, 0.043, 0.32], 0.1, METAL, NO_SHADOW);
    author.box([0, 0.18, -0.064], [0.046, 0.32, 0.063], ALLOY, NO_SHADOW);
    display(author, [0, 0.49, -0.06], width, width > 1.2 ? 0.72 : 0.63, night, kind);
  });
}

function workstation(author: EnvironmentBuilder, at: Point3, width: number, night: boolean, kind: DisplayKind, wood: SurfaceSpec, device: 'monitor' | 'laptop' | 'tablet' = 'monitor') {
  author.group(at, [0, 0, 0], () => {
    const outline: Point2[] = [[-width / 2, -0.56], [width / 2, -0.56], [width / 2, 0.52], [width * 0.22, 0.48], [width * 0.08, 0.34], [-width * 0.23, 0.34], [-width / 2, 0.61]];
    author.profile([0, 1.0, 0], outline, 0.12, 0.16, wood);
    author.profile([0, 0.915, 0], outline, 0.047, 0.16, METAL);
    author.rounded([-width / 2 + 0.31, 0.45, -0.1], [0.55, 0.83, 0.73], 0.07, DARK);
    author.box([width / 2 - 0.15, 0.44, -0.09], [0.09, 0.82, 0.74], ALLOY);
    author.rounded([width / 2 - 0.15, 0.051, -0.09], [0.35, 0.058, 0.8], 0.06, METAL, NO_SHADOW);
    for (let index = 0; index < 3; index++) {
      author.box([-width / 2 + 0.31, 0.245 + index * 0.217, 0.28], [0.45, 0.18, 0.02], METAL, NO_SHADOW);
      author.box([-width / 2 + 0.31, 0.276 + index * 0.217, 0.3], [0.15, 0.015, 0.026], ALLOY, NO_SHADOW);
    }
    if (device === 'laptop') {
      author.rounded([0, 1.088, 0.03], [1.13, 0.034, 0.58], 0.057, METAL, NO_SHADOW);
      display(author, [0, 1.39, -0.18], 1.02, 0.53, night, kind);
    } else if (device === 'tablet') {
      author.group([0.0, 1.25, -0.06], [-0.35, 0, 0], () => {
        display(author, [0, 0, 0], 1.08, 0.62, night, kind);
      });
      author.box([0, 1.14, -0.1], [0.44, 0.14, 0.27], METAL, NO_SHADOW);
    } else {
      monitor(author, [0.0, 1.073, -0.21], night, kind, width < 2 ? 0.81 : kind === 'interface' ? 1.24 : 1.04, kind === 'interface' ? -0.05 : 0.025);
    }
    keyboard(author, [0, 1.085, 0.39], width < 2);
    cup(author, [width * 0.34, 1.064, 0.18]);
    author.box([-width * 0.32, 1.077, 0.25], [0.33, 0.024, 0.26], PAPER, { rotation: [0, 0.1, 0], castShadow: false });
    author.cable([[0, 1.06, -0.4], [0.05, 0.83, -0.53], [0.15, 0.19, -0.52], [-width / 2 + 0.3, 0.09, -0.41]], 0.016, { color: '#253c4a', finish: 'rubber' });
  });
}

function shelf(author: EnvironmentBuilder, at: Point3, width: number, walnut = false) {
  author.group(at, [0, 0, 0], () => {
    const wood = walnut ? WALNUT : WOOD;
    author.box([0, 0.45, -0.12], [width, 0.86, 0.085], DARK);
    for (const y of [0.1, 0.55, 0.98]) author.rounded([0, y, 0], [width, 0.072, 0.37], 0.047, wood);
    for (const x of [-width / 2 + 0.045, width / 2 - 0.045]) author.box([x, 0.55, 0], [0.06, 0.97, 0.34], METAL, NO_SHADOW);
    for (let index = 0; index < Math.floor(width / 0.13) - 2; index++) {
      const x = -width / 2 + 0.2 + index * 0.115;
      author.box([x, 0.76 + (index % 3) * 0.017, 0], [0.074, 0.33 + (index % 3) * 0.034, 0.23], index % 3 ? PAPER : WALNUT, { castShadow: false, rotation: [0, 0, index === 2 ? 0.12 : 0] });
    }
    author.box([width * 0.25, 0.177, 0], [width * 0.38, 0.083, 0.27], METAL, NO_SHADOW);
  });
}

function rack(author: EnvironmentBuilder, at: Point3, night: boolean, open: boolean) {
  author.group(at, [0, 0, 0], () => {
    author.rounded([0, 0.073, 0], [0.83, 0.146, 0.98], 0.064, DARK);
    author.rounded([0, 2.5, 0], [0.83, 0.11, 0.98], 0.064, METAL);
    author.box([0, 1.29, -0.434], [0.77, 2.35, 0.09], DARK);
    for (const x of [-0.35, 0.35]) author.box([x, 1.29, 0], [0.069, 2.35, 0.89], ALLOY);
    for (let index = 0; index < 10; index++) {
      const y = 0.28 + index * 0.226;
      author.box([0, y, 0.026], [0.625, 0.183, 0.74], METAL, NO_SHADOW);
      author.box([0, y + 0.084, 0.408], [0.62, 0.014, 0.022], ALLOY, NO_SHADOW);
      for (let vent = 0; vent < 5; vent++) author.box([-0.07 + vent * 0.043, y, 0.412], [0.012, 0.089, 0.011], DARK, NO_SHADOW);
      author.box([-0.23, y, 0.421], [0.024, 0.018, 0.008],
        { color: ATELIER_ACCENTS.cyan, glow: night ? 0.55 : 0.11, emissive: ATELIER_ACCENTS.cyan }, NO_SHADOW);
    }
    if (!open) {
      author.box([0, 1.3, 0.443], [0.63, 2.34, 0.017], { color: '#507082', finish: 'glass', opacity: 0.13, roughness: 0.16 }, NO_SHADOW);
      author.box([0.255, 1.32, 0.47], [0.027, 0.26, 0.031], ALLOY, NO_SHADOW);
    } else {
      for (let index = 0; index < 3; index++) author.cable([[0.25, 0.6 + index * 0.47, 0.425], [0.44, 0.35 + index * 0.48, 0.62], [0.47, 0.18, 0.53], [0.42, 0.08, -0.04]],
        0.017, { color: index === 1 ? '#b17d53' : '#688b98', finish: 'rubber' });
    }
  });
}

function chair(author: EnvironmentBuilder, at: Point3, heading: number, color: string) {
  author.group(at, [0, heading, 0], () => {
    author.rod([0, 0.29, 0], 0.043, 0.42, ALLOY, NO_SHADOW);
    for (let index = 0; index < 5; index++) {
      const angle = index * Math.PI * 2 / 5;
      author.box([Math.sin(angle) * 0.16, 0.085, Math.cos(angle) * 0.16], [0.052, 0.035, 0.36], METAL,
        { rotation: [0, angle, 0], castShadow: false });
    }
    author.rounded([0, 0.52, 0], [0.56, 0.11, 0.53], 0.16, { color, finish: 'fabric' }, NO_SHADOW);
    author.rounded([0, 0.84, -0.22], [0.55, 0.095, 0.55], 0.14, { color, finish: 'fabric' }, { rotation: [Math.PI / 2 + 0.09, 0, 0], castShadow: false });
  });
}

function link(author: EnvironmentBuilder, from: Point3, to: Point3, radius: number, surface: SurfaceSpec) {
  const direction = new Vector3(...to).sub(new Vector3(...from));
  const orientation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize());
  const turn = new Euler().setFromQuaternion(orientation);
  author.rod(new Vector3(...from).add(new Vector3(...to)).multiplyScalar(0.5).toArray() as Point3, radius, direction.length(), surface,
    { rotation: [turn.x, turn.y, turn.z] });
}

function opticsBench(author: EnvironmentBuilder, at: Point3, night: boolean) {
  author.group(at, [0, 0, 0], () => {
    author.rounded([0, 0.43, 0], [1.91, 0.82, 1.43], 0.13, { color: '#6c8b9b', finish: 'ceramic' });
    author.rounded([0, 0.935, 0], [2.01, 0.14, 1.56], 0.17, PEARL);
    author.rounded([0, 1.025, 0], [1.28, 0.027, 0.98], 0.12, { color: '#294c61', finish: 'rubber' }, NO_SHADOW);
    for (const x of [-0.63, 0, 0.63]) {
      author.box([x, 0.5, 0.726], [0.51, 0.57, 0.024], METAL, NO_SHADOW);
      author.box([x, 0.62, 0.75], [0.18, 0.018, 0.025], ALLOY, NO_SHADOW);
    }
    author.box([-0.79, 1.43, -0.58], [0.09, 1.03, 0.12], ALLOY);
    author.box([0.02, 1.965, -0.58], [1.71, 0.1, 0.12], ALLOY);
    author.rod([0.45, 1.85, -0.51], 0.15, 0.26, DARK, NO_SHADOW);
    author.rod([0.45, 1.71, -0.51], 0.115, 0.018, { color: '#72b9c9', emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.53 : 0.1 }, NO_SHADOW);
    author.rod([0.32, 1.106, 0], 0.27, 0.14, ALLOY, NO_SHADOW);
    author.rounded([0.32, 1.226, 0], [0.31, 0.15, 0.28], 0.049, PEARL, NO_SHADOW);
    author.cable([[-0.83, 1.9, -0.68], [-0.99, 1.35, -0.68], [-0.99, 0.38, -0.68], [-0.65, 0.085, -0.54]], 0.018, { color: '#526c7a', finish: 'rubber' });
  });
}

function researchBench(author: EnvironmentBuilder, night: boolean) {
  author.group([7.15, DECK_HEIGHT, -6.1], [0, 0, 0], () => {
    author.rounded([0, 0.92, 0], [3.61, 0.14, 1.23], 0.42, { color: '#8fadae', finish: 'ceramic' });
    author.box([-1.24, 0.46, -0.03], [0.4, 0.86, 0.81], { color: '#34565e', finish: 'metal' });
    author.box([1.24, 0.46, -0.03], [0.4, 0.86, 0.81], { color: '#34565e', finish: 'metal' });
    author.rounded([0, 1.013, 0], [1.79, 0.031, 0.86], 0.15, { color: '#315b64', finish: 'rubber' }, NO_SHADOW);
    for (let index = 0; index < 3; index++) {
      const x = -0.55 + index * 0.55;
      author.rod([x, 1.072, 0.08], 0.173, 0.084, ALLOY, NO_SHADOW);
      author.rod([x, 1.27 + index * 0.075, 0.08], 0.118, 0.32 + index * 0.13,
        { color: '#76b4b7', finish: 'glass', opacity: 0.39, emissive: '#669da8', glow: night ? 0.07 : 0 }, NO_SHADOW);
      author.rod([x, 1.156, 0.08], 0.104, 0.11 + index * 0.025, { color: '#3e7f87', finish: 'ceramic' }, NO_SHADOW);
    }
    display(author, [-1.19, 1.48, -0.2], 0.75, 0.5, night, 'diagram');
    author.rod([1.22, 1.54, -0.28], 0.039, 1.09, ALLOY, NO_SHADOW);
    author.box([0.83, 2.08, -0.28], [0.81, 0.048, 0.063], ALLOY, NO_SHADOW);
    author.rod([0.45, 1.98, -0.28], 0.12, 0.22, DARK, NO_SHADOW);
  });
}

function productionBench(author: EnvironmentBuilder, night: boolean) {
  author.group([8.25, DECK_HEIGHT, 4.4], [0, 0, 0], () => {
    const copper = { color: '#a07852', finish: 'metal' as const, metalness: 0.67, roughness: 0.35 };
    author.rounded([0, 0.43, 0], [2.42, 0.82, 1.91], 0.2, { color: '#6f4d37', finish: 'metal' });
    author.rounded([0, 0.955, 0], [2.56, 0.16, 2.04], 0.23, copper);
    author.rounded([0.07, 1.057, 0.1], [1.56, 0.03, 1.2], 0.14, { color: '#29434e', finish: 'rubber' }, NO_SHADOW);
    author.rod([0.67, 1.164, -0.18], 0.27, 0.2, METAL);
    link(author, [0.67, 1.25, -0.18], [0.64, 2.0, -0.25], 0.104, PEARL);
    author.rod([0.64, 2.0, -0.25], 0.142, 0.23, METAL, { rotation: [Math.PI / 2, 0, 0] });
    link(author, [0.64, 2.05, -0.25], [-0.1, 2.35, 0.02], 0.095, PEARL);
    link(author, [-0.1, 2.35, 0.02], [-0.4, 1.86, 0.13], 0.08, PEARL);
    author.box([-0.4, 1.75, 0.13], [0.26, 0.15, 0.3], METAL);
    author.rod([-0.42, 1.66, 0.13], 0.062, 0.043, { color: '#83bdc7', emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.35 : 0.07 }, NO_SHADOW);
    display(author, [-0.74, 1.35, -0.55], 0.71, 0.48, night, 'interface', '#c49a71');
    keyboard(author, [-0.6, 1.063, 0.62], true);
    for (let index = 0; index < 3; index++) author.box([-0.5 + index * 0.22, 1.063, -0.09], [0.16, 0.07, 0.25], PEARL, NO_SHADOW);
  });
}

export function buildAtelierFurniture(night: boolean) {
  const author = new EnvironmentBuilder('authored-atelier-equipment');
  workstation(author, [-7.35, DECK_HEIGHT, -4.35], 3.8, night, 'interface', WALNUT, 'laptop');
  lamp(author, [-8.7, DECK_HEIGHT + 1.066, -4.68], night);
  shelf(author, [-8.99, DECK_HEIGHT, -6.26], 1.62, true);
  author.rounded([-5.57, DECK_HEIGHT + 0.41, -5.84], [0.66, 0.75, 0.65], 0.082, DARK);
  author.rounded([-5.57, DECK_HEIGHT + 0.82, -5.84], [0.72, 0.083, 0.72], 0.094, WALNUT);

  workstation(author, [-2.85, DECK_HEIGHT, -5.6], 2.3, night, 'diagram', WOOD);
  workstation(author, [-0.55, DECK_HEIGHT, -5.6], 2.34, night, 'diagram', WOOD, 'tablet');
  author.rounded([-3.68, DECK_HEIGHT + 1.0, -6.74], [0.7, 0.12, 1.99], 0.12, WOOD);
  author.box([-3.68, DECK_HEIGHT + 0.49, -7.38], [0.58, 0.93, 0.58], DARK);
  display(author, [-1.54, DECK_HEIGHT + 2.15, -7.48], 3.56, 1.14, night, 'diagram');
  lamp(author, [-3.71, DECK_HEIGHT + 1.066, -5.88], night);
  shelf(author, [-3.17, DECK_HEIGHT + 1.38, -7.38], 1.28);

  workstation(author, [1.97, DECK_HEIGHT, -6.23], 1.93, night, 'diagram', { color: '#765a54', finish: 'wood' }, 'tablet');
  display(author, [2.0, DECK_HEIGHT + 2.02, -7.46], 1.49, 1.02, night, 'diagram', '#b6838e');
  author.rounded([2.69, DECK_HEIGHT + 0.48, -7.15], [0.38, 0.94, 0.39], 0.055, DARK);
  author.box([2.69, DECK_HEIGHT + 0.98, -7.15], [0.3, 0.025, 0.29], { color: '#a77b82', metalness: 0.65 }, NO_SHADOW);

  workstation(author, [-8.65, DECK_HEIGHT, 0.15], 2.55, night, 'code', WOOD);
  workstation(author, [-5.55, DECK_HEIGHT, 0.15], 2.65, night, 'interface', WOOD);
  author.group([-9.68, DECK_HEIGHT, 1.76], [0, Math.PI / 2, 0], () => {
    author.rounded([0, 0.58, 0], [1.23, 1.12, 0.66], 0.1, METAL);
    author.box([0, 0.59, 0.347], [1.04, 0.87, 0.027], DARK, NO_SHADOW);
    for (let index = 0; index < 6; index++) author.box([-0.4 + index * 0.16, 0.73, 0.37], [0.081, 0.39, 0.014], ALLOY, NO_SHADOW);
  });
  shelf(author, [-7.05, DECK_HEIGHT + 1.66, -0.72], 2.4);

  for (let index = 0; index < 5; index++) rack(author, [5.42 + index * 0.89, DECK_HEIGHT, -3.64], night, index === 3);
  workstation(author, [7.15, DECK_HEIGHT, -1.65], 2.65, night, 'code', WALNUT);
  researchBench(author, night);
  author.box([9.37, DECK_HEIGHT + 0.55, -6.52], [0.65, 1.05, 0.59], { color: '#355d61', finish: 'metal' });
  author.rounded([9.37, DECK_HEIGHT + 1.12, -6.52], [0.71, 0.065, 0.67], 0.048, PEARL);

  opticsBench(author, [2.17, DECK_HEIGHT, 5.43], night);
  workstation(author, [4.35, DECK_HEIGHT, 3.4], 1.82, night, 'interface', { color: '#98b5bd', finish: 'ceramic' });
  author.box([5.72, DECK_HEIGHT + 0.72, 6.49], [0.65, 1.38, 0.74], PEARL);
  author.box([5.72, DECK_HEIGHT + 0.7, 6.88], [0.52, 1.13, 0.032], METAL, NO_SHADOW);
  for (const y of [0.34, 0.71, 1.1]) author.box([5.72, DECK_HEIGHT + y, 6.916], [0.17, 0.019, 0.022], ALLOY, NO_SHADOW);
  productionBench(author, night);
  author.box([9.1, DECK_HEIGHT + 0.43, 2.7], [1.01, 0.78, 0.64], { color: '#755135', finish: 'metal', metalness: 0.7 });
  author.rounded([9.1, DECK_HEIGHT + 0.88, 2.7], [1.09, 0.075, 0.7], 0.067, WOOD);

  author.group([-6.15, DECK_HEIGHT, 6.55], [0, 0, 0], () => {
    author.rounded([0, 1.0, 0], [4.4, 0.16, 1.64], 0.71, WOOD);
    author.rounded([0, 0.891, 0], [4.15, 0.042, 1.47], 0.65, METAL);
    for (const x of [-1.34, 1.34]) {
      author.rod([x, 0.45, 0], 0.26, 0.85, DARK, undefined, 0.21);
      author.rod([x, 0.056, 0], 0.42, 0.079, METAL, NO_SHADOW);
    }
    author.box([0, 1.093, 0.01], [0.67, 0.027, 0.45], PAPER, { rotation: [0, -0.16, 0], castShadow: false });
    cup(author, [-1.47, 1.082, 0.32]);
    cup(author, [1.39, 1.082, -0.22]);
    author.rounded([0.6, 1.104, 0.26], [0.44, 0.028, 0.33], 0.033, DARK, NO_SHADOW);
  });
  for (const [x, z] of Object.values(meetingPlaces)) {
    const centre = zonePositions.meeting;
    const dx = x - centre[0];
    const dz = z - centre[1];
    const distance = Math.hypot(dx, dz);
    const outward = z < 5.7 ? 0.03 : z > 7.7 ? 0.20 : 0.44;
    chair(author, [x + dx / distance * outward, DECK_HEIGHT, z + dz / distance * outward], Math.atan2(-dx, -dz), ROOM_FINISHES.meeting.upholstery);
  }
  lamp(author, [-9.4, DECK_HEIGHT, 6.56], night, true);
  return author.finish();
}

export const AtelierFurniture = memo(function AtelierFurniture({ night }: { night: boolean }) {
  const batches = useMemo(() => buildAtelierFurniture(night), [night]);
  return <group name="atelier-furniture" userData={{ decorative: true, realtime: false }}>
    <BatchedEnvironment batches={batches} />
    <AtelierGreenery />
  </group>;
});
