import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Eye, EyeOff, Plus, Search, Server } from 'lucide-react';
import { cn, SECONDARY_BUTTON } from '@/lib/utils';
import { SelectMenu } from '@/components/ui/select-menu';
import { BTN_PRIMARY, CARD, MakerTile, Pill, SectionHeader, Status, type Maker } from '@/components/models/ui';
import { useSettings, type ByokProviderUpdate } from '@/stores/settings';
import { useCatalog } from '@/stores/catalog';
import { tauri, type ByokProvider } from '@/lib/tauri';
import { CHATGPT_ID, MANAGE_USAGE, planFirst, signInWithChatGPT } from '@/lib/chatgptSignIn';
import chutesMark from '@/assets/brands/chutes.png';
import gmiMark from '@/assets/brands/gmi.png';
import { BASE, FAST } from '@/lib/motion';

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
  { id: 'kimi',       name: 'Kimi Code',       hasBaseUrl: false, baseUrlHint: '',                              availableModels: ['kimi-for-coding'] as const,                                                                    keyPrefix: 'sk-kimi-' },
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
  kimi: "Kimi Code subscription. Its key starts with sk-kimi-; a Moonshot platform key goes in Kimi API.",
  moonshot: "Kimi API, paid per use. A key from platform.moonshot.ai; a Kimi Code key goes in Kimi Code.",
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
  kimi: { key: 'moonshotai', label: 'Kimi Code' },
  glm: { key: 'z-ai', label: 'Z.ai' },
  minimax: { key: 'minimax', label: 'MiniMax', color: '#F23F5D' },
  deepseek: { key: 'deepseek', label: 'DeepSeek', color: '#4D6BFE' },
  groq: { key: 'groq', label: 'Groq', color: '#F55036' },
  mistral: { key: 'mistral', label: 'Mistral', color: '#FA520F' },
  openrouter: { key: 'openrouter', label: 'OpenRouter', color: '#6467F2' },
  nvidia: { key: 'nvidia', label: 'NVIDIA', color: '#76B900' },
  chutes: { key: '', label: 'Chutes', image: chutesMark },
  gmi: { key: '', label: 'GMI Cloud', image: gmiMark },
  baseten: { key: 'baseten', label: 'Baseten' },
  byteplus: { key: 'byteplus', label: 'BytePlus' },
  cerebras: { key: 'cerebras', label: 'Cerebras' },
  cohere: { key: 'cohere', label: 'Cohere', color: '#39594D' },
  deepinfra: { key: 'deepinfra', label: 'DeepInfra' },
  featherless: { key: 'featherless', label: 'Featherless' },
  fireworks: { key: 'fireworks', label: 'Fireworks' },
  huggingface: { key: 'huggingface', label: 'Hugging Face', color: '#FF9D00' },
  kilocode: { key: 'kilocode', label: 'Kilo Code' },
  longcat: { key: 'longcat', label: 'LongCat' },
  moonshot: { key: 'moonshot', label: 'Kimi API (Moonshot)' },
  novita: { key: 'novita', label: 'Novita' },
  opencode: { key: 'opencode', label: 'OpenCode Zen' },
  qianfan: { key: 'qianfan', label: 'Baidu Qianfan' },
  qwen: { key: 'qwen', label: 'Alibaba Qwen', color: '#615CED' },
  stepfun: { key: 'stepfun', label: 'StepFun' },
  'tencent-tokenhub': { key: 'tencent', label: 'Tencent Hunyuan' },
  together: { key: 'together', label: 'Together AI' },
  venice: { key: 'venice', label: 'Venice' },
  volcengine: { key: 'volcengine', label: 'Volcengine' },
  xai: { key: 'xai', label: 'xAI' },
  xiaomi: { key: 'xiaomi', label: 'Xiaomi MiMo' },
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

  // A provider with no record starts ON: pasting a key and pressing Save is the
  // whole job. Off by default, a tested, saved key stayed "Turned off" and
  // nothing answered (UX lab, 19 Oct, item 3: the default nobody set).
  const [enabled, setEnabled]       = useState(state?.enabled ?? true);
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
        // The first key for a provider turns it on, even one that was saved off
        // before; switching it off again stays the person's choice.
        enabled: enabled || (!state?.has_api_key && apiKey.trim() !== ''),
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

  // The card stays where it is and its settings open on a row of their own
  // right under it (1 Nov, Darius: "repara animatiile"). Before, the open card
  // took a whole row: one click moved six cards, the clicked one jumped to the
  // next row, and the `layout` scale squashed its logo to 74x18 on the way.
  // In the dense grid the cards after it fill the rest of its row again, so
  // only the rows below move, and only down.
  return (
    <>
      <article
        className={cn(CARD, 'mb-4 overflow-hidden transition-shadow hover:shadow-md', open && 'shadow-md ring-1 ring-brand/30')}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`byok-${def.id}`}
          className="block w-full p-5 text-left"
        >
          <span className="flex items-center gap-4">
            <ProviderMark def={def} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg font-semibold text-text-primary">{def.name}</span>
              {configured
                ? (isActive ? <Status tone="success">Connected</Status> : <Status tone="neutral">Turned off</Status>)
                : <span className="text-xs text-text-muted">Not configured</span>}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {configured && <Pill tone="success" dot>API key added</Pill>}
              <motion.span animate={{ rotate: open ? 180 : 0 }} transition={FAST} className="inline-flex text-text-muted">
                <ChevronDown size={16} />
              </motion.span>
            </span>
          </span>
          {blurb && <span className="mt-3 block text-sm text-text-secondary">{blurb}</span>}
        </button>

        {configured && (
          <div className="-mt-1 px-5 pb-5">
            <p className="text-micro font-medium uppercase tracking-wider text-text-muted">Default model</p>
            <p className="mt-1 truncate rounded-xl border border-border-subtle bg-bg-elevated/60 px-3 py-2 text-sm text-text-primary">
              {state?.default_model || 'The provider\u2019s default'}
            </p>
          </div>
        )}
      </article>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`byok-${def.id}`}
            role="region"
            aria-label={`${def.name} settings`}
            // Rows are spaced by margins, not the grid gap: a gap cannot be animated,
            // so a new row jumped 16 px. This margin grows with the height instead.
            initial={{ height: 0, opacity: 0, marginBottom: 0 }}
            animate={{ height: 'auto', opacity: 1, marginBottom: 16 }}
            exit={{ height: 0, opacity: 0, marginBottom: 0 }}
            transition={BASE}
            className="col-span-full overflow-hidden"
          >
            <div className={cn(CARD, 'grid gap-5 bg-bg-elevated/40 p-5 md:grid-cols-2')}>
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
                    className={cn('w-10 h-6 rounded-full transition-colors duration-(--motion-base) relative shrink-0 overflow-hidden', enabled ? 'bg-brand' : 'bg-border-default')}
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
                      // "gpt-4o" here sent NVIDIA NIM users to a model NIM does not
                      // serve (UX lab, item 16). A real example per provider, else words.
                      placeholder={def.id === 'nvidia' ? 'meta/llama-3.3-70b-instruct' : 'The model name, as the provider writes it'}
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
    </>
  );
}

