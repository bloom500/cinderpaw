import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn, SECONDARY_BUTTON } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSettings, type ByokProviderUpdate } from '@/stores/settings';
import { useCatalog } from '@/stores/catalog';
import type { ByokProvider } from '@/lib/tauri';

/** One provider row as the UI renders it. Canonical identity/URL/key-format
 *  data comes from the gateway catalog (`useCatalog` →
 *  `byok::provider_catalog()` in Rust); `PROVIDER_DEFS` below is the bundled
 *  OFFLINE FALLBACK plus the carrier of UI-only curation the catalog does
 *  not know (`availableModels` pick lists, the Custom Endpoint row). */
interface ProviderDef {
  id: string;
  name: string;
  hasBaseUrl: boolean;
  baseUrlHint: string;
  availableModels?: readonly string[];
  keyPrefix?: string;
}

const PROVIDER_DEFS: readonly ProviderDef[] = [
  { id: 'openai',     name: 'OpenAI',         hasBaseUrl: true,  baseUrlHint: 'https://api.openai.com/v1',     availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'anthropic',  name: 'Anthropic',       hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'google',     name: 'Google Gemini',   hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'kimi',       name: 'Kimi',            hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['kimi-for-coding'] as const,                                                                    keyPrefix: 'sk-kimi-' },
  { id: 'glm',        name: 'GLM (Z.ai)',      hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'] as const,                       keyPrefix: undefined  },
  { id: 'minimax',    name: 'MiniMax',         hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'] as const, keyPrefix: 'sk-cp-'   },
  { id: 'deepseek',   name: 'DeepSeek',        hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'groq',       name: 'Groq',            hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'mistral',    name: 'Mistral',         hasBaseUrl: false, baseUrlHint: '',                              availableModels: undefined,                                                                                      keyPrefix: undefined  },
  { id: 'openrouter', name: 'OpenRouter',      hasBaseUrl: true,  baseUrlHint: 'https://openrouter.ai/api/v1', availableModels: undefined,                                                                                      keyPrefix: undefined  },
  // NVIDIA NIM — hosted OpenAI-compatible chat completions (Llama, Mistral,
  // DeepSeek, etc.). Base URL is editable in case NVIDIA rotates the host.
  { id: 'nvidia',     name: 'NVIDIA NIM',      hasBaseUrl: true,  baseUrlHint: 'https://integrate.api.nvidia.com/v1', availableModels: undefined,                                                                                keyPrefix: undefined  },
  { id: 'custom',     name: 'Custom Endpoint', hasBaseUrl: true,  baseUrlHint: 'https://your-endpoint/v1',      availableModels: undefined,                                                                                      keyPrefix: undefined  },
];

function ProviderRow({ def, state }: { def: ProviderDef; state?: ByokProvider }) {
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const removeByokProvider = useSettings((s) => s.removeByokProvider);
  const testByokProvider = useSettings((s) => s.testByokProvider);

  const [open, setOpen]             = useState(false);
  const [enabled, setEnabled]       = useState(state?.enabled ?? false);
  const [apiKey, setApiKey]         = useState('');
  const [baseUrl, setBaseUrl]       = useState(state?.base_url ?? '');
  const [defaultModel, setDefModel] = useState(
    state?.default_model ?? (def.availableModels ? def.availableModels[0] : ''),
  );
  const [showKey, setShowKey]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [saveMsg, setSaveMsg]       = useState<string | null>(null);
  const [testing, setTesting]       = useState(false);
  const [testMsg, setTestMsg]       = useState<string | null>(null);

  const isActive = !!(state?.enabled && state?.has_api_key);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const p: ByokProviderUpdate = {
        providerId: def.id,
        enabled,
        apiKey,
        baseUrl: def.hasBaseUrl ? (baseUrl || null) : null,
        defaultModel: defaultModel || null,
      };
      await saveByokProvider(p);
      setSaveMsg('✓ Saved');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e) {
      // The Rust command returns Result<(), String> with the real cause
      // (keychain locked, disk full, permission denied on ~/.feral/byok.json,
      // etc.). Swallowing it in a bare `catch {}` and showing a generic
      // "Save failed" left the user with no way to tell why — the reported
      // "Save Failed" bug on OpenRouter / NVIDIA NIM (2026-08-22) turned out
      // to be an OS keychain prompt the user didn't see because the toast
      // hid it. Surface the message verbatim so the next report starts with
      // the actual error, not a shrug.
      const reason = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setSaveMsg(`Save failed: ${reason}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      // `useSettings.testByokProvider` already normalises Rust's
      // TestProviderResponse { success, message } into { ok, error } — read
      // the normalised shape here, not the raw one, or every probe reports
      // failure because `.success` is undefined on this side.
      const result = await testByokProvider({
        providerId: def.id,
        apiKey,
        baseUrl: def.hasBaseUrl ? (baseUrl || null) : null,
      });
      setTestMsg(result.ok ? '✓ Connected' : `Error: ${result.error ?? 'Unknown error'}`);
    } catch (e) {
      const reason = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setTestMsg(`Error: ${reason}`);
    } finally {
      setTesting(false);
    }
  };

  const inputCls = 'w-full px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary';
  const btnSecCls = SECONDARY_BUTTON;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border-subtle bg-bg-elevated/80 backdrop-blur-md hover:bg-bg-hover transition-colors text-left">
        <span className="text-sm font-medium text-text-primary">{def.name}</span>
        <span className={cn(
          'text-xs px-2 py-0.5 rounded-full shrink-0 border',
          isActive
            ? 'bg-success/25 border-success/40 text-success-text'
            : 'bg-black/40 border-white/10 text-text-secondary',
        )}>
          {isActive ? 'Active' : 'Not configured'}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-4 pt-3 pb-4 border border-t-0 border-border-subtle rounded-b-lg space-y-4 bg-bg-elevated/80 backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={cn('w-10 h-6 rounded-full transition-colors duration-200 relative shrink-0 overflow-hidden', enabled ? 'bg-blue-500' : 'bg-border-default')}
            >
              <span className={cn('absolute top-1 left-0 w-4 h-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-5' : 'translate-x-1')} />
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-muted">API Key</label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={state?.has_api_key ? 'Key saved, enter new key to update' : 'sk-...'}
                className={cn(inputCls, 'flex-1 font-mono')}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="px-2 py-1.5 rounded-md border border-border-subtle text-text-muted hover:bg-bg-hover"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {def.keyPrefix && apiKey.startsWith(def.keyPrefix) && (
              <p className="text-xs text-success mt-1">✓ {def.name} key detected</p>
            )}
          </div>

          {def.hasBaseUrl && (
            <div className="space-y-1">
              <label className="text-xs text-text-muted">
                Base URL
              </label>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={def.baseUrlHint || 'https://…'}
                className={inputCls}
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-text-muted">
              {def.availableModels ? 'Model' : 'Default model (optional)'}
            </label>
            {def.availableModels ? (
              <select
                value={defaultModel}
                onChange={(e) => setDefModel(e.target.value)}
                className={cn(inputCls, 'cursor-pointer appearance-none')}
              >
                {def.availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={defaultModel}
                onChange={(e) => setDefModel(e.target.value)}
                placeholder="gpt-4o"
                className={inputCls}
              />
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={() => void handleTest()} disabled={testing || !apiKey} className={btnSecCls}>
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button type="button" onClick={() => void handleSave()} disabled={saving} className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {state?.has_api_key && (
              <button
                type="button"
                onClick={() => { setApiKey(''); setEnabled(false); void removeByokProvider(def.id); }}
                disabled={saving}
                className={btnSecCls}
                title="Delete this key from the OS keychain"
              >
                Remove key
              </button>
            )}
            {testMsg && <span className={cn('text-xs', testMsg.startsWith('✓') ? 'text-success' : 'text-error')}>{testMsg}</span>}
            {saveMsg && <span className={cn('text-xs', saveMsg.startsWith('✓') ? 'text-text-muted' : 'text-error')}>{saveMsg}</span>}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Merge the gateway catalog with the bundled defs. Catalog wins on
 *  identity data (name, base-URL support, key format); local defs
 *  contribute `availableModels` and any row the catalog doesn't carry
 *  (Custom Endpoint, or curated rows when the gateway is older).
 *  Offline (empty catalog) → bundled defs unchanged, exactly as before. */
function mergeProviderDefs(
  catalog: ReturnType<typeof useCatalog.getState>['providerCatalog'],
): ProviderDef[] {
  if (catalog.length === 0) return [...PROVIDER_DEFS];
  const localById = new Map(PROVIDER_DEFS.map((d) => [d.id, d]));
  const merged: ProviderDef[] = catalog.map((entry) => {
    const local = localById.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      hasBaseUrl: entry.supports_custom_base_url,
      baseUrlHint: entry.supports_custom_base_url ? entry.default_base_url : '',
      availableModels: local?.availableModels,
      keyPrefix: entry.key_format ?? local?.keyPrefix,
    };
  });
  const catalogIds = new Set(catalog.map((e) => e.id));
  for (const def of PROVIDER_DEFS) {
    if (!catalogIds.has(def.id)) merged.push(def);
  }
  return merged;
}

export function ByokTab() {
  const byok = useSettings((s) => s.byok);
  const providerCatalog = useCatalog((s) => s.providerCatalog);
  const loadProvider = useCatalog((s) => s.loadProvider);
  const [q, setQ] = useState('');
  const [onlyConfigured, setOnlyConfigured] = useState(false);

  useEffect(() => {
    void loadProvider();
  }, [loadProvider]);

  const defs = mergeProviderDefs(providerCatalog);
  const filtered = defs.filter((d) => {
    if (onlyConfigured) {
      const s = byok.find((b) => b.id === d.id);
      if (!s?.has_api_key) return false;
    }
    if (q.trim()) {
      const needle = q.toLowerCase();
      if (!d.name.toLowerCase().includes(needle) && !d.id.toLowerCase().includes(needle)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Cloud Keys</h2>
        <p className="text-xs text-text-muted mt-1">Add API keys to use cloud AI providers alongside local models.</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search providers…"
          className="flex-1 min-w-0 rounded-md border border-border-subtle bg-bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none shrink-0">
          <input type="checkbox" checked={onlyConfigured} onChange={(e) => setOnlyConfigured(e.target.checked)} className="rounded" />
          Configured only
        </label>
      </div>
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">No providers match.</p>
        ) : (
          filtered.map((def) => (
            <ProviderRow key={def.id} def={def} state={byok.find((b) => b.id === def.id)} />
          ))
        )}
      </div>
    </div>
  );
}
