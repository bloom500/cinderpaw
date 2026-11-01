import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { refreshCatalog } from '@/lib/modelCatalog';
import { ModelLogo, modelDisplayName, providerName } from '@/lib/modelLogos';
import { tauri, type ModelInfo, type ByokProvider } from '@/lib/tauri';
import { router } from '@/router';
import { CHATGPT_ID, MANAGE_USAGE, planFirst, signInWithChatGPT } from '@/lib/chatgptSignIn';
import { BackendBadge } from '@/components/BackendBadge';
import { cn } from '@/lib/utils';
import logoUrl from '@/assets/logo.svg';
import { isLocalEngineUrl, localApiBase } from '@/lib/localApi';

// Cinderpaw's own model engine exposes an OpenAI-compatible API here. In agent mode
// a local pick must target THIS (not external Ollama on 11434) so the agent uses
// the model loaded in the Models tab.
const LOCAL_PROVIDER_ID = 'cinderpaw-local';

/** A provider's models, asked once per session: they change in months, not minutes. */
type ProviderModel = { id: string; name: string | null };
const modelsByProvider = new Map<string, ProviderModel[]>();

/** Past this many models a provider page gets a search box (OpenRouter has 300+). */
const SEARCH_FROM = 12;
/**
 * Rows drawn at once. All 320 of OpenRouter's froze the window for 416 ms when
 * its page opened (dev build, 1 Nov); nobody reads 320 rows, they type a name.
 */
const LIST_CAP = 40;

function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

const modelName = (m: ProviderModel) => (m.name ? m.name.replace(/^[^:]{1,40}:\s+/, '') : modelDisplayName(m.id));

/** A model's name as its provider writes it ("GPT 6.1 Sol"), once its list is in; else one made from the id. */
const nameFor = (providerId: string | undefined, modelId: string) => {
  const m = providerId ? modelsByProvider.get(providerId)?.find((x) => x.id === modelId) : undefined;
  return m ? modelName(m) : modelDisplayName(modelId);
};

/**
 * The model picker, option B of the 1 Nov mockups (his pick): Cloud or this
 * computer, then a provider, then its models by name. Before, each provider
 * showed only its default model, and any other one had to be typed as an id in
 * Models > Roles. Roles and effort stay where they are (Roles and settings;
 * the effort button), so this only answers "which model answers me".
 */
