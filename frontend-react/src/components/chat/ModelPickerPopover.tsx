import { useEffect, useState } from 'react';
import { ChevronDown, Cloud, HardDrive } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { modelLabel, refreshCatalog } from '@/lib/modelCatalog';
import { ModelLogo, modelDisplayName, providerName } from '@/lib/modelLogos';
import { tauri, type ModelInfo, type ByokProvider } from '@/lib/tauri';
import { router } from '@/router';
import { BackendBadge } from '@/components/BackendBadge';

// Cinderpaw's own model engine exposes an OpenAI-compatible API here. In agent mode
// a local pick must target THIS (not external Ollama on 11434) so the agent uses
// the model loaded in the Models tab.
const CINDERPAW_API_BASE = 'http://localhost:11435';
const LOCAL_PROVIDER_ID = 'cinderpaw-local';

function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function ModelPickerPopover() {
  const loaded        = useModel((s) => s.loaded);
  const isLoading     = useModel((s) => s.isLoading);
  const progress      = useModel((s) => s.loadProgress);
  const load          = useModel((s) => s.load);
  const cloudModel    = useModel((s) => s.cloudModel);
  const setCloudModel = useModel((s) => s.setCloudModel);

  // Agent mode targets the Cinderpaw sidecar (its own model config), not the
  // in-process chat model. The pill stays visually identical; only the
  // selection action + label source change.
  const isAgentMode   = useUI((s) => s.inputMode) === 'agent';
  const cinderpawConfig   = useCinderpawStore((s) => s.modelConfig);
  const cinderpawSwitching = useCinderpawStore((s) => s.switching);
  const cinderpawSetModel = useCinderpawStore((s) => s.setModel);
  const cinderpawSetError = useCinderpawStore((s) => s.setModelError);

  const [localModels, setLocalModels]     = useState<ModelInfo[]>([]);
  const [cloudProviders, setCloudProviders] = useState<ByokProvider[]>([]);
  const [open, setOpen] = useState(false);

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
      .then((providers) => setCloudProviders(providers.filter((p) => p.has_api_key)))
      .catch(() => {});

  useEffect(() => {
    if (!open) return;
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
    void refreshCloud();
    // Names for cloud models come from the published catalogue, cached for a
    // day. Asked when the picker opens rather than at startup, so a local-only
    // install still never calls out.
    void refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshCloud is stable enough; open is the trigger
  }, [open]);

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
    // No default model to route to: the row now renders the "set one in Settings"
    // hint, so leave the menu open on it rather than closing on a no-op.
    if (!modelId) return;
    if (isAgentMode) await selectCloudAgent(p.id, modelId);
    else setCloudModel({ providerId: p.id, providerName: p.name, modelId });
    setOpen(false);
  };

  // In agent mode, selecting a local model must LOAD it into Cinderpaw's engine
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
        baseUrl: CINDERPAW_API_BASE,
        providerId: LOCAL_PROVIDER_ID,
      });
    } catch (err) {
      cinderpawSetError(String(err));
      useNotifications.getState().push('error', 'Could not switch model', String(err));
    }
  };

  const t = useT();

  // Agent-mode cloud switches go through the sidecar and can fail (sidecar
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
  const unpinnedLabel = hasLocal || hasCloud ? t('model.automatic') : t('model.add');

  let label: string;
  // The model shown with its maker's mark, and the route only in the tooltip.
  // It read "openrouter · meta/muse-spark-1.3-contributor": two ids and a dot.
  let shown: { modelId: string; provider: string } | null = null;
  if (isAgentMode) {
    if (!cinderpawSwitching && !isLoading && cinderpawConfig?.model) {
      shown = { modelId: cinderpawConfig.model, provider: cinderpawConfig.provider };
    }
    label = cinderpawSwitching
      ? 'Switching…'
      : isLoading
        ? `Loading ${progress?.percentage.toFixed(0) ?? 0}%`
        : shown
          ? modelDisplayName(shown.modelId)
          : loaded?.name ?? unpinnedLabel;
  } else if (isLoading) {
    label = `Loading ${progress?.percentage.toFixed(0) ?? 0}%`;
  } else if (cloudModel) {
    shown = { modelId: cloudModel.modelId, provider: cloudModel.providerId };
    label = modelDisplayName(cloudModel.modelId);
  } else {
    // A loaded local model: its file name, with the Hugging Face mark.
    if (loaded?.name) shown = { modelId: loaded.name, provider: 'local' };
    label = loaded?.name ?? unpinnedLabel;
  }
  const route = shown ? providerName(shown.provider) : '';

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          // text-secondary, not muted: this is the name of the model that will answer,
          // and muted on the light typing bar read as a placeholder (20 Sep).
          className="flex min-w-0 items-center gap-1.5 h-full pl-2.5 pr-2 text-xs text-text-secondary hover:text-text-primary transition-colors outline-hidden"
          title={shown ? `${label} · via ${route}` : undefined}
        >
          {shown && <ModelLogo modelId={shown.modelId} provider={shown.provider} />}
          <span className="truncate max-w-[150px]">{label}</span>
          {/* Only meaningful for a local model — BackendBadge renders nothing
              when none is loaded, so a cloud route stays clean. */}
          {!cloudModel && !isLoading && <BackendBadge />}
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
          not a picker. */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-72 max-h-[min(55vh,26rem)] overflow-y-auto thin-scrollbar"
      >
        {hasLocal && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <HardDrive size={12} /> Local
            </DropdownMenuLabel>
            {localModels.map((m) => (
              <DropdownMenuItem
                key={m.path}
                onClick={() =>
                  isAgentMode
                    ? void selectLocalAgent(m)
                    : (setCloudModel(null), void load(m.path))
                }
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-text-primary">{m.name}</span>
                <span className="text-xs text-text-muted">{formatBytes(m.size_bytes)}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hasCloud && (
          <>
            {hasLocal && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <Cloud size={12} /> Cloud
            </DropdownMenuLabel>
            {cloudProviders.map((p) => {
              const modelId = p.default_model ?? '';
              // A key is stored but the provider is switched off. Selecting it
              // would silently do nothing, so the row turns it on instead — one
              // click, in the place the user is already looking.
              if (!p.enabled) {
                return (
                  <DropdownMenuItem
                    key={p.id}
                    onSelect={(e) => {
                      e.preventDefault(); // keep the menu open so the row updates in place
                      void enableProvider(p);
                    }}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="flex items-center gap-1.5 text-text-secondary">
                      {p.name}
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-micro text-warning">
                        off
                      </span>
                    </span>
                    <span className="text-xs text-text-muted">
                      Key saved · click to turn this provider on
                    </span>
                  </DropdownMenuItem>
                );
              }
              return (
                <DropdownMenuItem
                  key={p.id}
                  // Not `disabled`: a disabled row is drawn at half opacity, and
                  // the one line on it is an instruction ("set a default model in
                  // Cloud Keys") that measured 2.7:1 in the light theme (20 Sep).
                  //
                  // The row used to PERFORM that instruction, which threw the
                  // person out of the picker and into Settings on a plain click:
                  // "I press the model selector and the app takes me to Cloud
                  // Keys", twice in a row, in the middle of something else (22
                  // Sep). Leaving is a decision, so it needs its own button (the
                  // arrow below); a row with no model now just says so.
                  onSelect={(e) => { if (!modelId) e.preventDefault(); }}
                  onClick={() => {
                    if (!modelId) return;
                    if (isAgentMode) {
                      void selectCloudAgent(p.id, modelId);
                    } else {
                      setCloudModel({ providerId: p.id, providerName: p.name, modelId });
                    }
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-text-primary">{p.name}</span>
                  {modelId ? (
                    <span className="text-xs text-text-muted">{modelLabel(modelId)}</span>
                  ) : (
                    // The way out, asked for rather than taken on the person's
                    // behalf. `stopPropagation` so pressing the row itself still
                    // does nothing: only this button leaves the conversation.
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void router.navigate('/settings?cat=byok'); }}
                      className="text-xs text-brand underline-offset-2 hover:underline"
                    >
                      No default model · choose one in Cloud Keys
                    </button>
                  )}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        {!hasLocal && !hasCloud && (
          <DropdownMenuItem disabled>
            No models found. Download one or add a cloud key
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
