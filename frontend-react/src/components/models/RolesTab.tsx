import { useEffect, useState } from 'react';
import { SelectMenu } from '@/components/ui/select-menu';
import { ROLES, type Role, type RoleModel } from '@/lib/modelRoles';
import { tauri, type ByokProvider, type ModelInfo } from '@/lib/tauri';
import { useModel } from '@/stores/model';

const NONE = 'none';

/** What an unset role does, said where it is chosen (lib/modelRoles.ts `resolveRole`). */
const UNSET: Record<Role, string> = {
  primary: 'Not set: the model you picked last answers.',
  fast: 'Not set: the switcher offers to choose one.',
  deep: 'Not set: the switcher offers to choose one.',
  local: 'Not set: the first model on this computer.',
};

function RoleRow({ role, value, providers, locals, onChange }: {
  role: (typeof ROLES)[number];
  value: RoleModel | undefined;
  providers: ByokProvider[];
  locals: ModelInfo[];
  onChange: (m: RoleModel | null) => void;
}) {
  const localOnly = role.id === 'local';
  const [source, setSource] = useState(
    value ? (value.kind === 'cloud' ? `cloud:${value.providerId}` : `local:${value.path}`) : NONE,
  );
  const [modelId, setModelId] = useState(value?.kind === 'cloud' ? value.modelId : '');
  const provider = providers.find((p) => `cloud:${p.id}` === source);

  const options = [
    { value: NONE, label: 'Not set' },
    ...(localOnly ? [] : providers.map((p) => ({ value: `cloud:${p.id}`, label: p.name }))),
    ...locals.map((m) => ({ value: `local:${m.path}`, label: m.name })),
  ];

  const choose = (v: string) => {
    setSource(v);
    if (v === NONE) { onChange(null); return; }
    const local = locals.find((m) => `local:${m.path}` === v);
    if (local) { onChange({ kind: 'local', path: local.path, name: local.name }); return; }
    const p = providers.find((x) => `cloud:${x.id}` === v);
    if (!p) return;
    // The provider's default model to start from; kept only once there is one.
    const id = p.default_model ?? '';
    setModelId(id);
    onChange(id ? { kind: 'cloud', providerId: p.id, providerName: p.name, modelId: id } : null);
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border-default bg-bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-active text-brand">
          <role.icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-text-primary">{role.label}</p>
          <p className="text-sm text-text-muted">{role.line}</p>
        </div>
        <SelectMenu value={source} options={options} onChange={choose} ariaLabel={`${role.label} model`} className="w-56" />
      </div>
      {provider && (
        <label className="flex items-center gap-3 pl-13 text-sm text-text-secondary">
          <span className="shrink-0">Model</span>
          <input
            value={modelId}
            onChange={(e) => {
              const id = e.target.value.trim();
              setModelId(e.target.value);
              onChange(id ? { kind: 'cloud', providerId: provider.id, providerName: provider.name, modelId: id } : null);
            }}
            placeholder={provider.default_model ?? 'e.g. openai/gpt-5-mini'}
            aria-label={`${role.label} model id`}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border-default bg-bg-elevated px-3 text-sm text-text-primary outline-hidden focus:border-brand"
          />
        </label>
      )}
      {source === NONE && <p className="pl-13 text-xs text-text-muted">{UNSET[role.id]}</p>}
    </div>
  );
}

/**
 * Models > Roles (spec 8): which model each role in the Model Switcher means.
 * Cloud roles take a provider with a key and a model id; Local takes a model
 * on this computer. Nothing here is required: an unset role says what it does.
 */
export function RolesTab({ onCloud, onBrowse }: { onCloud: () => void; onBrowse: () => void }) {
  const roles = useModel((s) => s.roles);
  const setRole = useModel((s) => s.setRole);
  const [providers, setProviders] = useState<ByokProvider[] | null>(null);
  const [locals, setLocals] = useState<ModelInfo[] | null>(null);

  useEffect(() => {
    tauri.raw.getByokSettings().then((p) => setProviders(p.filter((x) => x.has_api_key)), () => setProviders([]));
    tauri.models.list().then((all) => setLocals(all.filter((m) => !m.is_embedding)), () => setLocals([]));
  }, []);

  const ready = providers !== null && locals !== null;
  const nothing = ready && providers.length === 0 && locals.length === 0;

  return (
    // The Models page scrolls and pads its tabs; this is only the column.
    <div>
      <div className="flex max-w-2xl flex-col gap-4">
        <div>
          <h2 className="font-display text-2xl text-text-primary">Roles</h2>
          <p className="mt-1 text-sm text-text-muted">
            The model pill switches between these. Most people set Primary and leave the rest.
          </p>
        </div>
        {nothing && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-border-default p-4 text-sm text-text-muted">
            <span className="flex-1">A role needs a model: add a cloud key or download one first.</span>
            <button type="button" onClick={onCloud} className="rounded-lg border border-border-default bg-bg-elevated px-3 py-1.5 text-sm text-text-primary hover:bg-text-primary/5">Cloud keys</button>
            <button type="button" onClick={onBrowse} className="rounded-lg border border-border-default bg-bg-elevated px-3 py-1.5 text-sm text-text-primary hover:bg-text-primary/5">Download a model</button>
          </div>
        )}
        {ready && !nothing && ROLES.map((r) => (
          <RoleRow
            key={r.id}
            role={r}
            value={roles[r.id]}
            providers={providers}
            locals={locals}
            onChange={(m) => setRole(r.id, m)}
          />
        ))}
      </div>
    </div>
  );
}