export function ModelPickerPopover() {
  const loaded        = useModel((s) => s.loaded);
  const isLoading     = useModel((s) => s.isLoading);
  const progress      = useModel((s) => s.loadProgress);
  const load          = useModel((s) => s.load);

  // The picker targets the Cinderpaw sidecar's own model config.
  const cinderpawConfig   = useCinderpawStore((s) => s.modelConfig);
  const cinderpawSwitching = useCinderpawStore((s) => s.switching);
  const cinderpawSetModel = useCinderpawStore((s) => s.setModel);
  const cinderpawSetError = useCinderpawStore((s) => s.setModelError);
  const cinderpawStarting = useCinderpawStore((s) => !s.isReady && !s.offline);

  const [localModels, setLocalModels]     = useState<ModelInfo[]>([]);
  const [cloudProviders, setCloudProviders] = useState<ByokProvider[]>([]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Where the picker stands: a side, and on the cloud side maybe one provider's page.
  const [side, setSide] = useState<'cloud' | 'local'>('cloud');
  const [page, setPage] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // A provider's list arriving redraws the names that come from it.
  const [, listsIn] = useState(0);

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

  useEffect(() => {
    if (!open) return;
    // It opens on the side of the model answering now, at the top level; with
    // none chosen yet, on the side that has something to pick.
    const noneChosen = !cinderpawConfig?.model;
    setSide(onLocal || (noneChosen && cloudProviders.length === 0 && localModels.length > 0) ? 'local' : 'cloud');
    setPage(null);
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
    // Each switched-on provider's list, once a session: the rows then say each
    // model as its provider names it, the same on every row and on the button.
    void tauri.raw
      .getByokSettings()
      .then((providers) => {
        setCloudProviders(planFirst(providers.filter((p) => p.has_api_key)));
        for (const p of providers) {
          if (!p.has_api_key || !p.enabled || modelsByProvider.has(p.id)) continue;
          void tauri.raw.providerModels(p.id).then((list) => { modelsByProvider.set(p.id, list); listsIn((n) => n + 1); }).catch(() => {});
        }
      })
      .catch(() => {});
    // Names for cloud models come from the published catalogue, cached for a
    // day. Asked when the picker opens rather than at startup, so a local-only
    // install still never calls out.
    void refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshCloud is stable enough; open is the trigger
  }, [open]);

  const openProvider = (id: string) => {
    setPage(id);
    setQuery('');
    setModelsError(null);
    const known = modelsByProvider.get(id);
    setModels(known ?? null);
    if (known) return;
    void tauri.raw
      .providerModels(id)
      .then((list) => {
        modelsByProvider.set(id, list);
        setModels(list);
      })
      .catch((e) => setModelsError(String(e)));
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
    const modelId = p.default_model ?? '';
    // No default model to route to: its page lists them to choose from.
    if (!modelId) {
      openProvider(p.id);
      return;
    }
    await selectCloudAgent(p.id, modelId);
    setOpen(false);
  };

  // Selecting a local model must LOAD it into Cinderpaw's engine
  // (so /v1/chat/completions has it resident) then point the sidecar at it.
  // Goes through the model store's load() so isLoading/loadProgress are
  // populated — the ModelPill renders a progress bar off those.
  const selectLocalAgent = async (m: ModelInfo) => {
    cinderpawSetError(null);
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
    try {
      await cinderpawSetModel({ source: 'byok', providerId, model: modelId });
    } catch (err) {
      cinderpawSetError(String(err));
      useNotifications.getState().push('error', 'Could not switch model', String(err));
    }
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
  const label = cinderpawSwitching
    ? 'Switching…'
    : isLoading
      ? `Loading ${progress?.percentage.toFixed(0) ?? 0}%`
      : shown
        ? nameFor(onLocal ? undefined : shown.provider, shown.modelId)
        : loaded?.name ?? unpinnedLabel;
  const route = shown ? (onLocal ? 'This computer' : providerName(shown.provider)) : '';

  const isActive = (providerId: string, modelId: string) =>
    !onLocal && cinderpawConfig?.provider === providerId && cinderpawConfig?.model === modelId;
  const pageProvider = page ? cloudProviders.find((p) => p.id === page) ?? null : null;
  const needle = query.trim().toLowerCase();
  const matching = (models ?? []).filter((m) => !needle || m.id.toLowerCase().includes(needle) || modelName(m).toLowerCase().includes(needle));
  const capped = matching.slice(0, LIST_CAP);
  // The model in use is always on the page, even when it sorts past the cap.
  const activeHere = page ? matching.find((m) => isActive(page, m.id)) : undefined;
  const shownModels = activeHere && !capped.includes(activeHere) ? [activeHere, ...capped.slice(0, LIST_CAP - 1)] : capped;
  const unshown = matching.length - shownModels.length;

  // The button's face, drawn twice: as the trigger, and as the island's last row.
  // Where it runs rides beside the name: "GPT 6.1 Sol · ChatGPT plan" says the
  // plan is being spent, as OpenAI asks of apps that use it.
  const face = (
    <>
      {shown && <ModelLogo modelId={shown.modelId} provider={shown.provider} />}
      <span className="truncate max-w-[150px]">{label}</span>
      {route && <span className="hidden max-w-[110px] shrink truncate text-text-muted sm:inline">{route}</span>}
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
  // each letter typed, which took the cursor out of the box. Escape still closes.
  const keepKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') e.stopPropagation();
  };

  const check = <Check size={16} aria-label="In use" className="shrink-0 text-text-primary" />;

  const cloudRoot = !hasCloud ? (
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
  ) : (
    cloudProviders.map((p) => {
      const inUse = !onLocal && cinderpawConfig?.provider === p.id;
      const line = !p.enabled
        ? 'Key saved, turned off. Click to turn it on'
        : inUse && cinderpawConfig?.model
          ? `${nameFor(p.id, cinderpawConfig.model)}, in use`
          : p.default_model
            ? nameFor(p.id, p.default_model)
            : 'Choose a model';
      return (
        <DropdownMenuItem
          key={p.id}
          // Stays open: the row leads to its page, or turns the provider on.
          onSelect={(e) => {
            e.preventDefault();
            if (p.enabled) openProvider(p.id);
            else void enableProvider(p);
          }}
          className={cn('flex items-center gap-3 rounded-xl px-2.5 py-2', inUse && 'bg-bg-active')}
        >
          <ModelLogo modelId={p.default_model ?? undefined} provider={p.id} className="size-5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-text-primary">{p.name}</span>
            <span className="block truncate text-xs text-text-muted">{line}</span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-text-muted" />
        </DropdownMenuItem>
      );
    })
  );

  const providerPage = pageProvider && (
    <>
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          onClick={() => setPage(null)}
          className="inline-flex h-8 items-center gap-0.5 rounded-lg pl-1 pr-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <ChevronLeft size={16} /> Cloud
        </button>
        <span className="flex-1 truncate pr-16 text-center text-sm font-semibold text-text-primary">{pageProvider.name}</span>
      </div>
      <p className="px-2.5 pb-1 text-xs text-text-muted">
        {pageProvider.id === CHATGPT_ID ? (
          <>
            Using your ChatGPT plan, no extra bill.{' '}
            <a href={MANAGE_USAGE} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-text-primary">Manage usage</a>
          </>
        ) : (
          'Your API key, paid per use.'
        )}
      </p>
      {(models?.length ?? 0) > SEARCH_FROM && (
        <label className="mx-1 mb-1 flex h-8 items-center gap-2 rounded-lg border border-border-default px-2 text-sm text-text-muted">
          <Search size={14} className="shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={keepKeys}
            placeholder={`Search ${models?.length ?? ''} models`}
            aria-label="Search models"
            className="min-w-0 flex-1 bg-transparent text-text-primary placeholder:text-text-muted focus:outline-hidden"
          />
        </label>
      )}
      {modelsError ? (
        <div className="space-y-2 px-2.5 py-2">
          <p className="text-sm text-error">{modelsError}</p>
          <button type="button" onClick={() => openProvider(pageProvider.id)} className="text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary">
            Try again
          </button>
        </div>
      ) : models === null ? (
        <p className="px-2.5 py-3 text-sm text-text-muted">Getting {pageProvider.name}&apos;s models…</p>
      ) : shownModels.length === 0 ? (
        <p className="px-2.5 py-3 text-sm text-text-muted">{needle ? 'No model by that name.' : 'This provider lists no chat models for this key.'}</p>
      ) : (
        shownModels.map((m) => {
          const on = isActive(pageProvider.id, m.id);
          return (
            <DropdownMenuItem
              key={m.id}
              onClick={() => void selectCloudAgent(pageProvider.id, m.id)}
              title={m.id}
              className={cn('flex min-h-11 items-center gap-3 rounded-xl px-2.5 py-2', on && 'bg-bg-active')}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{modelName(m)}</span>
              {on && check}
            </DropdownMenuItem>
          );
        })
      )}
      {unshown > 0 && (
        <p className="px-2.5 py-2 text-xs text-text-muted">
          {needle ? `${unshown} more match. Type more of the name.` : `${unshown} more. Type a name to find one.`}
        </p>
      )}
    </>
  );

  const localSide = hasLocal ? (
    <>
      <p className="px-2.5 pb-1 text-xs text-text-muted">Private: nothing leaves this computer.</p>
      {localModels.map((m) => {
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

  return (
    // Controlled: the island's last row closes it, and so does enabling a provider.
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          // text-secondary, not muted: this is the name of the model that will answer,
          // and muted on the light typing bar read as a placeholder (20 Sep).
          className="flex min-w-0 items-center gap-1.5 h-full pl-2.5 pr-2 text-xs text-text-secondary hover:text-text-primary transition-colors outline-hidden"
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
        className="model-island relative w-[22rem] overflow-visible rounded-3xl p-0"
      >
        <img src={logoUrl} alt="" className="pointer-events-none absolute -top-9 right-6 h-12 w-12" />
        <div className="model-island-body max-h-[min(55vh,30rem)] overflow-y-auto thin-scrollbar p-2">
          <p className="sr-only">Model Switcher</p>
          {/* Cloud or this computer: two places a model answers from, one at a time. */}
          <div role="tablist" aria-label="Where the model runs" className="mb-2 grid grid-cols-2 gap-0.5 rounded-xl bg-bg-primary p-0.5">
            {(['cloud', 'local'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={side === s}
                onClick={() => { setSide(s); setPage(null); }}
                className={cn(
                  'h-8 rounded-[10px] text-sm font-medium transition-colors',
                  side === s ? 'bg-bg-active text-text-primary' : 'text-text-muted hover:text-text-primary',
                )}
              >
                {s === 'cloud' ? 'Cloud' : 'On this computer'}
              </button>
            ))}
          </div>
          {side === 'local' ? localSide : providerPage ?? cloudRoot}
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between">
            <DropdownMenuItem onSelect={() => { void router.navigate('/models?tab=cloud'); }} className="text-sm text-text-secondary">
              Add a provider
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void router.navigate('/models?tab=roles'); }} className="text-sm text-text-secondary">
              Roles and settings
            </DropdownMenuItem>
          </div>
        </div>
        {/* Out of the Tab order like the rows (a menu moves by arrows); Escape
            closes it from the keyboard. */}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${label}: close the list`}
          onClick={() => setOpen(false)}
          style={{ height: triggerHeight }}
          className="flex w-full items-center gap-1.5 pl-2.5 pr-2 text-xs text-text-secondary hover:text-text-primary transition-colors outline-hidden"
        >
          {face}
          <ChevronDown size={12} className="shrink-0 rotate-180 opacity-50" />
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
