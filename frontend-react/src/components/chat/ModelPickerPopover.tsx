import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Star } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useModel, type Effort } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { refreshCatalog } from '@/lib/modelCatalog';
import { ModelLogo, modelDisplayName, providerName } from '@/lib/modelLogos';
import { tauri, type ModelInfo, type ByokProvider } from '@/lib/tauri';
import { router } from '@/router';
import { CHATGPT_ID, MANAGE_USAGE, planFirst, signInWithChatGPT } from '@/lib/chatgptSignIn';
import { EFFORTS, effortKey, effortReaches } from '@/lib/effort';
import { BackendBadge } from '@/components/BackendBadge';
import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.svg';
import { isLocalEngineUrl, localApiBase } from '@/lib/localApi';
import { useBareModel } from '@/lib/bareModel';

/** Dev builds only: answer with the model alone, for the harness-vs-no-harness film. */
function BareModelItem() {
  const { on, toggle } = useBareModel();
  return (
    <DropdownMenuItem onSelect={(e) => { e.preventDefault(); toggle(); }} className="justify-between text-sm text-text-secondary">
      <span>Bare model <span className="text-text-muted">· dev, no Cinderpaw</span></span>
      {on && <Check size={14} className="shrink-0" />}
    </DropdownMenuItem>
  );
}

// Cinderpaw's own model engine exposes an OpenAI-compatible API here. In agent mode
// a local pick must target THIS (not external Ollama on 11434) so the agent uses
// the model loaded in the Models tab.
const LOCAL_PROVIDER_ID = 'cinderpaw-local';

/** A provider's models, asked once per session: they change in months, not minutes. */
type ProviderModel = { id: string; name: string | null };
const modelsByProvider = new Map<string, ProviderModel[]>();

/** Rows a provider shows in All before anything is typed; the rest are a search away. */
const REST_CAP = 6;
/**
 * Rows a provider shows for a search. All 320 of OpenRouter's froze the window
 * for 416 ms when its page opened (dev build, 1 Nov); nobody reads 320 rows,
 * they type a name.
 */
const LIST_CAP = 40;

function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

/**
 * Starred models: one click to the two or three a person really uses, instead
 * of provider, page, scroll (Hermes ships the same, 1 Nov). Kept in this
 * browser's storage: a convenience, never a setting the engine needs.
 */
