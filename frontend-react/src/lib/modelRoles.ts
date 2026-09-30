import { Brain, Gauge, Laptop, Zap, type LucideIcon } from 'lucide-react';

/**
 * Model roles (spec 8): the model pill offers roles, not raw names. Each role
 * is a model the person chose on the Models page; nothing here routes on its
 * own (that is Brain Stack's job, in the engine).
 */
export type Role = 'primary' | 'fast' | 'deep' | 'local';

export type RoleModel =
  | { kind: 'cloud'; providerId: string; providerName: string; modelId: string }
  | { kind: 'local'; path: string; name: string };

export const ROLES: { id: Role; label: string; line: string; icon: LucideIcon }[] = [
  { id: 'primary', label: 'Primary', line: 'Balanced for most tasks', icon: Zap },
  { id: 'fast',    label: 'Fast',    line: 'Quick answers to quick questions', icon: Gauge },
  { id: 'deep',    label: 'Deep',    line: 'Careful reasoning for hard problems', icon: Brain },
  { id: 'local',   label: 'Local',   line: 'Runs on your device, private and offline', icon: Laptop },
];

export function sameModel(a: RoleModel | null | undefined, b: RoleModel | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'cloud'
    ? a.providerId === (b as typeof a).providerId && a.modelId === (b as typeof a).modelId
    : a.path === (b as typeof a).path || a.name === (b as typeof a).name;
}

/**
 * The model a role stands for right now. Most people never open the roles, so
 * the defaults are the product: Primary is the model answering now until one
 * is chosen, and Local is the first downloaded model. Fast and Deep stay empty
 * until chosen, and the switcher says how to choose them.
 */
export function resolveRole(
  role: Role,
  chosen: Partial<Record<Role, RoleModel>>,
  active: RoleModel | null,
  firstLocal: RoleModel | null,
): RoleModel | null {
  if (chosen[role]) return chosen[role]!;
  if (role === 'primary') return active;
  if (role === 'local') return firstLocal;
  return null;
}

export function roleModelName(m: RoleModel): string {
  return m.kind === 'cloud' ? m.modelId : m.name;
}
