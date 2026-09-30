import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Eye, EyeOff, Plus, Search, Server } from 'lucide-react';
import { cn, SECONDARY_BUTTON } from '@/lib/utils';
import { SelectMenu } from '@/components/ui/select-menu';
import { BTN_PRIMARY, CARD, MakerTile, Pill, SERIF, SectionHeader, Status, type Maker } from '@/components/models/ui';
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

/** One line on what each provider is for, in plain words. */
const PROVIDER_BLURB: Record<string, string> = {
  openai: 'GPT models for general-purpose work.',
  anthropic: 'Claude models, strong at reasoning and writing.',
  google: 'Gemini models: multimodal, with long context.',
  kimi: "Moonshot's Kimi, tuned for coding.",
  glm: "Z.ai's GLM family of open-weight models.",
  minimax: 'MiniMax models with very long context.',
  deepseek: 'DeepSeek chat and reasoning models.',
  groq: 'Very fast inference for open models.',
  mistral: "Mistral AI's efficient models.",
  openrouter: 'Hundreds of models through one API key.',
  nvidia: 'Open models hosted by NVIDIA (NIM).',
  custom: 'Any OpenAI-compatible endpoint you run or rent.',
};

/** The mark and colour each provider is known by (keys of the logo set). */
const PROVIDER_MARK: Record<string, Maker> = {
  openai: { key: 'openai', label: 'OpenAI' },
  anthropic: { key: 'anthropic', label: 'Anthropic', color: '#D97757' },
  google: { key: 'google', label: 'Google', color: '#3186FF' },
  kimi: { key: 'moonshotai', label: 'Kimi' },
  glm: { key: 'z-ai', label: 'Z.ai' },
  minimax: { key: 'minimax', label: 'MiniMax', color: '#F23F5D' },
  deepseek: { key: 'deepseek', label: 'DeepSeek', color: '#4D6BFE' },
  groq: { key: 'groq', label: 'Groq', color: '#F55036' },
  mistral: { key: 'mistral', label: 'Mistral', color: '#FA520F' },
  openrouter: { key: 'openrouter', label: 'OpenRouter', color: '#6467F2' },
  nvidia: { key: 'nvidia', label: 'NVIDIA', color: '#76B900' },
};

function ProviderMark({ def, className }: { def: ProviderDef; className?: string }) {
  if (def.id === 'custom') {
    return (
      <span aria-hidden className={cn('inline-flex size-12 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated text-text-secondary', className)}>
        <Server size={20} />
      </span>
    );
  }
  return <MakerTile maker={PROVIDER_MARK[def.id] ?? null} fallback={def.name} className={cn('rounded-full', className)} />;
}

