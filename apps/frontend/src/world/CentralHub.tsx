import { memo, useMemo } from 'react';
import { ATELIER_ACCENTS } from './finishes';
import { BatchedEnvironment, EnvironmentBuilder } from './environmentBatch';
import { DECK_HEIGHT, zonePositions } from './layout';

export function buildCentralHub(night: boolean) {
  const author = new EnvironmentBuilder('machined-glass-core');
  const dark = { color: '#405660', finish: 'metal' as const, metalness: 0.64, roughness: 0.32 };
  const edge = { color: '#87a7b1', finish: 'metal' as const, metalness: 0.72, roughness: 0.27 };
  const glow = { color: '#b4eeeb', emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.70 : 0.10, metalness: 0.08, roughness: 0.30 };
  const noShadow = { castShadow: false };
  author.rod([0, 0.12, 0], 1.46, 0.24, dark, undefined, 1.4, 64);
  author.annulus([0, 0.22, 0], 1.41, 1.02, 0.16, edge);
  author.annulus([0, 0.301, 0], 1.31, 1.17, 0.027, dark, noShadow);
  author.annulus([0, 0.295, 0], 1.15, 1.035, 0.045, glow, noShadow);
  author.rod([0, 0.292, 0], 0.93, 0.035, { color: '#a4dfe0', finish: 'ceramic', emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.16 : 0.025 }, noShadow, undefined, 64);
  author.annulus([0, 1.12, 0], 1.025, 0.98, 1.56,
    { color: '#f3faf9', finish: 'glass', glassMode: 'thin', roughness: 0.055 }, { castShadow: false, receiveShadow: false }, 64);
  author.annulus([0, 1.1, 0], 0.71, 0.68, 1.28,
    { color: '#d8eee7', finish: 'glass', glassMode: 'thin', roughness: 0.055,
      emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.025 : 0.005 },
    { castShadow: false, receiveShadow: false }, 48);
  author.rod([0, 0.393, 0], 0.68, 0.045, glow, noShadow, undefined, 48);
  author.annulus([0, 1.729, 0], 0.71, 0.64, 0.032, glow, noShadow);
  author.annulus([0, 1.95, 0], 1.18, 0.84, 0.205, dark, undefined, 64);
  author.annulus([0, 2.052, 0], 1.19, 1.11, 0.042, edge, noShadow, 64);
  author.annulus([0, 1.853, 0], 1.13, 1.045, 0.027, glow, noShadow, 64);
  author.rod([0, 2.032, 0], 0.69, 0.025, { color: '#abbfc3', finish: 'metal', roughness: 0.34, emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.04 : 0.01 }, noShadow, undefined, 48);
  author.annulus([0, 2.34, 0], 0.656, 0.623, 0.56,
    { color: '#eef9f6', finish: 'glass', glassMode: 'thin', roughness: 0.055,
      emissive: ATELIER_ACCENTS.cyan, glow: night ? 0.025 : 0.005 },
    { castShadow: false, receiveShadow: false }, 48);
  author.annulus([0, 2.637, 0], 0.702, 0.616, 0.049, dark, noShadow, 48);
  author.annulus([0, 2.616, 0], 0.656, 0.622, 0.015, glow, noShadow, 48);
  for (let index = 0; index < 3; index++) {
    const angle = index * Math.PI * 2 / 3 + Math.PI / 2;
    const x = Math.cos(angle) * 1.038;
    const z = Math.sin(angle) * 1.038;
    author.rounded([x, 1.12, z], [0.06, 1.49, 0.075], 0.025, edge, { rotation: [0, -angle, 0] });
    author.box([x + Math.cos(angle) * 0.056, 1.12, z + Math.sin(angle) * 0.056], [0.015, 1.21, 0.025], edge,
      { castShadow: false, rotation: [0, -angle, 0] });
  }
  author.annulus([0, 0.008, 0], 1.83, 1.80, 0.008, { color: '#557c8c', metalness: 0.75, roughness: 0.3 }, noShadow, 80);
  for (let index = 0; index < 12; index++) {
    const angle = index * Math.PI / 6;
    author.rod([Math.cos(angle) * 1.265, 0.309, Math.sin(angle) * 1.265], 0.027, 0.017,
      { color: '#243f4d', metalness: 0.72, roughness: 0.24 }, noShadow, undefined, 6);
  }
  return author.finish();
}

export const CentralHub = memo(function CentralHub({ night }: { night: boolean }) {
  const [x, z] = zonePositions.core;
  const batches = useMemo(() => buildCentralHub(night), [night]);
  return <group name="central-hub" position={[x, DECK_HEIGHT, z]} userData={{ decorative: true, tokenTelemetryAgent: false }}>
    <BatchedEnvironment batches={batches} />
  </group>;
});
