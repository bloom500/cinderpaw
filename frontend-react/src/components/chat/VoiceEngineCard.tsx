import { useEffect, useState } from 'react';
import { Laptop, Cloud, Check, Loader2, Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ExternalLink } from './ExternalLink';
import { useUI, type LangPref } from '@/stores/ui';
import { useNotifications } from '@/stores/notifications';
import { tauri, type TtsProviderInfo } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Per on-device engine: what a fresh setup downloads, a few voices worth
 * offering by name, and the credit their licence requires.
 *
 * Without the shortlist this step is a text box that only works if you already
 * know the id to type — which in practice meant one voice for everyone. Typing
 * an id still reaches every other voice the engine has.
 *
 * The defaults mirror Rust (`tts::piper::DEFAULT_VOICE`, `tts::kokoro::
 * DEFAULT_VOICE`); nothing else here is duplicated from it.
 */
type VoiceOffer = { fallback: string; offer: Array<{ id: string; label: string }>; credit?: string };

const LOCAL_VOICES: Record<string, Record<LangPref, VoiceOffer>> = {
  piper: {
    // The shortlist follows the INTERFACE language, and that is the whole point
    // of it existing. It used to be four Romanian voices for everybody, with a
    // Romanian one shipped as the default — so a stranger installing Cinderpaw
    // anywhere in the world downloaded 60 MB to be answered in a language they
    // may not speak, and nothing on the screen explained why. Piper has 35+
    // languages; the ones nobody's UI is set to are still reachable by typing
    // the id, which is how the other 31 have always worked.
    en: {
      fallback: 'en_US-amy-medium',
      offer: [
        { id: 'en_US-amy-medium', label: 'amy · US' },
        { id: 'en_US-ryan-high', label: 'ryan · US' },
        { id: 'en_GB-alba-medium', label: 'alba · UK' },
        { id: 'en_GB-northern_english_male-medium', label: 'northern · UK' },
      ],
    },
    ro: {
      // One voice, the good one. Four of them was a row of near-identical
      // choices with no way for the user to tell them apart before
      // downloading 60 MB each; mihai, lili and sanda are all still reachable
      // by typing the id.
      fallback: 'ro_RO-raluca-high',
      offer: [{ id: 'ro_RO-raluca-high', label: 'raluca · high' }],
      credit: 'raluca: eduardem, CC BY-NC 4.0',
    },
  },
  kokoro: {
    // One list: this engine only has these voices, whatever the UI language is.
    en: {
      fallback: 'af_heart',
      offer: [
        { id: 'af_heart', label: 'heart · US' },
        { id: 'af_bella', label: 'bella · US' },
        { id: 'am_michael', label: 'michael · US' },
        { id: 'bf_emma', label: 'emma · UK' },
      ],
    },
    ro: {
      fallback: 'af_heart',
      offer: [
        { id: 'af_heart', label: 'heart · US' },
        { id: 'af_bella', label: 'bella · US' },
        { id: 'am_michael', label: 'michael · US' },
        { id: 'bf_emma', label: 'emma · UK' },
      ],
    },
  },
};

const voicesFor = (engineId: string | undefined, lang: LangPref): VoiceOffer | undefined =>
  engineId ? LOCAL_VOICES[engineId]?.[lang] : undefined;

/** The voice used when the field is left empty, for whichever engine is selected. */
const defaultVoiceFor = (engineId: string | undefined, lang: LangPref) =>
  voicesFor(engineId, lang)?.fallback ?? '';

/**
 * First-call chooser for the voice that answers you.
 *
 * The rows come from the Rust catalog, not from a list in this file. Two of the
 * three things a row has to say — whether audio leaves the machine, and whether
 * the engine is built into this version — are properties of the engine, and a UI
 * that keeps its own copy of them will eventually show the reassuring version of
 * a claim that has stopped being true.
 *
 * Configuration expands **under the row it belongs to**, with its own Save and
 * Cancel. A single form at the bottom of the dialog made it ambiguous which
 * engine you were typing a key for, and on a short window it could sit below the
 * fold, which is indistinguishable from not existing.
 *
 * Engines that are catalogued but not built are shown and not selectable: hiding
 * them would make the local-first plan invisible, enabling them would make the
 * picker lie. Rust refuses them either way.
 *
 * Keys go straight to the OS keychain through the same BYOK path every other
 * provider key takes. `baseUrl` carries Azure's region; `model` carries the
 * vendor's model name or the local engine's voice — both already exist per
 * provider in that store, so nothing new persists here.
 */