function ProviderCard({ def, state, open, onToggle }: { def: ProviderDef; state?: ByokProvider; open: boolean; onToggle: () => void }) {
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const removeByokProvider = useSettings((s) => s.removeByokProvider);
  const testByokProvider = useSettings((s) => s.testByokProvider);

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
      // (keychain locked, disk full, permission denied on ~/.cinderpaw/byok.json,
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

  const inputCls = 'w-full h-9 px-3 rounded-xl border border-border-subtle bg-bg-surface text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-brand/30';
  const btnSecCls = SECONDARY_BUTTON;
  const configured = !!state?.has_api_key;
  const blurb = PROVIDER_BLURB[def.id];

  return (
    <motion.article
      layout
      transition={{ layout: { duration: 0.25, ease: [0.2, 0.8, 0.2, 1] } }}
      className={cn(CARD, 'overflow-hidden transition-shadow hover:shadow-md', open && 'md:col-span-2 lg:col-span-full shadow-md ring-1 ring-brand/15')}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="block w-full p-5 text-left"
      >
        <span className="flex items-center gap-4">
          <ProviderMark def={def} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-semibold text-text-primary" style={{ fontFamily: SERIF }}>{def.name}</span>
            {configured
              ? (isActive ? <Status tone="success">Connected</Status> : <Status tone="neutral">Turned off</Status>)
              : <span className="text-xs text-text-muted">Not configured</span>}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {configured && <Pill tone="success" dot>API key added</Pill>}
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.18 }} className="inline-flex text-text-muted">
              <ChevronDown size={16} />
            </motion.span>
          </span>
        </span>
        {blurb && <span className="mt-3 block text-sm text-text-secondary">{blurb}</span>}
      </button>

      {configured && !open && (
        <div className="-mt-1 px-5 pb-5">
          <p className="text-micro font-medium uppercase tracking-wider text-text-muted">Default model</p>
          <p className="mt-1 truncate rounded-xl border border-border-subtle bg-bg-elevated/60 px-3 py-2 text-sm text-text-primary">
            {state?.default_model || 'The provider\u2019s default'}
          </p>
        </div>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="grid gap-5 border-t border-border-subtle bg-bg-elevated/40 p-5 md:grid-cols-2">
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-surface px-3 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Enabled</p>
                    <p className="text-2xs text-text-muted">Off keeps the key but hides the provider&apos;s models.</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label="Enabled"
                    onClick={() => setEnabled(!enabled)}
                    className={cn('w-10 h-6 rounded-full transition-colors duration-200 relative shrink-0 overflow-hidden', enabled ? 'bg-brand' : 'bg-border-default')}
                  >
                    <span className={cn('absolute top-1 left-0 w-4 h-4 rounded-full bg-primary-foreground transition-transform', enabled ? 'translate-x-5' : 'translate-x-1')} />
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-text-secondary">API Key</label>
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
                      className="inline-flex size-9 items-center justify-center rounded-xl border border-border-subtle text-text-muted hover:bg-bg-hover"
                      aria-label={showKey ? 'Hide key' : 'Show key'}
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {def.keyPrefix && apiKey.startsWith(def.keyPrefix) && (
                    <p className="text-xs text-success mt-1">✓ {def.name} key detected</p>
                  )}
                  <p className="text-2xs text-text-muted">Stored in your computer&apos;s keychain, never in a file.</p>
                </div>
              </div>

              <div className="space-y-4">
                {def.hasBaseUrl && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-text-secondary">
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
                  <label className="text-xs font-medium text-text-secondary">
                    {def.availableModels ? 'Model' : 'Default model (optional)'}
                  </label>
                  {def.availableModels ? (
                    <SelectMenu
                      value={defaultModel}
                      onChange={setDefModel}
                      ariaLabel="Model"
                      className="w-full"
                      options={def.availableModels.map((m) => ({ value: m, label: m }))}
                    />
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

                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <button type="button" onClick={() => void handleSave()} disabled={saving} className={BTN_PRIMARY}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" onClick={() => void handleTest()} disabled={testing || !apiKey} className={btnSecCls}>
                    {testing ? 'Testing…' : 'Test'}
                  </button>
                  {state?.has_api_key && (
                    <button
                      type="button"
                      onClick={() => { setApiKey(''); setEnabled(false); void removeByokProvider(def.id); }}
                      disabled={saving}
                      className={cn(btnSecCls, 'hover:text-error')}
                      title="Delete this key from the OS keychain"
                    >
                      Remove key
                    </button>
                  )}
                </div>
                {testMsg && <p className={cn('text-xs', testMsg.startsWith('✓') ? 'text-success' : 'text-error')}>{testMsg}</p>}
                {saveMsg && <p className={cn('text-xs', saveMsg.startsWith('✓') ? 'text-text-muted' : 'text-error')}>{saveMsg}</p>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
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
  const [openId, setOpenId] = useState<string | null>(null);
  const addRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void loadProvider();
  }, [loadProvider]);

  const defs = mergeProviderDefs(providerCatalog);
  const stateOf = (id: string) => byok.find((b) => b.id === id);
  const matches = (d: ProviderDef) => {
    if (!q.trim()) return true;
    const needle = q.toLowerCase();
    return d.name.toLowerCase().includes(needle) || d.id.toLowerCase().includes(needle);
  };
  // A provider with a key is "yours" and gets a big card at the top; the rest
  // wait below as the ways to add another.
  const connected = defs.filter((d) => stateOf(d.id)?.has_api_key);
  const available = defs.filter((d) => !stateOf(d.id)?.has_api_key && matches(d));
  const card = (def: ProviderDef) => (
    <ProviderCard
      key={def.id}
      def={def}
      state={stateOf(def.id)}
      open={openId === def.id}
      onToggle={() => setOpenId((cur) => (cur === def.id ? null : def.id))}
    />
  );

  return (
    <div className="space-y-8">
      <div className="space-y-5">
        <SectionHeader title="Cloud Providers" subtitle="Add API keys to use cloud models alongside local ones, and pick each provider's default model.">
          <button type="button" onClick={() => addRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className={BTN_PRIMARY}>
            <Plus size={16} /> Add provider
          </button>
        </SectionHeader>

        {connected.length > 0 ? (
          <div className="grid grid-flow-row-dense items-start gap-4 md:grid-cols-2">{connected.map(card)}</div>
        ) : (
          <div className={cn(CARD, 'px-5 py-6 text-sm text-text-secondary')}>
            No provider connected yet. Pick one below and paste its key; it takes a minute.
          </div>
        )}
      </div>

      <section ref={addRef} className="scroll-mt-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold text-text-primary" style={{ fontFamily: SERIF }}>Add another provider</h3>
            <p className="text-sm text-text-secondary">Connect more providers to widen what Cinderpaw can use.</p>
          </div>
          <label className="flex h-9 w-full items-center gap-2 rounded-xl border border-border-subtle bg-bg-surface px-3 shadow-sm focus-within:ring-2 focus-within:ring-brand/30 sm:w-64">
            <Search size={14} className="shrink-0 text-text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search providers…"
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-hidden"
            />
          </label>
        </div>
        {available.length === 0 ? (
          <p className="py-4 text-center text-sm text-text-muted">{q.trim() ? 'No providers match.' : 'Every provider already has a key.'}</p>
        ) : (
          <div className="grid grid-flow-row-dense items-start gap-4 md:grid-cols-2 lg:grid-cols-3">{available.map(card)}</div>
        )}
      </section>
    </div>
  );
}