type Fav = { provider: string; model: string };
const FAV_KEY = 'cinderpaw.favoriteModels';
function readFavs(): Fav[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((f): f is Fav => typeof f?.provider === 'string' && typeof f?.model === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The job a model is good for, in words a stranger knows (4 Nov study: people do
 * not know Haiku from Sonnet). ponytail: a name match; the brain's own profiles
 * (model-profiles.ts) are the better source once the host passes them up.
 */
const jobOf = (modelId: string) => (/haiku|mini|flash|nano|lite|small|fast|:free|\b[1-9]b\b/i.test(modelId) ? 'Fast' : 'Smart');

// Cubby's head and horns, the same paths as assets/logo.svg.
const LOGO_HEAD = 'M128.0 60.2C119.3 60.2 110.5 60.6 101.9 61.9C93.3 63.1 84.5 64.6 76.4 67.7C68.4 70.8 60.2 74.9 53.7 80.3C47.1 85.8 41.3 92.9 36.9 100.3C32.5 107.6 29.5 116.2 27.3 124.5C25.2 132.9 24.3 141.8 24.0 150.5C23.7 159.1 24.0 168.1 25.8 176.5C27.5 185.0 30.1 193.8 34.5 201.1C38.9 208.3 45.3 215.2 52.2 220.1C59.2 225.0 67.8 228.0 76.1 230.5C84.4 233.0 93.2 234.1 101.9 235.0C110.5 235.9 119.3 236.0 128.0 236.0C136.7 236.0 145.5 235.9 154.2 235.0C162.8 234.1 171.6 233.0 179.9 230.5C188.2 228.0 196.9 225.0 203.8 220.0C210.7 215.1 217.1 208.3 221.5 201.1C225.9 193.8 228.5 184.9 230.2 176.5C232.0 168.1 232.3 159.1 232.0 150.4C231.7 141.8 230.8 132.9 228.7 124.5C226.5 116.1 223.5 107.6 219.1 100.3C214.7 92.9 208.9 85.8 202.3 80.3C195.7 74.9 187.6 70.8 179.6 67.7C171.5 64.6 162.7 63.1 154.1 61.9C145.5 60.6 136.7 60.2 128.0 60.2Z';
const LOGO_HORNS = [
  'M44.9 27.0C42.9 26.8 39.9 29.8 37.9 31.8C36.0 33.9 34.8 36.8 33.2 39.2C31.6 41.7 30.0 44.2 28.3 46.5C26.6 48.9 24.8 51.2 22.9 53.5C21.1 55.7 18.8 57.7 17.1 60.0C15.4 62.3 13.6 64.8 12.7 67.5C11.7 70.2 11.3 73.4 11.5 76.2C11.8 79.0 12.8 82.0 14.3 84.4C15.8 86.8 18.1 89.0 20.5 90.5C22.9 92.0 26.1 93.6 28.7 93.5C31.3 93.4 33.8 91.8 35.9 90.1C38.1 88.4 39.5 85.4 41.5 83.3C43.5 81.1 45.6 79.1 47.8 77.2C50.0 75.3 53.0 73.8 54.8 71.8C56.6 69.8 58.9 67.5 58.5 65.3C58.2 63.1 54.1 61.3 52.6 58.8C51.1 56.4 50.0 53.6 49.4 50.8C48.9 48.0 49.4 44.9 49.5 42.0C49.6 39.1 50.7 35.8 49.9 33.3C49.1 30.8 46.9 27.2 44.9 27.0Z',
  'M207.5 29.1C206.0 30.6 206.1 34.8 206.0 37.6C205.9 40.5 207.0 43.5 206.9 46.4C206.8 49.3 206.6 52.4 205.5 55.0C204.4 57.6 201.7 59.7 200.4 62.1C199.1 64.5 196.9 67.2 197.7 69.2C198.4 71.3 202.5 72.6 204.8 74.4C207.1 76.2 209.3 78.1 211.4 80.1C213.5 82.2 215.5 84.3 217.5 86.5C219.4 88.7 220.6 92.3 223.0 93.3C225.3 94.3 228.9 93.4 231.6 92.5C234.2 91.6 237.0 89.9 239.0 87.9C241.0 85.9 242.6 83.1 243.5 80.5C244.4 77.8 244.7 74.6 244.3 71.8C244.0 69.0 242.9 66.1 241.5 63.6C240.1 61.0 237.9 59.0 236.0 56.7C234.1 54.5 232.1 52.4 230.3 50.1C228.4 47.8 226.8 45.3 225.2 42.9C223.5 40.5 222.1 37.9 220.5 35.5C218.8 33.1 217.3 29.7 215.1 28.6C212.9 27.5 209.0 27.6 207.5 29.1Z',
];

/**
 * Automatic's mark: Cinderpaw's own logo as lines, no colours (4 Nov, his call;
 * it replaces an A). Head, horns and eyes only: with the muzzle too it was a
 * blur at 18 px. Drawn in the text colour, so it reads on both themes.
 */
function AutoMark({ size }: { size: 'sm' | 'md' }) {
  // The horns stop where the head covers them. One id per mark: a menu and the
  // button can both be on screen.
  const id = `automark-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      aria-hidden
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={20}
      strokeLinejoin="round"
      className={cn('shrink-0', size === 'sm' ? 'size-[18px]' : 'size-6')}
    >
      <mask id={id} maskUnits="userSpaceOnUse" x="-40" y="-40" width="340" height="340">
        <rect x="-40" y="-40" width="340" height="340" fill="#fff" />
        <path d={LOGO_HEAD} fill="#000" stroke="none" />
      </mask>
      <g mask={`url(#${id})`}>{LOGO_HORNS.map((d) => <path key={d} d={d} />)}</g>
      <path d={LOGO_HEAD} />
      <g fill="currentColor" stroke="none">
        <ellipse cx="87" cy="168.2" rx="15" ry="24" />
        <ellipse cx="169" cy="168.2" rx="15" ry="24" />
      </g>
    </svg>
  );
}

const modelName = (m: ProviderModel) => (m.name ? m.name.replace(/^[^:]{1,40}:\s+/, '') : modelDisplayName(m.id));

/** A model's name as its provider writes it ("GPT 6.1 Sol"), once its list is in; else one made from the id. */
const nameFor = (providerId: string | undefined, modelId: string) => {
  const m = providerId ? modelsByProvider.get(providerId)?.find((x) => x.id === modelId) : undefined;
  return m ? modelName(m) : modelDisplayName(modelId);
};

type Tab = 'fav' | 'all' | 'here';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'fav', label: 'Favorites' },
  { id: 'all', label: 'All' },
  { id: 'here', label: 'This computer' },
];

/**
 * The model picker, in the shape of the 21st.dev prompt composer's menu (MIT,
 * neeraj singh), Darius's pick on 2 Nov over the provider pages of 1 Nov: a
 * search on top, Favorites / All / This computer, and every cloud model one
 * click away under its provider's name. A model whose provider takes Effort
 * opens it to the side on hover, and keeps its own: Sonnet on High, Haiku on
 * Low. Roles stay in Roles and settings.
 */