export function VoiceEngineCard({
  open,
  onOpenChange,
  onChosen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after a successful choice — the call can start now. */
  onChosen?: () => void;
}) {
  const t = useT();
  const ttsProvider = useUI((s) => s.ttsProvider);
  const setTtsProvider = useUI((s) => s.setTtsProvider);
  const lang = useUI((s) => s.language);
  // The voice the CALL will actually use. Two stores held this one fact — this
  // card wrote the BYOK record, the in-call picker wrote `ttsVoice`, and the
  // call passes `ttsVoice` explicitly, which wins inside the engine. So you
  // could pick Raluca here, press Save, watch it persist, and still be answered
  // by Mihai: the in-call picker had pinned a voice of its own on first open
  // and nothing ever reconciled the two. This card now reads and writes the
  // same key the call reads.
  const pinnedVoice = useUI((s) => s.ttsVoice);
  const setTtsVoice = useUI((s) => s.setTtsVoice);

  const [engines, setEngines] = useState<TtsProviderInfo[]>([]);
  const [choice, setChoice] = useState<string | null>(ttsProvider);
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  /** `null` = not checked yet, so Save neither blocks nor lies. */
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);
  /** 0..1 while downloading, `null` when not. */
  const [downloading, setDownloading] = useState<number | null>(null);

  const clearFields = () => {
    setKey('');
    setBaseUrl('');
    setModel('');
  };

  useEffect(() => {
    if (!open) return;
    clearFields();
    tauri.voice
      .ttsProviders()
      .then((list) => {
        setEngines(list);
        // Default to the engine already in use, else the first that can speak, so
        // the common path is one click.
        setChoice((prev) => prev ?? list.find((e) => e.available)?.id ?? null);
      })
      .catch(() => setEngines([]));
  }, [open]);

  const selected = engines.find((e) => e.id === choice) ?? null;

  // Show what is actually pinned, not the fallback. An empty field made the
  // chips highlight the engine's default whatever the user had chosen, so the
  // card reported the wrong voice every time it opened.
  useEffect(() => {
    if (!open || !selected) return;
    setModel(pinnedVoice[selected.id] ?? '');
    // Only when the selection changes — retyping the field must not be undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected?.id]);

  // Whether the selected engine already has a key. Re-checked per selection: "key
  // saved" is per provider, and showing it for the wrong one would send someone
  // into a call that cannot speak.
  useEffect(() => {
    if (!open || !selected?.needsKey) {
      setHasKey(false);
      return;
    }
    let current = true;
    tauri.voice
      .ttsHasKey(selected.id)
      .then((has) => { if (current) setHasKey(has); })
      .catch(() => { if (current) setHasKey(false); });
    return () => { current = false; };
  }, [open, selected]);

  // A local engine needs its voice on disk before it can say anything. Driven by
  // the catalog's flag rather than by an id compared in this file, so the next
  // engine that needs a download gets the step instead of silently skipping it.
  const needsVoice = !!selected?.needsDownload;
  useEffect(() => {
    if (!open || !needsVoice) {
      setVoiceReady(null);
      return;
    }
    let current = true;
    const voice = model.trim() || defaultVoiceFor(selected?.id, lang);
    tauri.voice
      .voicePresent(selected?.id ?? '', voice)
      .then((present) => { if (current) setVoiceReady(present); })
      .catch(() => { if (current) setVoiceReady(null); });
    return () => { current = false; };
    // `selected?.id` matters: switching engines changes both which voice is the
    // default and who is asked whether it is present.
  }, [open, needsVoice, model, selected?.id]);

  // Download progress. Listeners live while the card is open rather than while a
  // download runs: `listen` is async, and a fast first chunk would otherwise
  // arrive before anything was listening and leave the bar at zero.
  useEffect(() => {
    if (!open) return;
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = <T,>(
      channel: { listen: (cb: (e: { payload: T }) => void) => Promise<() => void> },
      handler: (payload: T) => void,
    ) => {
      void channel.listen((e) => handler(e.payload)).then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
    };

    track(events.onTtsDownloadProgress, (p: { progress: number }) => setDownloading(p.progress));
    track(events.onTtsDownloadComplete, () => {
      setDownloading(null);
      setVoiceReady(true);
    });
    track(events.onTtsDownloadError, (p: { error: string; cancelled: boolean }) => {
      setDownloading(null);
      if (!p.cancelled) useNotifications.getState().push('error', p.error);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, [open]);

  const startDownload = async () => {
    if (!selected) return;
    setDownloading(0);
    try {
      await tauri.voice.voiceDownload(selected.id, model.trim() || defaultVoiceFor(selected.id, lang));
    } catch (err) {
      setDownloading(null);
      useNotifications.getState().push('error', err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Drop a stored key. The escape hatch for a keychain entry the user does not
   * remember putting there — without it, "a key is saved" is a claim they can
   * read but not act on.
   */
  const forgetKey = async () => {
    if (!selected) return;
    try {
      await tauri.voice.forgetTtsKey(selected.id);
      setHasKey(false);
    } catch {
      useNotifications.getState().push('error', t('voice.keySaveFailed'));
    }
  };

  const keyMissing = !!selected?.needsKey && !hasKey && key.trim().length === 0;
  const voiceMissing = needsVoice && voiceReady === false;
  const blocked =
    !selected || !selected.available || keyMissing || voiceMissing || downloading !== null || saving;

  const save = async () => {
    if (!selected || blocked) return;
    setSaving(true);
    try {
      // Local engines have no key but still have a voice to remember, so the
      // record is written for them too. An empty key means "leave the stored one
      // alone" all the way down to the keychain, so writing a voice or a region
      // cannot wipe a working key.
      if (selected.needsKey || selected.needsModel || selected.needsBaseUrl) {
        await tauri.voice.saveTtsKey(
          selected.id,
          key.trim(),
          baseUrl.trim() || undefined,
          model.trim() || undefined,
        );
      }
      setTtsProvider(selected.id);
      // The half that was missing. Without it the call keeps speaking through
      // whatever the in-call picker pinned first, and Save looks like it did
      // nothing — see the note where `pinnedVoice` is read.
      const picked = model.trim() || defaultVoiceFor(selected.id, lang);
      if (picked) setTtsVoice(selected.id, picked);
      onOpenChange(false);
      onChosen?.();
    } catch {
      useNotifications.getState().push('error', t('voice.keySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  /** Collapse the open bar without touching what is stored. */
  const cancel = () => {
    clearFields();
    setChoice(null);
  };

  const hasSettings = (e: TtsProviderInfo) =>
    e.available && (e.needsKey || e.needsBaseUrl || e.needsModel || e.needsDownload);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Capped and scrollable: five engines plus an expanded settings bar is
          taller than a short window, and inputs below the fold look missing.
          The z-index is the shadcn default on purpose — the call overlay sits at
          z-40, below this whole layer, so every dialog and dropdown opened from
          inside a call lands above it without a special case. */}
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto border-border-default bg-bg-surface">
        <DialogHeader>
          <DialogTitle>{t('engine.title')}</DialogTitle>
          <DialogDescription>{t('engine.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {engines.map((e) => {
            const active = choice === e.id;
            return (
              <div
                key={e.id}
                className={cn(
                  'overflow-hidden rounded-xl border transition-colors',
                  active ? 'border-brand bg-bg-hover' : 'border-border-default',
                  !e.available && 'opacity-50',
                )}
              >
                <button
                  type="button"
                  onClick={() => setChoice(e.id)}
                  disabled={!e.available}
                  className={cn(
                    'flex w-full items-start gap-3 p-3 text-left',
                    e.available ? 'hover:bg-bg-hover' : 'cursor-not-allowed',
                  )}
                >
                  <span className="mt-0.5 text-text-secondary">
                    {e.isLocal ? <Laptop size={18} /> : <Cloud size={18} />}
                  </span>
                  <span className="flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                      {e.label}
                      {active && e.available && <Check size={14} className="text-brand" />}
                      {!e.available && (
                        <span className="rounded bg-bg-active px-1.5 py-0.5 text-micro text-text-muted">
                          {t('engine.soon')}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-muted">{e.note}</span>
                    <span
                      className={cn(
                        'mt-1 inline-block rounded px-1.5 py-0.5 text-micro',
                        e.isLocal
                          ? 'bg-success/15 text-success'
                          : 'bg-warning/15 text-warning',
                      )}
                    >
                      {e.isLocal ? t('call.onDevice') : t('call.leavesDevice')}
                    </span>
                  </span>
                </button>

                {active && hasSettings(e) && (
                  <div className="flex flex-col gap-2 border-t border-border-subtle p-3">
                    {e.needsKey && (
                      <>
                        {/* Which of the two states we are in, said out loud. An
                            engine with a key already in the keychain used to look
                            identical to one with none, so confirming appeared to
                            skip the key entirely. */}
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className={hasKey ? 'text-success' : 'text-warning'}>
                            {hasKey ? t('engine.keyPresent') : t('engine.keyRequired')}
                          </span>
                          {hasKey && (
                            <button
                              type="button"
                              onClick={() => void forgetKey()}
                              className="text-text-muted underline-offset-2 hover:text-error hover:underline"
                            >
                              {t('engine.keyForget')}
                            </button>
                          )}
                        </div>
                        <Input
                          type="password"
                          autoComplete="off"
                          value={key}
                          onChange={(ev) => setKey(ev.target.value)}
                          placeholder={hasKey ? t('engine.keySaved') : t('call.keyPlaceholder')}
                        />
                      </>
                    )}

                    {e.needsBaseUrl && (
                      <Input
                        value={baseUrl}
                        onChange={(ev) => setBaseUrl(ev.target.value)}
                        placeholder={t('engine.baseUrlPlaceholder')}
                      />
                    )}

                    {e.needsModel && (
                      <Input
                        value={model}
                        onChange={(ev) => setModel(ev.target.value)}
                        placeholder={
                          e.needsDownload
                            ? `${t('engine.voicePlaceholder')} (${defaultVoiceFor(e.id, lang)})`
                            : t('engine.modelPlaceholder')
                        }
                      />
                    )}

                    {e.needsDownload && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap gap-1.5">
                          {(voicesFor(e.id, lang)?.offer ?? []).map((v) => {
                            const active = (model.trim() || defaultVoiceFor(e.id, lang)) === v.id;
                            return (
                              <button
                                key={v.id}
                                type="button"
                                onClick={() => setModel(v.id)}
                                className={cn(
                                  'rounded-full border px-2.5 py-1 text-2xs transition-colors',
                                  active
                                    ? 'border-brand bg-brand/10 text-brand'
                                    : 'border-border-default text-text-secondary hover:text-text-primary',
                                )}
                              >
                                {v.label}
                              </button>
                            );
                          })}
                        </div>
                        {/* A licence that requires credit gets it here, beside
                            the voices it covers. */}
                        {voicesFor(e.id, lang)?.credit && (
                          <p className="text-micro text-text-muted">{voicesFor(e.id, lang)!.credit}</p>
                        )}
                      </div>
                    )}

                    {e.needsDownload &&
                      (downloading !== null ? (
                        <div className="flex items-center gap-2 text-xs text-text-muted">
                          <Loader2 size={14} className="animate-spin" />
                          {t('engine.downloading')} {Math.round(downloading * 100)}%
                        </div>
                      ) : (
                        voiceReady === false && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-2 self-start"
                            onClick={() => void startDownload()}
                          >
                            <Download size={14} />
                            {t('engine.downloadVoice')}
                          </Button>
                        )
                      ))}

                    {e.consoleUrl && (
                      <ExternalLink href={e.consoleUrl} className="self-start text-xs">
                        {t('engine.getKey')}
                      </ExternalLink>
                    )}

                    <div className="mt-1 flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={cancel}>
                        {t('engine.cancel')}
                      </Button>
                      <Button size="sm" onClick={() => void save()} disabled={blocked}>
                        {saving ? <Loader2 size={14} className="animate-spin" /> : t('engine.save')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