/**
 * OpenAI Subscription: a ChatGPT plan instead of an API key (1 Nov, Darius).
 * Plenty of people pay for ChatGPT and have never opened the API platform; one
 * sign-in in the browser and Cinderpaw's answers count against that plan. The
 * host keeps the token; this card only signs in, picks the model, signs out.
 */
function ChatgptCard({ state, onUseKey }: { state?: ByokProvider; onUseKey?: () => void }) {
  const fetchByok = useSettings((s) => s.fetchByok);
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const [account, setAccount] = useState<{ email: string | null; name: string | null } | null>(null);
  const [models, setModels] = useState<{ id: string; name: string | null }[]>([]);
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = !!state;

  useEffect(() => {
    if (!connected) return;
    void tauri.raw.chatgptAccount().then(setAccount).catch(() => {});
    void tauri.raw.chatgptModels().then(setModels).catch((e) => setError(String(e)));
  }, [connected]);

  const signIn = async () => {
    setBusy('in');
    setError(null);
    try {
      await signInWithChatGPT();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy('out');
    setError(null);
    try {
      await tauri.raw.chatgptSignOut();
    } catch (e) {
      // Signed out here; OpenAI could not confirm, and the reason says where to finish.
      setError(String(e));
    } finally {
      await fetchByok();
      setAccount(null);
      setBusy(null);
    }
  };

  const who = account?.email ?? account?.name;
  return (
    <article className={cn(CARD, 'mb-4 p-5', connected && 'shadow-md')}>
      <div className="flex items-center gap-4">
        <MakerTile maker={PROVIDER_MARK.openai ?? null} fallback="OpenAI" className="rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold text-text-primary">OpenAI Subscription</p>
          {connected
            ? <Status tone="success">{who ? `Signed in as ${who}` : 'Connected'}</Status>
            : <span className="text-xs text-text-muted">Not connected</span>}
        </div>
        {connected && <Pill tone="success" dot>Using your ChatGPT plan</Pill>}
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        {connected
          ? 'Answers count against your ChatGPT plan, not a separate bill.'
          : 'Use your ChatGPT plan (Go, Plus or Pro). No API key, no separate bill.'}
      </p>
      {connected ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {models.length > 0 && (
            <SelectMenu
              value={state?.default_model ?? models[0]!.id}
              onChange={(m) => void saveByokProvider({ providerId: CHATGPT_ID, enabled: true, apiKey: '', baseUrl: null, defaultModel: m })}
              ariaLabel="Model"
              className="min-w-48"
              options={models.map((m) => ({ value: m.id, label: m.name ?? m.id }))}
            />
          )}
          <a href={MANAGE_USAGE} target="_blank" rel="noreferrer" className={SECONDARY_BUTTON}>Manage usage</a>
          <button type="button" onClick={() => void signOut()} disabled={busy !== null} className={cn(SECONDARY_BUTTON, 'hover:text-error')}>
            {busy === 'out' ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void signIn()} disabled={busy !== null} className={BTN_PRIMARY}>
            {busy === 'in' ? 'Finish in your browser…' : 'Continue with ChatGPT'}
          </button>
          {busy === 'in' ? (
            <span className="text-xs text-text-muted">A ChatGPT page opened in your browser. Allow Cinderpaw there.</span>
          ) : onUseKey && (
            <button type="button" onClick={onUseKey} className="text-sm text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
              Use an API key instead
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-xs text-error">{error}</p>}
    </article>
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
  const [keyAsked, setKeyAsked] = useState(false);
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
  // Its row exists only while signed in, and it is not in the key catalog.
  const chatgpt = stateOf(CHATGPT_ID);
  const offerChatgpt = !chatgpt && (!q.trim() || 'openai subscription chatgpt plan'.includes(q.trim().toLowerCase()));
  // The plan card takes OpenAI's place (1 Nov, Darius): most people who pay
  // OpenAI pay for ChatGPT, not the API. The key card comes when asked for,
  // and stays once a key is saved.
  const connected = planFirst(defs.filter((d) => stateOf(d.id)?.has_api_key));
  const available = defs.filter(
    (d) => !stateOf(d.id)?.has_api_key && matches(d) && !(d.id === 'openai' && offerChatgpt && !keyAsked),
  );
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

        {connected.length > 0 || chatgpt ? (
          <div className="grid grid-flow-row-dense -mb-4 items-start gap-x-4 md:grid-cols-2">
            {chatgpt && <ChatgptCard state={chatgpt} />}
            {connected.map(card)}
          </div>
        ) : (
          <div className={cn(CARD, 'px-5 py-6 text-sm text-text-secondary')}>
            No provider connected yet. Pick one below and paste its key; it takes a minute.
          </div>
        )}
      </div>

      <section ref={addRef} className="scroll-mt-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="font-display text-xl text-text-primary">Add another provider</h3>
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
        {available.length === 0 && !offerChatgpt ? (
          <p className="py-4 text-center text-sm text-text-muted">{q.trim() ? 'No providers match.' : 'Every provider already has a key.'}</p>
        ) : (
          <div className="grid grid-flow-row-dense -mb-4 items-start gap-x-4 md:grid-cols-2 lg:grid-cols-3">
            {offerChatgpt && <ChatgptCard onUseKey={() => { setKeyAsked(true); setOpenId('openai'); }} />}
            {available.map(card)}
          </div>
        )}
      </section>
    </div>
  );
}