export function ModelPickerPopover() {
  const loaded        = useModel((s) => s.loaded);
  const isLoading     = useModel((s) => s.isLoading);
  const progress      = useModel((s) => s.loadProgress);
  const load          = useModel((s) => s.load);
  const effortByModel = useModel((s) => s.effortByModel);
  const setEffort     = useModel((s) => s.setEffort);
  const rememberEffort = useModel((s) => s.rememberEffort);

  // The picker targets the Cinderpaw sidecar's own model config.
  const cinderpawConfig   = useCinderpawStore((s) => s.modelConfig);
  const cinderpawSwitching = useCinderpawStore((s) => s.switching);
  const cinderpawSetModel = useCinderpawStore((s) => s.setModel);
  const cinderpawSetError = useCinderpawStore((s) => s.setModelError);
  const cinderpawStarting = useCinderpawStore((s) => !s.isReady && !s.offline);
  const automatic = useCinderpawStore((s) => s.automatic);
  const setAutomatic = useCinderpawStore((s) => s.setAutomatic);
  // The menu opens on the short list (one switch, a few rows); every model is
  // one step further, under All models (4 Nov, his pick: mockup C).
  const [view, setView] = useState<'simple' | 'all'>('simple');

  const [localModels, setLocalModels]     = useState<ModelInfo[]>([]);
  const [cloudProviders, setCloudProviders] = useState<ByokProvider[]>([]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>('all');
  // A provider whose list could not be fetched says so under its own name.
  const [listErrors, setListErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  // A provider's list arriving redraws the names that come from it.
  const [, listsIn] = useState(0);
  const [favs, setFavs] = useState<Fav[]>(readFavs);
  const isFav = (provider: string, model: string) => favs.some((f) => f.provider === provider && f.model === model);
  const toggleFav = (provider: string, model: string) =>
    setFavs((prev) => {
      const next = prev.some((f) => f.provider === provider && f.model === model)
        ? prev.filter((f) => !(f.provider === provider && f.model === model))
        : [...prev, { provider, model }];
      try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
      return next;
    });

  /**
   * Every provider that HAS a key, enabled or not.
   *
   * Filtering on `enabled` too made a real trap: the enable switch in Settings →
   * Cloud Keys starts off for a new provider, so pasting a key, setting a model
   * and pressing Save stored everything correctly, said "✓ Saved", and left the
   * provider invisible here with nothing explaining why. A provider with a key is
   * now always listed — disabled ones are shown as such, and can be switched on
   * from the row itself.
   */
  const refreshCloud = () =>
    tauri.raw
      .getByokSettings()
      .then((providers) => setCloudProviders(planFirst(providers.filter((p) => p.has_api_key))))
      .catch(() => {});

  // Once at mount as well as on every open. Asked only on open, the trigger
  // said "Add a model" on a machine with three keys active until someone
  // clicked it: the label was computed from lists that were still empty.
  useEffect(() => {
    void tauri.models.list().then((all) => setLocalModels(all.filter((m) => !m.is_embedding))).catch(() => {});
    void refreshCloud();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at mount
  }, []);

  const onLocal = !!cinderpawConfig && (cinderpawConfig.provider === LOCAL_PROVIDER_ID || isLocalEngineUrl(cinderpawConfig.base_url));

  const fetchList = (id: string) => {
    setListErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    void tauri.raw
      .providerModels(id)
      .then((list) => { modelsByProvider.set(id, list); listsIn((n) => n + 1); })
      .catch((e) => setListErrors((prev) => ({ ...prev, [id]: String(e) })));
  };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setView('simple');
    // It opens where the model answering now is: this computer, Favorites when
    // it is starred, else All; with none chosen and no cloud key, on what
    // there is to pick.
    const noneChosen = !cinderpawConfig?.model;
    setTab(
      onLocal || (noneChosen && cloudProviders.length === 0 && localModels.length > 0)
        ? 'here'
        : cinderpawConfig && isFav(cinderpawConfig.provider, cinderpawConfig.model) ? 'fav' : 'all',
    );
      // Embedding models are on disk but cannot hold a conversation, and
      // `bge-m3` sorts before every chat model on a normal install, so it was
      // the first row here and menus focus their first row on open. Opening the
      // picker looked like it had chosen the one model that can only ever
      // return vectors. `is_embedding` exists on ModelInfo for exactly this;
      // the Models tab and the download panel deliberately do not filter,
      // because deleting a file you cannot see is worse.
    void tauri.models
      .list()
      .then((all) => setLocalModels(all.filter((m) => !m.is_embedding)))
      .catch(() => {});
    // Each switched-on provider's list, once a session: All shows them all, and
    // the rows say each model as its provider names it, the same everywhere.
    void tauri.raw
      .getByokSettings()
      .then((providers) => {
        setCloudProviders(planFirst(providers.filter((p) => p.has_api_key)));
        for (const p of providers) {
          if (p.has_api_key && p.enabled && !modelsByProvider.has(p.id)) fetchList(p.id);
        }
      })
      .catch(() => {});
    // Names for cloud models come from the published catalogue, cached for a
    // day. Asked when the picker opens rather than at startup, so a local-only
    // install still never calls out.
    void refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshCloud is stable enough; open is the trigger
  }, [open]);

  // Selecting a local model must LOAD it into Cinderpaw's engine
  // (so /v1/chat/completions has it resident) then point the sidecar at it.
  // Goes through the model store's load() so isLoading/loadProgress are
  // populated — the ModelPill renders a progress bar off those.
  const selectLocalAgent = async (m: ModelInfo) => {
    cinderpawSetError(null);
    // A model picked by hand is "always use this one": Automatic goes off.
    if (useCinderpawStore.getState().automatic) await setAutomatic(false, false);
    try {
      await load(m.path);
      await cinderpawSetModel({
        source: 'openai_compatible',
        model: m.name,
        baseUrl: await localApiBase(),
        providerId: LOCAL_PROVIDER_ID,
      });
    } catch (err) {
      cinderpawSetError(String(err));
      useNotifications.getState().push('error', 'Could not switch model', String(err));
    }
  };

  const t = useT();

  // Cloud switches go through the sidecar and can fail (sidecar
  // offline, provider disabled, missing key…). A discarded promise meant the
  // user clicked a model and nothing visibly happened — surface the error.
  const selectCloudAgent = async (providerId: string, modelId: string) => {
    cinderpawSetError(null);
    if (useCinderpawStore.getState().automatic) await setAutomatic(false, false);
    try {
      await cinderpawSetModel({ source: 'byok', providerId, model: modelId });
      return true;
    } catch (err) {
      cinderpawSetError(String(err));
      useNotifications.getState().push('error', 'Could not switch model', String(err));
      return false;
    }
  };

  /**
   * Switch to a cloud model with its own Effort: the one just chosen beside it,
   * else the one it had last time, else Auto. The model being left keeps the
   * Effort it had, wherever that was set (the composer's button too).
   */
  const pickCloud = async (providerId: string, modelId: string, effort?: Effort) => {
    const { effort: now, effortByModel: kept } = useModel.getState();
    if (cinderpawConfig?.model && !onLocal) rememberEffort(effortKey(cinderpawConfig.provider, cinderpawConfig.model), now);
    const key = effortKey(providerId, modelId);
    if (effort) rememberEffort(key, effort);
    if (await selectCloudAgent(providerId, modelId)) setEffort(effort ?? kept[key] ?? 'auto');
  };

  /**
   * Turn a provider on AND select it — one click, because that is what clicking it
   * meant.
   *
   * Enabling alone left the row looking freshly normal and still unselected, so the
   * user had to click the same row twice with no indication that the first click
   * had done half the job. An empty key means "leave the stored one untouched" all
   * the way down to the keychain, so nothing is overwritten.
   */
  const enableProvider = async (p: ByokProvider) => {
    await tauri.raw.saveByokProvider(p.id, true, '');
    await refreshCloud();
    fetchList(p.id);
    // No default model to route to: its list, now coming in under its name, is where to choose.
    if (!p.default_model) return;
    await pickCloud(p.id, p.default_model);
    setOpen(false);
  };

  const chatgptSignIn = () => {
    void signInWithChatGPT()
      .then(() => refreshCloud())
      .catch((err) => useNotifications.getState().push('error', 'ChatGPT sign-in did not finish', String(err)));
  };

  const hasLocal = localModels.length > 0;
  const hasCloud = cloudProviders.length > 0;

  /**
   * What the trigger says when no model is explicitly pinned.
   *
   * It used to say "No model selected", which was wrong twice over: it read
   * as an error the user had to go fix, and it stopped being true the moment
   * Brain Stack started choosing a model per turn on its own. Picking a model
   * by hand is now an override, not a prerequisite — so with models around,
   * the honest label is that the choice is automatic. With nothing installed
   * at all it becomes an invitation rather than a verdict.
   */
  // While the engine boots (10-17 s on a cloud key) its model is not known yet:
  // "Automatic" there named a mode the list does not offer, and people re-picked
  // the model they already had.
  const unpinnedLabel = cinderpawStarting ? 'Starting…' : hasLocal || hasCloud ? t('model.automatic') : t('model.add');

  // The model shown with its maker's mark, and where it runs beside it.
  // It read "openrouter · meta/muse-spark-1.3-contributor": two ids and a dot.
  let shown: { modelId: string; provider: string } | null = null;
  if (!cinderpawSwitching && !isLoading && cinderpawConfig?.model) {
    shown = { modelId: cinderpawConfig.model, provider: cinderpawConfig.provider };
  }
  // Automatic names itself: the model that answered is said under each reply.
  const auto = automatic && (hasLocal || hasCloud) && !cinderpawStarting;
  const label = cinderpawSwitching
    ? 'Switching…'
    : isLoading
      ? `Loading ${progress?.percentage.toFixed(0) ?? 0}%`
      : auto
        ? 'Automatic'
        : shown
          ? nameFor(onLocal ? undefined : shown.provider, shown.modelId)
          : loaded?.name ?? unpinnedLabel;
  const route = shown && !auto ? (onLocal ? 'This computer' : providerName(shown.provider)) : '';

  const isActive = (providerId: string, modelId: string) =>
    !onLocal && cinderpawConfig?.provider === providerId && cinderpawConfig?.model === modelId;
  const needle = query.trim().toLowerCase();
  const hit = (id: string, name: string) => !needle || id.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);

  // The button's face, drawn twice: as the trigger, and as the island's last row.
  // Where it runs rides beside the name: "GPT 6.1 Sol · ChatGPT plan" says the
  // plan is being spent, as OpenAI asks of apps that use it.
  const face = (
    <>
      {auto && !cinderpawSwitching && !isLoading ? (
        <AutoMark size="sm" />
      ) : shown && <ModelLogo modelId={shown.modelId} provider={shown.provider} />}
      {/* When the composer row is tight (a button name sliding out, a side
          panel open), where it runs gives way first and the model's own name
          only after it: flex shrinks both at once, so the route's factor is
          huge enough that the name loses less than a pixel until the route is
          gone (an equal share cut the name to "Claude Sonnet…"). */}
      <span className="truncate max-w-[150px]">{label}</span>
      {route && <span className="hidden max-w-[110px] shrink-[100000] truncate text-text-muted sm:inline">{route}</span>}
      {/* Only meaningful when the agent answers on the local engine; a
          GGUF left resident behind a cloud model is not where the answer
          comes from. */}
      {onLocal && !isLoading && <BackendBadge />}
    </>
  );

  // The island lies over its button, so it needs the button's height. Read only
  // while open: these props are built on every render, and reading a size in
  // render forced a layout of the whole page each time the chat redrew (150 ms
  // when a chat opened, production build, 30 Oct).
  const triggerHeight = open ? (triggerRef.current?.offsetHeight ?? 32) : 32;

  // The search box keeps its letters: a menu jumps to the row starting with
  // each letter typed, which took the cursor out of the box. Escape still
  // closes, and the arrows still walk down into the list.
  const keepKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') e.stopPropagation();
  };

  const check = <Check size={16} aria-label="In use" className="shrink-0 text-text-primary" />;
  // A favorite whose provider lost its key, or was switched off, is not offered.
  const favRows = favs.filter((f) => cloudProviders.some((p) => p.id === f.provider && p.enabled));
  const rowClass = 'flex min-h-10 cursor-default select-none items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm outline-hidden focus:bg-accent data-[state=open]:bg-accent';

  /**
   * One cloud model: its mark, its name, its own Effort, a star, a tick when in
   * use. Click picks it with that Effort; hovering it (or the right arrow)
   * opens the Effort beside it, where a choice picks it with the new one.
   */
  const cloudRow = (providerId: string, modelId: string, name: string, from?: string) => {
    const on = isActive(providerId, modelId);
    const reaches = effortReaches({ provider: providerId, model: modelId, base_url: cloudProviders.find((p) => p.id === providerId)?.base_url });
    const own = effortByModel[effortKey(providerId, modelId)] ?? 'auto';
    const starred = isFav(providerId, modelId);
    const body: ReactNode = (
      <>
        <ModelLogo modelId={modelId} provider={providerId} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-text-primary">
          {name}
          {from && <span className="text-text-muted"> · {from}</span>}
        </span>
        {reaches && <span className="shrink-0 text-text-muted">{EFFORTS.find((e) => e.id === own)?.label}</span>}
        <button
          type="button"
          aria-label={starred ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
          aria-pressed={starred}
          title={starred ? 'Remove from favorites' : 'Add to favorites'}
          // The star is not the row: it must not pick the model.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(providerId, modelId); }}
          className={cn('shrink-0 rounded-md p-1 hover:bg-bg-hover', starred ? 'text-text-primary' : 'text-text-muted hover:text-text-primary')}
        >
          <Star size={14} fill={starred ? 'currentColor' : 'none'} />
        </button>
        <span className="flex w-4 shrink-0 justify-center">{on && check}</span>
      </>
    );
    const key = effortKey(providerId, modelId);
    if (!reaches) {
      return (
        <DropdownMenuItem key={key} onClick={() => void pickCloud(providerId, modelId)} title={modelId} className={cn(rowClass, on && 'bg-bg-active')}>
          {body}
        </DropdownMenuItem>
      );
    }
    return (
      <DropdownMenuSub key={key}>
        <DropdownMenuPrimitive.SubTrigger
          onClick={() => { void pickCloud(providerId, modelId); setOpen(false); }}
          title={modelId}
          className={cn(rowClass, on && 'bg-bg-active')}
        >
          {body}
        </DropdownMenuPrimitive.SubTrigger>
        <DropdownMenuSubContent sideOffset={12} className="w-48 rounded-2xl p-1.5">
          <p className="px-2.5 pb-1 pt-1.5 text-sm font-medium text-text-secondary">Effort</p>
          {EFFORTS.map(({ id, label: word }) => (
            <DropdownMenuItem key={id} onSelect={() => void pickCloud(providerId, modelId, id)} className="flex items-center justify-between rounded-xl px-2.5 py-1.5">
              {word}
              {own === id && check}
            </DropdownMenuItem>
          ))}
          <p className="px-2.5 pb-1 pt-1 text-xs text-text-muted">How long it thinks first. Higher is slower and costs more.</p>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const cloudEmpty = (
    <div className="space-y-3 px-2 py-2">
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">No cloud models yet</p>
        <p className="text-sm text-text-muted">Already pay for ChatGPT? Use that plan here, no key needed. Or add a key from Anthropic, OpenRouter and others.</p>
      </div>
      <DropdownMenuItem onSelect={chatgptSignIn} className="justify-center rounded-lg bg-brand py-2 text-sm font-medium text-on-brand focus:bg-brand/90">
        Continue with ChatGPT
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { void router.navigate('/models?tab=cloud'); }} className="justify-center rounded-lg border border-border-default py-2 text-sm">
        Add an API key
      </DropdownMenuItem>
    </div>
  );

  const favShown = favRows.filter((f) => hit(f.model, nameFor(f.provider, f.model)));
  const favList = !hasCloud ? cloudEmpty : favShown.length > 0 ? (
    favShown.map((f) => cloudRow(f.provider, f.model, nameFor(f.provider, f.model), providerName(f.provider)))
  ) : (
    <p className="px-2.5 py-3 text-sm text-text-muted">
      {needle ? 'No favorite by that name.' : (
        <>
          No favorites yet. In{' '}
          <button type="button" onClick={() => setTab('all')} className="font-medium text-text-primary underline underline-offset-2">All</button>
          , press the star on the ones you use.
        </>
      )}
    </p>
  );

  let anyMatch = false;
  const providerBlocks = cloudProviders.map((p) => {
    if (!p.enabled) {
      if (needle) return null;
      anyMatch = true;
      return (
        <DropdownMenuItem
          key={p.id}
          // Stays open: the provider turns on and its models come in under it.
          onSelect={(e) => { e.preventDefault(); void enableProvider(p); }}
          className="flex items-center gap-2.5 rounded-xl px-2.5 py-2"
        >
          <ModelLogo modelId={p.default_model ?? undefined} provider={p.id} className="size-5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-text-primary">{p.name}</span>
            <span className="block truncate text-xs text-text-muted">Key saved, turned off. Click to turn it on</span>
          </span>
        </DropdownMenuItem>
      );
    }
    const list = modelsByProvider.get(p.id);
    const error = listErrors[p.id];
    const matching = (list ?? []).filter((m) => hit(m.id, modelName(m)));
    if (needle && list && matching.length === 0) return null;
    anyMatch = true;
    const cap = needle ? LIST_CAP : REST_CAP;
    const capped = matching.slice(0, cap);
    // The model in use is always in the list, even when it sorts past the cap.
    const activeHere = matching.find((m) => isActive(p.id, m.id));
    const rows = activeHere && !capped.includes(activeHere) ? [activeHere, ...capped.slice(0, cap - 1)] : capped;
    const unshown = matching.length - rows.length;
    return (
      <div key={p.id} role="group" aria-label={p.name} className="pb-1">
        <p data-provider-header="" className="truncate px-2.5 pb-1 pt-2 text-xs text-text-muted">
          <span className="font-medium text-text-secondary">{p.name}</span>
          {p.id === CHATGPT_ID ? (
            <>
              {' · '}your plan, no extra bill ·{' '}
              <a href={MANAGE_USAGE} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-text-primary">Manage usage</a>
            </>
          ) : (
            ' · your key, paid per use'
          )}
        </p>
        {error ? (
          <div className="space-y-2 px-2.5 py-1">
            <p className="text-sm text-error">{error}</p>
            <button type="button" onClick={() => fetchList(p.id)} className="text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary">
              Try again
            </button>
          </div>
        ) : !list ? (
          <p className="px-2.5 py-1.5 text-sm text-text-muted">Getting {p.name}&apos;s models…</p>
        ) : list.length === 0 ? (
          <p className="px-2.5 py-1.5 text-sm text-text-muted">This provider lists no chat models for this key.</p>
        ) : (
          rows.map((m) => cloudRow(p.id, m.id, modelName(m)))
        )}
        {unshown > 0 && (
          <p className="px-2.5 pt-0.5 text-xs text-text-muted">
            {needle ? `${unshown} more match. Type more of the name.` : `${unshown} more. Type a name to find one.`}
          </p>
        )}
      </div>
    );
  });
  const allList = !hasCloud
    ? cloudEmpty
    : anyMatch ? providerBlocks : <p className="px-2.5 py-3 text-sm text-text-muted">No model by that name.</p>;

  const localShown = localModels.filter((m) => hit(m.name, m.name));
  const hereList = hasLocal ? (
    <>
      <p className="px-2.5 pb-1 pt-1 text-xs text-text-muted">Private: nothing leaves this computer.</p>
      {localShown.length === 0 && <p className="px-2.5 py-3 text-sm text-text-muted">No model by that name.</p>}
      {localShown.map((m) => {
        const on = onLocal && cinderpawConfig?.model === m.name;
        return (
          <DropdownMenuItem
            key={m.path}
            onClick={() => void selectLocalAgent(m)}
            className={cn('flex items-center gap-3 rounded-xl px-2.5 py-2', on && 'bg-bg-active')}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-text-primary">{m.name}</span>
              <span className="block text-xs text-text-muted">{formatBytes(m.size_bytes)}</span>
            </span>
            {on && check}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuItem onSelect={() => { void router.navigate('/models'); }} className="px-2.5 text-sm text-text-secondary">
        Get more models
      </DropdownMenuItem>
    </>
  ) : (
    <div className="space-y-3 px-2 py-2">
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">Nothing downloaded yet</p>
        <p className="text-sm text-text-muted">A model on this computer answers with no internet and keeps everything private.</p>
      </div>
      <DropdownMenuItem onSelect={() => { void router.navigate('/models'); }} className="justify-center rounded-lg border border-border-default py-2 text-sm">
        Download a model
      </DropdownMenuItem>
    </div>
  );

  const counts: Record<Tab, number> = {
    fav: favRows.length,
    all: cloudProviders.reduce((n, p) => n + (p.enabled ? modelsByProvider.get(p.id)?.length ?? 0 : 0), 0),
    here: localModels.length,
  };

  /**
   * The short list: one row per provider the person can answer from (its own
   * model) and each model on this computer, named by the job first. With
   * Automatic on they are what it picks from, dimmed; off, a click picks one.
   */
  const simpleRows = [
    ...cloudProviders
      .filter((p) => p.enabled && p.default_model)
      .map((p) => ({
        key: `${p.id}:${p.default_model}`,
        job: jobOf(p.default_model!),
        name: nameFor(p.id, p.default_model!),
        who: p.id === CHATGPT_ID ? 'your ChatGPT plan' : `your ${p.name} key`,
        logo: <ModelLogo modelId={p.default_model!} provider={p.id} className="size-5" />,
        on: !automatic && isActive(p.id, p.default_model!),
        pick: () => void pickCloud(p.id, p.default_model!),
      })),
    ...localModels.map((m) => ({
      key: m.path,
      job: 'Private',
      name: modelDisplayName(m.name),
      who: 'on this computer, nothing leaves it',
      logo: <ModelLogo modelId={m.name} className="size-5" />,
      on: !automatic && onLocal && cinderpawConfig?.model === m.name,
      pick: () => void selectLocalAgent(m),
    })),
  ];
  const simpleView = (
    <div className="flex flex-col">
      <DropdownMenuPrimitive.CheckboxItem
        checked={automatic}
        // Stays open: the rows below change with the switch.
        onSelect={(e) => e.preventDefault()}
        onCheckedChange={(on) => void setAutomatic(on).catch((err) => useNotifications.getState().push('error', 'Could not switch model', String(err)))}
        className="flex cursor-default select-none items-center gap-3 rounded-xl px-2.5 py-2.5 outline-hidden focus:bg-accent"
      >
        <AutoMark size="md" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-text-primary">Let Cinderpaw choose</span>
          <span className="block text-xs text-text-muted">The right model for each message</span>
        </span>
        {/* An iOS switch: the thumb travels, nothing else moves. */}
        <span aria-hidden className={cn('relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-(--motion-fast) ease-out', automatic ? 'bg-brand' : 'bg-border-default')}>
          <span className={cn('absolute top-[3px] size-4 rounded-full bg-white shadow-sm transition-transform duration-(--motion-fast) ease-out', automatic ? 'translate-x-[19px]' : 'translate-x-[3px]')} />
        </span>
      </DropdownMenuPrimitive.CheckboxItem>
      <DropdownMenuSeparator />
      {simpleRows.length === 0 ? (
        hasCloud ? null : cloudEmpty
      ) : (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-xs text-text-muted">{automatic ? 'It picks from' : 'Always use'}</p>
          {automatic ? (
            // On, the list is only what it picks from: one line, not a column of
            // rows nobody can press (8 models made the menu taller than the
            // window, 4 Nov). Turning the switch off brings the rows back.
            <div className="flex items-center gap-3 px-2.5 pb-2 pt-0.5">
              {/* Solid discs: on the translucent surface the logos showed
                  through each other (4 Nov). */}
              <span className="flex shrink-0 -space-x-1">
                {simpleRows.slice(0, 5).map((r) => (
                  <span key={r.key} className="grid size-6 place-items-center overflow-hidden rounded-full border border-border-default bg-bg-primary [&>*]:size-3.5">{r.logo}</span>
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                {simpleRows.slice(0, 2).map((r) => r.name).join(', ')}
                {simpleRows.length > 2 ? ` and ${simpleRows.length - 2} more` : ''}
              </span>
            </div>
          ) : (
            // About five rows high, the rest a scroll away.
            <div className="max-h-[14rem] overflow-y-auto thin-scrollbar">
              {simpleRows.map((r) => (
                <DropdownMenuItem key={r.key} onSelect={r.pick} className={cn(rowClass, r.on && 'bg-bg-active')}>
                  {r.logo}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-text-primary">{r.job}</span>
                    <span className="block truncate text-xs text-text-muted">{r.name} · {r.who}</span>
                  </span>
                  <span className="flex w-4 shrink-0 justify-center">{r.on && check}</span>
                </DropdownMenuItem>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    // Controlled: the island's last row closes it, and so does enabling a provider.
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          // text-secondary, not muted: this is the name of the model that will answer,
          // and muted on the light typing bar read as a placeholder (20 Sep).
          className="flex min-w-0 items-center gap-1.5 h-full pl-2.5 pr-2 text-sm text-text-secondary hover:text-text-primary transition-colors outline-hidden"
          title={shown ? `${label} · ${route}` : undefined}
        >
          {face}
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      {/* Upward: the composer sits at the bottom of the screen, and a menu
          that opens downward from it opens off-screen.

          `sideOffset` and the height cap are not spacing taste. Radix opens
          this menu on POINTER DOWN, and an item whose pointer-down it never
          saw selects itself on pointer UP:

            onPointerUp: (event) => {
              if (!isPointerDownRef.current) event.currentTarget?.click();
            }                        (@radix-ui/react-menu, MenuItem)

          That exists so a press-drag-release picks an item, and it turns into
          a bug the moment the menu is drawn underneath the cursor: the press
          opens it, the release lands on whatever row is now there, and a model
          the user never chose is loaded. A list that outgrows the room above
          the composer is exactly when that happens, which is why it comes back
          as soon as somebody installs another model.

          The cap keeps the menu inside the space above the trigger so it is
          not flipped or shifted under the cursor, and the offset keeps a gap
          between the cursor and the nearest row either way. The scroll is the
          other half of the same problem: a picker taller than the window is
          not a picker.

          A Dynamic Island now (Darius's pick from three mockups, 26 Oct): the
          menu lies over its own button and grows out of it (`.model-island`,
          globals.css), the button's face staying where it was as the last row.
          That row is a plain button, not a menu item, because it is exactly
          where the opening press is released: an item there would select
          itself on that release and close the menu at once. */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={-triggerHeight}
        collisionPadding={12}
        className="model-island relative w-[24rem] overflow-visible rounded-3xl p-0"
      >
        <img src={logoUrl} alt="" className="pointer-events-none absolute -top-9 right-6 h-12 w-12" />
        {/* Search, tabs and the two links stay put; only the list scrolls. */}
        <div className="model-island-body flex max-h-[min(55vh,30rem)] flex-col p-2">
          <p className="sr-only">Model Switcher</p>
          {view === 'simple' ? (
            <div className="-mx-2 min-h-0 overflow-y-auto thin-scrollbar px-2">{simpleView}</div>
          ) : (
          <>
          <button
            type="button"
            onClick={() => setView('simple')}
            className="mb-1 flex h-8 items-center gap-1 self-start rounded-lg px-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronLeft size={14} /> Back
          </button>
          <label className="mb-1.5 flex h-9 items-center gap-2 px-2.5 text-sm text-text-muted">
            <Search size={14} className="shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={keepKeys}
              placeholder="Search models"
              aria-label="Search models"
              className="min-w-0 flex-1 bg-transparent text-text-primary placeholder:text-text-muted focus:outline-hidden"
            />
          </label>
          <div role="tablist" aria-label="Which models" className="mb-1.5 flex gap-0.5 rounded-full border border-border-subtle bg-bg-primary p-0.5">
            {TABS.map(({ id, label: word }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  // Sized by their words, not split in three: "This computer"
                  // did not fit a third of the island.
                  'flex h-7 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-full px-2.5 text-sm transition-colors',
                  tab === id ? 'bg-bg-active text-text-primary' : 'text-text-muted hover:text-text-primary',
                )}
              >
                {id === 'fav' && <Star size={12} fill={tab === 'fav' ? 'currentColor' : 'none'} className="shrink-0" />}
                <span className="truncate">{word}</span>
                <span className="text-xs text-text-muted">{counts[id]}</span>
              </button>
            ))}
          </div>
          {/* Its own height until the island's cap, then it scrolls (flex-1
              here sized it from zero and squeezed the list to 80px). */}
          <div className="-mx-2 min-h-0 overflow-y-auto thin-scrollbar px-2">
            {tab === 'here' ? hereList : tab === 'fav' ? favList : allList}
          </div>
          </>
          )}
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between">
            {view === 'simple' ? (
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setView('all'); }} className="gap-1 text-sm text-text-secondary">
                All models <ChevronRight size={14} />
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => { void router.navigate('/models?tab=cloud'); }} className="text-sm text-text-secondary">
                Add a provider
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => { void router.navigate('/models?tab=roles'); }} className="text-sm text-text-secondary">
              Manage models
            </DropdownMenuItem>
          </div>
          {import.meta.env.DEV && <BareModelItem />}
        </div>
        {/* Out of the Tab order like the rows (a menu moves by arrows); Escape
            closes it from the keyboard. */}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${label}: close the list`}
          onClick={() => setOpen(false)}
          style={{ height: triggerHeight }}
          className="flex w-full items-center gap-1.5 pl-2.5 pr-2 text-sm text-text-secondary hover:text-text-primary transition-colors outline-hidden"
        >
          {face}
          <ChevronDown size={12} className="shrink-0 rotate-180 opacity-50" />
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
