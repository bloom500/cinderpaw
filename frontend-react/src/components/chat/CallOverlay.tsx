// Aliased: the bare name would shadow the DOM `KeyboardEvent` that the Escape
// listener below is typed against.
import {
  lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Phone, X, Loader2, MessageSquare, ArrowUp, Laptop, Cloud, Settings2,
  AudioLines, ChevronDown, Archive,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { preferredVoice, shortlistVoices } from '@/lib/voices';
import { MessageItem } from './MessageItem';
import { CallToolScreen } from './CallToolScreen';
import { CallArtifacts } from './CallArtifacts';
import { useLiveToolActivity } from '@/hooks/useLiveToolActivity';
import { subscribeArtifacts, artifactsSnapshot } from '@/lib/callArtifacts';
/**
 * Loaded only when a call opens. three.js is ~1.1 MB of the bundle and this is
 * the one screen that uses it — bundling it into the entry chunk made every
 * cold start pay for a sphere most sessions never see. Suspense falls back to
 * nothing on purpose: the CSS orb is already rendered underneath, so the wait
 * is invisible rather than a hole.
 */
const CallOrb3D = lazy(() => import('./CallOrb3D').then((m) => ({ default: m.CallOrb3D })));
import { tauri, type TtsProviderInfo, type TtsVoice } from '@/lib/tauri';
import { useUI } from '@/stores/ui';
import { useChat } from '@/stores/chat';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { CallPhase } from '@/hooks/useCallSession';

/**
 * The in-call screen: one orb, one line of state, two buttons.
 *
 * A call has no scrollback and no undo, so what is happening has to be readable
 * from across the room — hence one large indicator instead of a status line, and
 * nothing else competing with it. The mic level drives the orb while listening,
 * which is also the only honest way to show that it is really hearing you.
 *
 * **Rendered through a portal to `document.body`, and that is not cosmetic.**
 * `ChatPage` animates the input strip with `transform: translateY(...)`, and a
 * transformed ancestor becomes the containing block for `position: fixed`. Inside
 * it, `fixed inset-0` resolved to the input strip rather than the viewport: the
 * background painted a bar at the bottom while the flex children spilled out over
 * a chat that was still fully visible. The portal escapes the transform, the
 * z-index stack, and the gradient on that wrapper in one move.
 */
/**
 * Whose key the Live engine borrows. Rust reads the same slot — there is no
 * second key to enter and no way for the two to disagree about which is current.
 */
const LIVE_KEY_PROVIDER = 'google';

export function CallOverlay({
  phase,
  heard,
  level,
  notice,
  onAnswer,
  onHangUp,
  onInterrupt,
  onSay,
  onChangeEngine,
  onChangeStt,
  onChangeMode,
}: {
  phase: CallPhase;
  heard: string;
  level: number;
  /** Why the last turn said nothing, when it said nothing. */
  notice: string | null;
  onAnswer: () => void;
  onHangUp: () => void;
  onInterrupt: () => void;
  /** Absent when the running engine has no text channel — see the Live hook. */
  onSay?: (text: string) => void;
  onChangeEngine: () => void;
  onChangeStt: () => void;
  /** Switching mode swaps which loop drives this screen, so the owner does it
   *  rather than the store: the outgoing call has to be hung up and the incoming
   *  one opened, or the overlay would vanish mid-choice. */
  onChangeMode: (mode: 'pipeline' | 'live') => void;
}) {
  const t = useT();
  const [chatOpen, setChatOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // Only offered once there is something in it. A drawer that opens on an empty
  // list teaches the user it is empty, and they stop opening it.
  const artifactCount = useSyncExternalStore(subscribeArtifacts, artifactsSnapshot).length;
  const sttProvider = useUI((s) => s.sttProvider);
  const ttsProvider = useUI((s) => s.ttsProvider);
  const callEngine = useUI((s) => s.callEngine);
  const live = callEngine === 'live';
  // Both call modes end up asking the same agent, and the agent reports its
  // tools on one channel, so one listener serves both. Only while the call is
  // actually up — a listener attached at `idle` would collect the tool calls of
  // whatever the user is doing in the chat behind the overlay.
  const toolActivity = useLiveToolActivity(phase !== 'idle' && phase !== 'ready');
  /** Any tool still running. Feeds the sphere, which shows work as movement
   *  inside the glass rather than as another speed — see CallOrb3D. */
  const workingNow = toolActivity.some((a) => a.status === 'running');
  const [voice, setVoice] = useState<TtsProviderInfo | null>(null);
  /** Can the chosen engine actually speak? `null` until known — the Call button
   *  must not be blocked by a check that has not answered yet, nor allowed by one
   *  that failed. */
  const [ready, setReady] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [mic, setMic] = useState<string | null>(null);

  /**
   * The actual input device, named.
   *
   * It was missing entirely, and its absence made the engine rows read as if they
   * were the hardware — "Groq" appeared where someone reasonably expected to see
   * their microphone. Device labels are only exposed once microphone permission
   * has been granted at least once, so an empty label is normal on a first run and
   * falls back to saying "system default" rather than to nothing.
   */
  useEffect(() => {
    if (phase !== 'ready' || !navigator.mediaDevices?.enumerateDevices) return;
    let current = true;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!current) return;
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        const preferred = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
        setMic(preferred?.label?.trim() || null);
      })
      .catch(() => { if (current) setMic(null); });
    return () => { current = false; };
  }, [phase]);

  // The engine the user picked, and whether it can actually speak. Asked of Rust
  // rather than hardcoded here: `isLocal` is a property of the engine, and this
  // notice is the reason the catalog carries it.
  useEffect(() => {
    if (phase !== 'ready') return;
    setKey('');
    if (live) {
      // Speech to speech has no TTS engine to be ready — its one requirement is
      // the Google key it borrows from the keychain, the same AI Studio key the
      // chat side already uses.
      setVoice(null);
      tauri.voice.ttsHasKey(LIVE_KEY_PROVIDER).then(setReady).catch(() => setReady(null));
      return;
    }
    tauri.voice
      .ttsProviders()
      .then(async (providers) => {
        const chosen = providers.find((e) => e.id === ttsProvider) ?? null;
        setVoice(chosen);
        // "Ready", not "has a key": Piper needs no key and would pass a key check
        // with no voice downloaded, which is a call that listens, thinks, and then
        // cannot answer.
        setReady(chosen ? await tauri.voice.ttsReady(chosen.id) : null);
      })
      .catch(() => {
        setVoice(null);
        setReady(null);
      });
  }, [phase, ttsProvider, live]);

  const saveKey = async () => {
    const target = live ? LIVE_KEY_PROVIDER : voice?.id;
    if (!target || !key.trim()) return;
    setSaving(true);
    try {
      // Straight to the OS keychain, the same path every other provider key
      // takes. It is never written to a file and never echoed back.
      await tauri.voice.saveTtsKey(target, key.trim());
      // ponytail: no base URL / model field here — the picker owns those. An
      // engine that needs a region cannot be fixed from this panel; the "change
      // voice engine" link goes where it can.
      setKey('');
      setReady(true);
    } catch {
      useNotifications.getState().push('error', t('voice.keySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Escape hangs up. A screen this opaque needs the standard way out — but not
  // while a dialog is open on top of it: there, Escape belongs to the dialog, and
  // handling it here too would close the settings AND drop the call in one press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]')) return;
      onHangUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onHangUp]);

  if (phase === 'idle') return null;

  const speaking = phase === 'speaking';
  const listening = phase === 'listening';

  const title =
    listening ? t('call.listening')
    // In a Live call nothing local ever "thinks" — the model's own thinking shows
    // up as its answer arriving. This phase is only ever the socket opening.
    : phase === 'thinking' ? t(live ? 'call.liveConnecting' : 'call.thinking')
    : speaking ? t('call.speaking')
    : t('call.title');

  return createPortal(
    // `z-40`, deliberately BELOW the app's z-50 layer.
    //
    // At z-[100] this overlay sat above every Radix portal — dialogs, dropdowns,
    // image zoom all render at z-50 — so anything opened from inside the call
    // appeared behind it while Radix froze the page for modality. That produced
    // the same bug three times: an invisible engine picker, an invisible STT
    // card, and a voice dropdown that would not drop. Sitting under that layer
    // fixes the whole class instead of patching each popover's z-index.
    //
    // Window chrome and toasts live at z-200 and stay above everything.
    <div className="fixed inset-0 z-40 flex" style={{ backgroundColor: 'var(--bg-primary, #100E09)' }}>
      {/* The frameless window still has to be movable while a call covers the
          screen. This strip spans the top and does nothing else. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-8" />

      <div
        className="call-stage relative flex flex-1 flex-col items-center justify-center gap-10 overflow-hidden px-6"
        style={{
          background: [
    // The reference read properly this time: it is not pools of light, it is one
    // broad diagonal BEAM crossing the surface from lower left to upper right,
    // with the corners falling into deep red. Beam plus vignette. Earlier passes
    // kept adding soft pools, which averages to an even field — the exact thing
    // the reference is not. Layers paint first-on-top, so the corner darkening is
    // listed first and the base last.
    'radial-gradient(ellipse 62% 56% at 4% 2%, rgba(122, 20, 4, 0.62) 0%, transparent 62%)',
    'radial-gradient(ellipse 72% 62% at 98% 98%, rgba(138, 26, 6, 0.52) 0%, transparent 64%)',
    'linear-gradient(126deg, transparent 10%, rgba(255, 150, 82, 0.34) 34%, rgba(255, 198, 146, 0.46) 50%, rgba(255, 142, 70, 0.24) 66%, transparent 90%)',
    'radial-gradient(ellipse 88% 68% at 74% 16%, #F4581F 0%, transparent 66%)',
    'linear-gradient(160deg, #E8410F 0%, #D2340C 52%, #E04A1A 100%)',
          ].join(', '),
        }}
      >
        {/* The field's one moving part, and it moves only while a voice is in
            the room: listening or speaking, never thinking and never at rest.
            A background that drifts continuously becomes wallpaper within
            thirty seconds — tying it to speech makes the screen answer the one
            question a caller actually has, which is whether anything is
            happening. While listening it also swells with the measured mic
            level, so it is reacting to YOU rather than performing. */}
        {(phase === 'listening' || phase === 'speaking') && (
          <div
            aria-hidden
            className="orb-motion pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{
              background:
                'radial-gradient(ellipse 58% 46% at 62% 28%, rgba(255,196,130,0.30) 0%, transparent 62%)',
              // Listening tracks the microphone; speaking has no measured
              // loudness (the audio is scheduled, never read back), so it
              // breathes on the clock instead of faking a level.
              opacity: phase === 'listening' ? 0.45 + level * 0.55 : 0.75,
              animation: `stage-drift ${phase === 'listening' ? '7s' : '5s'} ease-in-out infinite`,
            }}
          />
        )}

        {/* The close glow that seats the sphere in the field — kept, because
            without it the ball floats a centimetre off the surface. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-700"
          style={{
            background:
              'radial-gradient(circle, rgba(255,214,170,0.20) 0%, rgba(255,150,80,0.08) 38%, transparent 62%)',
            opacity: phase === 'ready' ? 0.55 : 0.95,
          }}
        />

        <Orb phase={phase} level={level} working={workingNow} />

        {/* Voice picker, live for the whole call. Deliberately not buried in the
            pre-call panel: which voice is talking is the one setting you want to
            change WHILE hearing it, and the next thing said picks it up. */}
        {/* No language selector, by product decision: the transcriber is expected
            to identify the spoken language on its own. What replaced the manual
            escape hatch is `useCallSession`'s learned hint — the language of the
            last confidently transcribed turn is carried into the next one, so
            detection happens once on good evidence instead of being re-guessed on
            every fragment. */}
        {/* Nothing to pick in a Live call: the voice belongs to the model, not to
            a synthesiser we choose. */}
        {!live && ttsProvider && <VoicePicker engineId={ttsProvider} />}

        <div className="relative flex max-w-xl flex-col items-center gap-2 text-center">
          <p className="text-2xl font-light tracking-tight text-text-primary">{title}</p>
          {/* What it heard, or the invitation when it has heard nothing yet. */}
          <p className="text-lg font-light text-text-muted">
            {heard && phase !== 'ready' ? `“${heard}”` : t('call.prompt')}
          </p>
          {/* Said out loud on screen when nothing was said out loud in audio. */}
          {notice && <p className="text-sm text-[var(--warning)]">{notice}</p>}
        </div>

        {phase === 'ready' && (
          <div className="relative flex flex-col items-center gap-3">
            {/* Which KIND of call, above the engines it selects — a pipeline of
                three or one model doing all three. Chosen before the microphone
                opens because it decides what the disclosure below even lists. */}
            <ModeToggle mode={callEngine} onChange={onChangeMode} t={t} />

            {/* The disclosure, as two quiet lines rather than a boxed table: it has
                to be read before the microphone opens, not filled in. */}
            <div className="flex flex-col items-center gap-1.5 text-sm">
              {/* The hardware first, so nothing below it can be mistaken for it. */}
              <span className="flex items-center gap-2">
                <span className="text-text-muted">{t('call.mic')}</span>
                <span className="text-text-secondary">{mic ?? t('call.micDefault')}</span>
              </span>
              {live ? (
                // One line, because there is one engine. Listing "speech → text"
                // and "text → speech" here would describe steps that do not happen.
                <EngineLine label={t('call.modeLive')} name={t('call.liveEngine')} local={false} t={t} />
              ) : (
                <>
                  <EngineLine
                    label={t('call.stt')}
                    name={sttProvider === 'groq' ? 'Groq · whisper-large-v3' : 'Whisper'}
                    local={sttProvider !== 'groq'}
                    t={t}
                    // Both halves of the call are configurable from here. Only the
                    // speaking half had a way in, so the engine that hears you — and
                    // its key — could not be reached from the screen that names it.
                    onChange={onChangeStt}
                  />
                  <EngineLine
                    label={t('call.tts')}
                    name={voice?.label ?? '—'}
                    local={voice?.isLocal ?? false}
                    t={t}
                    onChange={onChangeEngine}
                  />
                </>
              )}
            </div>

            {/* What is different about this mode, said once: it hears you
                directly, it can be cut off mid-sentence, and each finished turn
                lands in the chat. */}
            {live && (
              <p className="max-w-sm text-center text-xs text-text-muted">{t('call.liveNote')}</p>
            )}

            {ready === false && voice?.needsDownload && (
              <p className="max-w-sm text-center text-xs text-[var(--warning)]">{t('call.voiceMissing')}</p>
            )}
            {ready === false && (live || voice?.needsKey) && (
              <div className="w-full max-w-sm">
                <p className="mb-2 text-center text-xs text-text-muted">
                  {t(live ? 'call.liveNoKey' : 'call.keyNeeded')}
                </p>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
                    placeholder={t('call.keyPlaceholder')}
                    className="h-9 text-sm"
                  />
                  <Button size="sm" onClick={() => void saveKey()} disabled={!key.trim() || saving}>
                    {saving ? <Loader2 size={14} className="animate-spin" /> : t('call.keySave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Controls: one pill, round buttons, nothing labelled. A call is the one
            screen where the two things you can do are obvious from the icons. */}
        {/* Opaque surface and the stronger border, not a 70% wash over the page.
            In dark that translucency read as a pill; in light it put #F5EBE0 at
            70% over #FFF5EE, which is the same colour — the two most important
            controls on the screen sat in a container nobody could see. A shadow
            does the lifting that the transparency was pretending to do. */}
        <div className="relative flex items-center gap-2 rounded-full border border-border-default bg-bg-surface p-2 shadow-lg">
          <RoundButton onClick={onHangUp} label={t('call.hangUp')} tone="danger">
            <X size={20} />
          </RoundButton>

          {phase === 'ready' ? (
            <RoundButton
              onClick={onAnswer}
              label={t('call.answer')}
              tone="brand"
              // Opening the microphone for a call that cannot answer wastes the
              // words someone already said. `null` (the check failed) still allows
              // it: refusing on an unknown is worse than letting the engine report
              // the truth.
              disabled={ready === false}
            >
              <Phone size={20} />
            </RoundButton>
          ) : (
            <RoundButton
              onClick={onInterrupt}
              label={t('call.interrupt')}
              // Only meaningful while it is talking; the rest of the time it is a
              // state light, which is why it dims instead of disappearing.
              disabled={!speaking}
              active={listening}
            >
              {speaking ? <MicOff size={20} /> : <Mic size={20} />}
            </RoundButton>
          )}
        </div>

        {/* What Feral is doing, while it does it. The one thing that separates a
            call that is working from one that has hung — and, on a call that
            runs tools, the only visible evidence the agent is real. */}
        <CallToolScreen activity={toolActivity} />

        {/* The way back to text, for what dictation mangles — a URL, a name, an
            error string. Closed by default so the call stays a call. */}
        {/* The sources, kept. Sits above the chat button and appears only once
            a lookup has produced something to return to. */}
        {artifactCount > 0 && !artifactsOpen && (
          <button
            type="button"
            onClick={() => setArtifactsOpen(true)}
            aria-label={t('call.artifacts')}
            title={t('call.artifacts')}
            className="absolute bottom-24 right-6 flex items-center gap-1.5 rounded-full border border-border-default bg-bg-elevated px-3 py-2 text-xs text-text-secondary shadow-lg transition-colors hover:border-brand hover:text-brand"
          >
            <Archive size={15} />
            {artifactCount}
          </button>
        )}

        {phase !== 'ready' && !chatOpen && onSay && (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            aria-label={t('call.chat')}
            title={t('call.chat')}
            className="absolute bottom-6 right-6 rounded-full border border-border-default bg-bg-elevated p-3 text-text-secondary shadow-lg transition-colors hover:border-brand hover:text-brand"
          >
            <MessageSquare size={18} />
          </button>
        )}
      </div>

      {artifactsOpen && <CallArtifacts onClose={() => setArtifactsOpen(false)} />}
      {chatOpen && onSay && <CallChatPanel onClose={() => setChatOpen(false)} onSay={onSay} />}
    </div>,
    document.body,
  );
}

/**
 * The living part of the screen.
 *
 * Listening scales with the measured mic level, so it reacts to *you*. The other
 * states animate on their own, because the reply's loudness is never measured —
 * the audio is scheduled on the Web Audio clock, not read back, and faking a
 * waveform from nothing would be a lie in the one place the user is looking for
 * feedback. `CallOrb3D` carries the state as tempo instead.
 */
function Orb({ phase, level, working }: { phase: CallPhase; level: number; working: boolean }) {
  /** True once WebGL is up. The plain ball below is only there for when it is
   *  not, and has to get out of the way when it is — drawn under the real
   *  sphere, it showed through its edges. */
  const [gl, setGl] = useState(false);
  // The mic only scales the sphere while listening; elsewhere it sits still.
  const listening = phase === 'listening';
  const micScale = listening ? 1 + level * 0.14 : 1;

  return (
    <div className="relative flex h-60 w-60 items-center justify-center">
      {/* Halo — tracks the sphere one step behind, so loud speech pushes light
          outward instead of only stretching the disc. Kept faint: at 32% it was a
          second glowing ring around a glowing ball, which is what made the screen
          look cheap. */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-full transition-transform duration-150"
        style={{
          transform: `scale(${1 + (micScale - 1) * 1.8})`,
          background:
            // Cool, like the sphere it tracks — a brand-orange halo around a
            // chrome ball on an orange field made the edge disappear entirely.
            'radial-gradient(circle, rgba(214,206,255,0.16) 42%, transparent 70%)',
        }}
      />

      {/* The real sphere. If WebGL is unavailable it renders nothing and the
          plain ball below stays visible — a call screen with an empty middle is
          worse than an approximate one. */}
      <Suspense fallback={null}>
        <CallOrb3D
          phase={phase}
          level={level}
          working={working}
          onActive={setGl}
        />
      </Suspense>

      {/* The fallback, and only that: one gradient ball, no bands and no
          keyframes. Everything that made this a second implementation of the
          sphere is gone — `CallOrb3D` is the sphere, and this is what is left
          when it cannot run. */}
      <div
        aria-hidden
        className="relative h-44 w-44 rounded-full transition-transform duration-150"
        style={{
          transform: `scale(${micScale})`,
          opacity: gl ? 0 : 1,
          background: 'radial-gradient(circle at 46% 36%, #C9BEEE 0%, #8C7FC4 46%, #4A3E78 100%)',
          boxShadow: '0 0 54px rgba(196, 186, 255, 0.34), 0 18px 44px rgba(60, 20, 8, 0.30)',
        }}
      />
    </div>
  );
}

/**
 * Which voice answers, switchable mid-call.
 *
 * The list comes from the vendor on open, never from a constant in this file: a
 * Fish voice can be cloned this afternoon and an Azure locale added next month.
 * An engine that publishes no list (a self-hosted gateway) returns an empty one,
 * and then this shows a text field instead of pretending there is no choice.
 *
 * Pinning a voice is also what fixed replies arriving in two different voices —
 * see the split in `useCallSession`.
 */
function VoicePicker({ engineId }: { engineId: string }) {
  const t = useT();
  const chosen = useUI((s) => s.ttsVoice[engineId]);
  const setTtsVoice = useUI((s) => s.setTtsVoice);
  // Rank by the language actually being spoken. `auto` means unknown, and then
  // multilingual voices lead — they are the ones that work either way.
  const spoken = useUI((s) => s.spokenLanguage);
  const spokenLocale = spoken === 'auto' ? null : spoken;
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let current = true;
    setVoices(null);
    setFailed(false);
    tauri.voice
      .ttsVoices(engineId)
      .then((list) => {
        if (!current) return;
        setVoices(list);
        // Pin one immediately if nothing is chosen. Leaving it unset used to mean
        // "let the vendor decide", and Fish decides PER REQUEST — so one reply came
        // back in one voice and the next in another. A voice is always explicit
        // from here on; the user can change it, but not to "unspecified".
        if (!chosen && list.length > 0) {
          const pick = preferredVoice(list, spokenLocale);
          if (pick) setTtsVoice(engineId, pick.id);
        }
      })
      .catch(() => { if (current) { setVoices([]); setFailed(true); } });
    return () => { current = false; };
    // `chosen` is read but deliberately not a dependency: this runs per engine, and
    // re-running it on every voice change would fight the user's own selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineId]);

  if (voices === null) {
    return (
      <span className="flex items-center gap-2 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t('call.voicesLoading')}
      </span>
    );
  }

  // No list to choose from: let the id be typed rather than hiding the control.
  if (voices.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim()) setTtsVoice(engineId, typed.trim()); }}
          placeholder={failed ? t('call.voicesFailed') : t('call.voiceIdPlaceholder')}
          className="h-8 w-72 text-xs"
        />
        <Button size="sm" variant="outline" disabled={!typed.trim()} onClick={() => setTtsVoice(engineId, typed.trim())}>
          {t('engine.save')}
        </Button>
      </div>
    );
  }

  const shortlist = shortlistVoices(voices, spokenLocale, chosen);
  const current = voices.find((v) => v.id === chosen);

  return (
    // A themed dropdown, not a native `<select>`: the native one draws its list
    // with the operating system's colours, which on a dark theme came out as dark
    // text on a dark popup — unreadable exactly where the choice is made.
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('call.voice')}
          className="flex items-center gap-2 rounded-full border border-border-default bg-bg-surface/70 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-brand hover:text-text-primary"
        >
          <AudioLines size={13} className="text-brand" />
          {current?.label ?? t('call.voicesLoading')}
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="bottom" className="w-72">
        <DropdownMenuLabel className="text-xs text-text-muted">
          {t('call.voice')} · {voices.length} {t('call.voicesAvailable')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={chosen ?? ''}
          onValueChange={(id) => setTtsVoice(engineId, id)}
        >
          {/* No "vendor default" row. It was the cause of a reply arriving in one
              voice and the next in another: the vendor resolves its default per
              request, so "unspecified" is not a stable choice, it is a lottery. */}
          {shortlist.map((v) => (
            <DropdownMenuRadioItem key={v.id} value={v.id} className="text-sm">
              <span className="truncate">{v.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {voices.length > shortlist.length && (
          <>
            <DropdownMenuSeparator />
            {/* The shortlist is a cut, and saying so is cheaper than a hundred rows
                — the id field below stays the way to reach any of the rest. */}
            <div className="px-2 py-1.5">
              <p className="mb-1.5 text-[10px] text-text-muted">{t('call.voiceMore')}</p>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typed.trim()) setTtsVoice(engineId, typed.trim());
                }}
                placeholder={t('call.voiceIdPlaceholder')}
                className="h-7 text-xs"
              />
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RoundButton({
  onClick,
  label,
  children,
  tone = 'neutral',
  disabled,
  active,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'danger';
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        // A border on every tone. `bg-bg-elevated` is #252119 on dark, which
        // reads as a button against the surface, and #FFFFFF on light, which
        // reads as nothing against #FFF5EE — so the shape has to be drawn
        // rather than implied by a fill that only contrasts in one theme.
        'flex h-14 w-14 items-center justify-center rounded-full border transition-colors',
        // Themed tokens rather than Tailwind's palette: `--error` is tuned per
        // theme (#C0472A dark, #A03820 light) while `rose-400` is a single
        // value picked to sit on black and washes out on cream.
        tone === 'danger' &&
          'border-border-default bg-bg-elevated text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]',
        tone === 'brand' && 'border-transparent bg-brand text-bg-primary hover:bg-brand-hover',
        tone === 'neutral' && 'border-border-default bg-bg-elevated text-text-secondary hover:bg-bg-hover',
        active && 'text-brand',
        disabled && 'cursor-default opacity-40 hover:bg-bg-elevated',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Pipeline or speech to speech, before anything else on the pre-call screen.
 *
 * A toggle rather than a row in the voice engine picker, because it is not a
 * voice: picking Live replaces the transcriber, the model and the synthesiser at
 * once. The switch is handled by the owner, not written straight to the store —
 * the two modes run on different loops, and the outgoing one has to be hung up.
 */
function ModeToggle({
  mode,
  onChange,
  t,
}: {
  mode: 'pipeline' | 'live';
  onChange: (mode: 'pipeline' | 'live') => void;
  t: (key: 'call.modePipeline' | 'call.modeLive') => string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-border-subtle bg-bg-surface/70 p-1">
      {(['pipeline', 'live'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => { if (m !== mode) onChange(m); }}
          aria-pressed={m === mode}
          className={cn(
            'rounded-full px-3 py-1 text-xs transition-colors',
            m === mode
              ? 'bg-brand text-bg-primary'
              : 'text-text-muted hover:text-text-primary',
          )}
        >
          {t(m === 'live' ? 'call.modeLive' : 'call.modePipeline')}
        </button>
      ))}
    </div>
  );
}

function EngineLine({
  label,
  name,
  local,
  t,
  onChange,
}: {
  label: string;
  name: string;
  local: boolean;
  t: (key: 'call.onDevice' | 'call.leavesDevice' | 'engine.change') => string;
  /** Omitted for an engine with nothing to configure from here. */
  onChange?: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary">{name}</span>
      {/* A border as well as a fill, and a foreground picked per theme rather
          than shared with the base palette. This badge is the one line on the
          pre-call screen that tells the user their voice leaves the machine, and
          at 10px the shared `--warning` gives about 2.9:1 on cream — readable
          only if you already know what it says. A tinted fill with no edge also
          vanishes on a light background; the edge is what keeps it a badge. */}
      <span
        className={cn(
          'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
          local
            ? 'border-[var(--badge-ok-br)] bg-[var(--badge-ok-bg)] text-[var(--badge-ok-fg)]'
            : 'border-[var(--badge-warn-br)] bg-[var(--badge-warn-bg)] text-[var(--badge-warn-fg)]',
        )}
      >
        {local ? <Laptop size={10} /> : <Cloud size={10} />}
        {local ? t('call.onDevice') : t('call.leavesDevice')}
      </span>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          aria-label={t('engine.change')}
          title={t('engine.change')}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-brand"
        >
          <Settings2 size={13} />
        </button>
      )}
    </span>
  );
}

/**
 * The conversation, beside the call rather than behind it.
 *
 * Typed messages do not send themselves — they are handed to the call loop
 * (`onSay`), which is the only thing that takes turns. Sending straight from here
 * would put a second question to the model while the first was still in flight,
 * and the answer spoken aloud would be whichever came back first.
 */
function CallChatPanel({ onClose, onSay }: { onClose: () => void; onSay: (text: string) => void }) {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const status = useChat((s) => s.streamStatus);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the conversation. Without this the panel opens showing the top of a
  // long call with the newest turn off screen.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const submit = () => {
    if (!text.trim()) return;
    onSay(text);
    setText('');
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    // `pt-8` clears the window controls, which are fixed to the top-right corner
    // above everything. Without it this panel's own close button sat directly
    // under the application's close button — two X's in a column, and the wrong
    // one is the one that quits.
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-border-default bg-bg-surface pt-8">
      <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        {/* Close on the LEFT, for the same reason: the top-right corner of the
            window belongs to the window, not to a panel inside it. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('call.chatClose')}
          title={t('call.chatClose')}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={16} />
        </button>
        <span className="text-sm font-medium text-text-primary">{t('call.chat')}</span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            streaming={status === 'streaming' && m.id === lastAssistantId}
          />
        ))}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border-subtle p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('call.chatPlaceholder')}
            rows={1}
            // Its own colour, explicitly. `Textarea` declares none and inherits,
            // which is fine in the chat page and wrong inside this portal: the
            // overlay's ancestry gave typed text the brand orange, so what the
            // user was writing came out looking like a link rather than like
            // their own words. An input that depends on where it is mounted for
            // whether it is readable is a bug waiting for the next portal.
            className="max-h-32 resize-none text-sm text-text-primary placeholder:text-text-muted"
          />
          <Button size="icon" onClick={submit} disabled={!text.trim()} aria-label={t('chat.send')} className="h-8 w-8 shrink-0">
            <ArrowUp size={13} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
