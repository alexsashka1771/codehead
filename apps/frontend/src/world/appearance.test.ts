import { createHash } from 'node:crypto';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentView, RoleDefinition } from '../../../../packages/contracts';
import { fallbackRoles } from '../features/roles';
import { AgentBot } from './AgentBot';

type SceneProps = {
  children?: ReactNode;
  args?: unknown;
  position?: unknown;
  rotation?: unknown;
  scale?: unknown;
  castShadow?: unknown;
  receiveShadow?: unknown;
  color?: unknown;
  emissive?: unknown;
  emissiveIntensity?: unknown;
  roughness?: unknown;
  metalness?: unknown;
  transparent?: unknown;
  opacity?: unknown;
  userData?: Record<string, unknown>;
  onClick?: (event: { delta: number; stopPropagation: () => void }) => void;
};
type Transform = Pick<SceneProps, 'position' | 'rotation' | 'scale' | 'castShadow' | 'receiveShadow'>;
type SceneRecord = { type: string; args: unknown; transforms: Transform[]; material?: Record<string, unknown> };

// These world components are pure JSX functions; no renderer or WebGL is needed.
function isSceneFunction(value: unknown): value is (props: SceneProps) => ReactNode {
  return typeof value === 'function';
}

function collectScene(node: ReactNode, includeMaterials = false, transforms: Transform[] = []): SceneRecord[] {
  if (Array.isArray(node)) return node.flatMap(child => collectScene(child, includeMaterials, transforms));
  if (!isValidElement<SceneProps>(node)) return [];
  if (isSceneFunction(node.type)) return collectScene(node.type(node.props), includeMaterials, transforms);
  const type = node.type;
  const props = node.props;
  const nextTransforms = type === 'group' || type === 'mesh' ? [...transforms, {
    position: props.position ?? null, rotation: props.rotation ?? null, scale: props.scale ?? null,
    castShadow: props.castShadow ?? null, receiveShadow: props.receiveShadow ?? null,
  }] : transforms;
  const entries: SceneRecord[] = [];
  if (typeof type === 'string' && type.endsWith('Geometry')) {
    entries.push({ type, args: props.args ?? null, transforms: nextTransforms });
  } else if (includeMaterials && typeof type === 'string' && type.endsWith('Material')) {
    entries.push({ type, args: null, transforms: nextTransforms, material: {
      color: props.color ?? null, emissive: props.emissive ?? null,
      emissiveIntensity: props.emissiveIntensity ?? null, roughness: props.roughness ?? null,
      metalness: props.metalness ?? null, transparent: props.transparent ?? null, opacity: props.opacity ?? null,
    } });
  }
  return [...entries, ...collectScene(props.children, includeMaterials, nextTransforms)];
}

function digest(tree: ReactNode, includeMaterials = false) {
  return createHash('sha256').update(JSON.stringify(collectScene(tree, includeMaterials))).digest('hex');
}

function rootProps(tree: ReactNode): SceneProps {
  if (!isValidElement<SceneProps>(tree)) throw new Error('Expected an intrinsic robot group');
  return tree.props;
}

const manager: RoleDefinition = Object.freeze({
  role: 'product_manager', name: 'Product Manager', location: 'product',
  appearance_id: 'product_manager_v1', instructions_version: '1',
});
const managerAgent: AgentView = Object.freeze({
  id: 'agent-manager', run_id: 'run-test', role: 'product_manager',
  instructions_version: '1', appearance_id: 'product_manager_v1',
  lifecycle: 'offline', activity: 'waiting', location: 'product', current_task_id: null,
});

function renderBot(definition = manager, agent?: AgentView, night = true, onSelect: () => void = () => {}) {
  return AgentBot({ definition, agent, selected: true, onSelect, night });
}

// Freeze the original placement only for appearance goldens, including its arithmetic precision.
const CAPTURE_PLACEMENT: Record<RoleDefinition['role'], [number, number, number]> = {
  product_manager: [-8.15 + 0.85, 0.16, -4.25 + 0.85],
  architect: [-2.75 - 1.05, 0.16, -4.25 + 0.95],
  cto: [-2.75 + 1.05, 0.16, -4.25 + 0.95],
  backend: [-7.4 - 1.5, 0.16, 0.95],
  frontend: [-7.4 + 1.05, 0.16, 0.95],
  qa: [1.45, 0.16, 4.25 + 0.75],
  devops: [7.4 - 1.15, 0.16, 0.85],
};

function capturedAppearance(definition: RoleDefinition, night: boolean) {
  return digest(cloneElement(renderBot(definition, undefined, night), { position: CAPTURE_PLACEMENT[definition.role] }), true);
}

