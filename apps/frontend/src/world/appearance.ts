export type ProceduralVariant = 'clipboard' | 'projector' | 'lead' | 'terminal' | 'interface' | 'optic' | 'tools' | 'generic';

type BuiltinAppearanceId = 'product_manager_v1' | 'architect_v1' | 'cto_v1' | 'backend_v1' | 'frontend_v1' | 'qa_v1' | 'devops_v1';
export type ProceduralAppearance = Readonly<{
  id: BuiltinAppearanceId | 'generic_procedural_v1';
  variant: ProceduralVariant;
  accent: string;
  shell: string;
}>;
export type AppearanceResolution = Readonly<{
  requestedId: string;
  appearance: ProceduralAppearance;
  source: 'built-in' | 'definition-fallback' | 'generic-fallback';
}>;

// Resource IDs select presentation only; they never determine an agent's role or location.
const builtins: readonly ProceduralAppearance[] = [
  { id: 'product_manager_v1', variant: 'clipboard', accent: '#ff9c54', shell: '#e5bd8e' },
  { id: 'architect_v1', variant: 'projector', accent: '#52c8ff', shell: '#c9e3eb' },
  { id: 'cto_v1', variant: 'lead', accent: '#ffc477', shell: '#8ca8b9' },
  { id: 'backend_v1', variant: 'terminal', accent: '#49bfff', shell: '#a6c1d0' },
  { id: 'frontend_v1', variant: 'interface', accent: '#ffaf75', shell: '#dae7df' },
  { id: 'qa_v1', variant: 'optic', accent: '#a0d9ff', shell: '#e1e8e5' },
  { id: 'devops_v1', variant: 'tools', accent: '#6eb1ff', shell: '#e1b879' },
];
const generic: ProceduralAppearance = {
  id: 'generic_procedural_v1', variant: 'generic', accent: '#90b6cf', shell: '#b9cbd1',
};
const registry = new Map<string, ProceduralAppearance>();
for (const appearance of builtins) {
  registry.set(appearance.id, appearance);
  // Keep the frontend's existing product_manager-v1 and other hyphen aliases usable.
  registry.set(appearance.id.replace(/_v1$/, '-v1'), appearance);
}

export function resolveAppearance(requestedId: string, definitionFallbackId?: string): AppearanceResolution {
  const requested = registry.get(requestedId);
  if (requested) return { requestedId, appearance: requested, source: 'built-in' };
  const fallback = definitionFallbackId ? registry.get(definitionFallbackId) : undefined;
  if (fallback) return { requestedId, appearance: fallback, source: 'definition-fallback' };
  return { requestedId, appearance: generic, source: 'generic-fallback' };
}