describe('procedural robot appearance selection', () => {
  it('changes actual geometry for a new appearance while keeping role, position, and selection', () => {
    const onSelect = vi.fn();
    const clipboard = renderBot(manager, undefined, true, onSelect);
    const optic = renderBot({ ...manager, appearance_id: 'qa_v1' }, undefined, true, onSelect);
    expect(digest(optic)).not.toBe(digest(clipboard));
    const original = rootProps(clipboard);
    const changed = rootProps(optic);
    expect(changed.userData?.role).toBe('product_manager');
    expect(changed.position).toEqual(original.position);
    const stopPropagation = vi.fn();
    changed.onClick?.({ delta: 0, stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('takes a known appearance from the snapshot without changing its domain placement', () => {
    const snapshot = { ...managerAgent, appearance_id: 'qa_v1' };
    const actual = renderBot(manager, snapshot);
    const expected = renderBot({ ...manager, appearance_id: 'qa_v1' });
    expect(digest(actual)).toBe(digest(expected));
    expect(digest(actual)).not.toBe(digest(renderBot(manager)));
    expect(rootProps(actual).position).toEqual(rootProps(renderBot(manager)).position);
    expect(rootProps(actual).userData?.role).toBe(snapshot.role);
  });

  it('uses a known definition fallback for an unknown snapshot resource without mutating domain data', () => {
    const definition = Object.freeze({ ...manager, appearance_id: 'qa_v1' });
    const snapshot = Object.freeze({ ...managerAgent, appearance_id: 'unavailable_robot_v8' });
    const originalDefinition = { ...definition };
    const originalSnapshot = { ...snapshot };
    const actual = renderBot(definition, snapshot);
    expect(digest(actual)).toBe(digest(renderBot(definition)));
    expect(rootProps(actual).userData).toMatchObject({
      role: 'product_manager', requested_appearance_id: 'unavailable_robot_v8',
      resolved_appearance_id: 'qa_v1', appearance_source: 'definition-fallback',
    });
    expect(definition).toEqual(originalDefinition);
    expect(snapshot).toEqual(originalSnapshot);
    expect(rootProps(actual).position).toEqual(rootProps(renderBot(manager)).position);
  });

  it('renders a generic procedural body when both resource IDs are unknown', () => {
    const definition = Object.freeze({ ...manager, appearance_id: 'unavailable_default_v4' });
    const snapshot = Object.freeze({ ...managerAgent, appearance_id: 'unavailable_robot_v8' });
    const actual = renderBot(definition, snapshot);
    expect(collectScene(actual).length).toBeGreaterThan(10);
    expect(digest(actual)).not.toBe(digest(renderBot(manager)));
    expect(rootProps(actual).userData).toMatchObject({
      role: 'product_manager', requested_appearance_id: 'unavailable_robot_v8',
      resolved_appearance_id: 'generic_procedural_v1', appearance_source: 'generic-fallback',
    });
    expect(rootProps(actual).position).toEqual(rootProps(renderBot(manager)).position);
    expect(definition.appearance_id).toBe('unavailable_default_v4');
    expect(snapshot.appearance_id).toBe('unavailable_robot_v8');
  });

  it('keeps all frontend hyphen aliases identical to the canonical backend appearances', () => {
    for (const definition of fallbackRoles) {
      const canonical = { ...definition, appearance_id: definition.appearance_id.replace(/-v1$/, '_v1') };
      expect(digest(renderBot(definition), true)).toBe(digest(renderBot(canonical), true));
    }
  });

  it('pins the refined rounded geometry and enamel materials of all seven defaults in both themes', () => {
    // Refined model recipes from 2026-11-22; placement, names and domain metadata stay independent.
    const expected =
    {
      "product_manager": {
        "dark": "67de29bea9c0fb1c1a3e22d343f9c9280b9f6f4fd4f83b2084fd0f52f5afd542",
        "light": "74218b8ffb8d68bdc15c54cac14d9122c947a83918a0ea37cb3a57ea25b2cf4f"
      },
      "architect": {
        "dark": "a5297a43134bdfbb7ae23c8c0be37d25fa607a9aacd3298c71401b07fe509c2b",
        "light": "926e19b0dca8dfbdf84e1d448f0897dcfb45debf3a29c804eb77199d2f5935e1"
      },
      "cto": {
        "dark": "8329ea0e7e55affe6f4d84f38f022e21598a8cd1045227bdc58eff728904595b",
        "light": "3746cf61c043f2106d0ab1982b4cfac509885ae5d742891031c1d0d30b3714ab"
      },
      "backend": {
        "dark": "4221b46bc0c6e02b80b4c6204645dd81137f3f8ded8d093283bd05fb7c96dc05",
        "light": "75b9e32ccc7c3ec7cc9ff46ab5515fd847e38efb6def83a72ce18b1252120267"
      },
      "frontend": {
        "dark": "cb7c0c8625a30aadb905b5c8dcb7756144c25cef3649cd11465273791b6762a3",
        "light": "7056a32666ffcd4505f8b80372f9003b14287093d86cc6218bcbf1f54cf072a4"
      },
      "qa": {
        "dark": "4f9bfd3b7d7ea3d88499eeb9df98f516faadff3ccf717b1daee2e2d0940c56d6",
        "light": "6b2f7a03b8c88a22278ad49ea09f5ff11234bbfc791c2974cd292840e247bdd2"
      },
      "devops": {
        "dark": "106a8c64e80ecd1c3efba68df5f7279dfee737c506b3ef8cd6242e8dfc7071b9",
        "light": "cef194ff50df30174e409d163fa8a752e5505b1ce98b525362cee698d7a0576b"
      }
    };
    const baseline = Object.fromEntries(fallbackRoles.map(definition => [definition.role, {
      dark: capturedAppearance(definition, true),
      light: capturedAppearance(definition, false),
    }]));
    expect(baseline).toEqual(expected);
  });
});
