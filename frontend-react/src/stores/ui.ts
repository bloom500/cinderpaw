import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ReasoningMode = 'auto' | 'on' | 'off';
export type ToolId = 'web_search' | 'http_request' | 'file_read' | 'file_write' | 'code_execute';
// English only this release; the next one adds ~70 languages.
export type LangPref = 'en';
export type InputMode = 'chat' | 'agent';
/**
 * Which on-device transcription model to use, by id.
 *
 * A plain string, not a union, and that is the point: the ids come from the
 * Rust catalog (`stt_models`), so they depend on which engine the binary was
 * built with. A union here would have to be edited every time the engine
 * changes, and would keep type-checking while naming a model that no longer
 * exists. `''` means "not chosen yet" and resolves to the first model the
 * build offers.
 */
export type SttModelId = string;
/** Speech-to-text backend for voice messages. `null` = user hasn't chosen yet
 *  (first mic tap opens the provider card). `groq` = cloud whisper-large-v3. */
/** `local` = on-device; the cloud ids match `stt::cloud` in Rust, and
 *  `openrouter` sends the same key the chat side already stores. */
export type SttProvider = 'local' | 'groq' | 'openrouter';
/** What each cloud transcriber is called, and which BYOK key it sends. */
export const CLOUD_STT: Record<Exclude<SttProvider, 'local'>, { name: string; keyProvider: string }> = {
  groq: { name: 'Groq · whisper-large-v3', keyProvider: 'groq' },
  openrouter: { name: 'OpenRouter · Fish transcribe-1', keyProvider: 'openrouter' },
};

export type CallEngine = 'pipeline' | 'live' | 'livekit';

/**
 * The engines a person can actually pick, newest first.
 *
 * `pipeline` and `live` are retired, not deleted: the day a new engine
 * misbehaves is the day somebody needs the old one back, and deleting the code
 * is the one version of that decision which cannot be undone in an afternoon.
 * They are gone from the picker and nothing selects them any more.
 */
export const CALL_ENGINES: readonly CallEngine[] = ['livekit'];

/**
 * Engines that still run but are no longer offered.
 *
 * This list is load-bearing, not documentation. Dropping the two values from
 * the picker only stops them being CHOSEN — every machine that already picked
 * one has it sitting in `cinderpaw-ui` and would keep running a retired engine
 * forever, with nothing on screen saying why voice behaves differently there
 * than everywhere else. `merge` below reads this and moves those machines over.
 */
export const RETIRED_CALL_ENGINES: readonly CallEngine[] = ['pipeline', 'live'];

interface UIStore {
  /** Navigation chrome only. Nothing about the agent or the runtime lives
   *  here — the rail answers "where do I want to go" and nothing else. */
  navCollapsed: boolean;
  toggleNav: () => void;
  theme: ThemePref;
  resolvedTheme: ResolvedTheme;
  language: LangPref;
  /** Read-only, and neither persisted nor settable. The composer controls that
   *  used to write these are gone, so the setters went with them rather than
   *  staying as an API nothing calls. `useSendMessage` and `MessageItem` still
   *  read them — at their defaults, which is the only value they ever had that
   *  was right for everybody. */
  reasoningMode: ReasoningMode;
  enabledTools: ToolId[];
  setTheme: (t: ThemePref) => void;
  searchOpen:  boolean;
  /**
   * Project the search should open narrowed to, when it was opened from
   * something that already names one (a Home card). Null means search
   * everything, which is what ⌘K and the menu item do.
   */
  searchScopeId: string | null;
  openSearch:  (projectId?: string) => void;
  closeSearch: () => void;
  skillsOpen:  boolean;
  openSkills:  () => void;
  closeSkills: () => void;
  /** The agent called `suggest_skill` on the current task: show the teach
   *  offer above the composer. Not persisted: it belongs to this task. */
  skillTip: boolean;
  setSkillTip: (v: boolean) => void;
  inputMode: InputMode;
  setInputMode: (m: InputMode) => void;
  /** #24: pixel-art mascot on the typing bar. Some users want it off. */
  mascotEnabled: boolean;
  setMascotEnabled: (v: boolean) => void;
  /** On-device transcription model id, from the Rust catalog. `''` until the
   *  user picks one, or when the stored one is not in this build. */
  sttModel: SttModelId;
  setSttModel: (m: SttModelId) => void;
  /** Chosen STT backend. `null` until the user picks in the provider card. */
  sttProvider: SttProvider | null;
  setSttProvider: (p: SttProvider) => void;
  /**
   * Chosen voice (TTS) engine id, from the Rust catalog — a string rather than a
   * union because the catalog is the source of truth and a TS union here would
   * be a second list to keep in sync. `null` until the user picks on the first
   * call, which is also what makes the picker appear.
   */
  ttsProvider: string | null;
  setTtsProvider: (id: string) => void;
  /**
   * Which kind of call runs: the `STT → model → TTS` pipeline, or a
   * speech-to-speech session where one model does all three.
   *
   * Not a value in `ttsProvider`, even though picking it is the same gesture:
   * listing Gemini Live beside Piper and Fish would say it is a voice for the
   * pipeline, and it is a replacement for the pipeline. The two run on different
   * loops and only one of them has a text-to-speech engine at all.
   *
   * Only `livekit` is offered now — see `CALL_ENGINES`. The other two still run
   * if something selects them, which is what makes them recoverable rather than
   * deleted.
   */
  callEngine: CallEngine;
  setCallEngine: (e: CallEngine) => void;
  /**
   * Which speech-to-speech vendor the LiveKit call runs on, by BYOK id.
   *
   * `null` until picked, and `null` is a working state rather than a broken
   * one: Rust falls back to whichever provider has a key stored. Someone who
   * pastes an OpenAI key and never opens this picker still gets a talking call,
   * which is the point — no vendor is built into the call, and the app must not
   * require a second gesture to notice the first one.
   */
  s2sProvider: string | null;
  /** The realtime model per speech-to-speech vendor, e.g. `{ google:
   *  'gemini-3.8-live-extended-thinking' }`. Empty means the one pinned in the
   *  build. Persisted: a model picked once is the model the next call uses. */
  s2sModel: Record<string, string>;
  setS2sModel: (provider: string, model: string) => void;
  /**
   * The language spoken on a call: `auto`, or a two-letter code. Auto is the
   * default and sends none, because a language sent to Whisper or Gemini is an
   * order, not a hint. A choice here is made on the call screen, where it is
   * seen on every call, not in a settings page where it is forgotten: short
   * English commands came back as Slovenian, Russian and Croatian on Auto
   * (23 Sep), and an English OS forced English on Romanian speech.
   */
  callLanguage: string;
  setCallLanguage: (lang: string) => void;
  setS2sProvider: (id: string | null) => void;
  /**
   * Chosen voice per engine id.
   *
   * Per engine, because a voice id is only meaningful to the vendor that issued
   * it — switching engines must not carry a dead id across. Pinning one also
   * fixes a real defect: a reply split into two synthesis requests with no
   * explicit voice came back in two different voices, since "the default" is
   * resolved per request on the vendor's side.
   */
  ttsVoice: Record<string, string>;
  setTtsVoice: (engineId: string, voiceId: string) => void;
}

const getSystemTheme = (): ResolvedTheme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const resolveTheme = (t: ThemePref): ResolvedTheme =>
  t === 'system' ? getSystemTheme() : t;

const applyTheme = (resolved: ResolvedTheme) =>
  document.documentElement.setAttribute('data-theme', resolved);

export const useUI = create<UIStore>()(
  persist(
    (set) => ({
      navCollapsed: false,
      toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
      theme: 'dark',
      resolvedTheme: 'dark',
      language: 'en',
      reasoningMode: 'auto',
      enabledTools: [],
      setTheme: (theme) => {
        const resolved = resolveTheme(theme);
        applyTheme(resolved);
        set({ theme, resolvedTheme: resolved });
      },
      searchOpen: false,
      searchScopeId: null,
      openSearch:  (projectId) => set({ searchOpen: true, searchScopeId: projectId ?? null }),
      closeSearch: () => set({ searchOpen: false, searchScopeId: null }),
      skillsOpen:  false,
      openSkills:  () => set({ skillsOpen: true }),
      closeSkills: () => set({ skillsOpen: false }),
      skillTip: false,
      setSkillTip: (skillTip) => set({ skillTip }),
      inputMode: 'chat',
      setInputMode: (inputMode) => set({ inputMode }),
      mascotEnabled: true,
      setMascotEnabled: (mascotEnabled) => set({ mascotEnabled }),
      // Empty, not 'small'. A default that names a specific model is a promise
      // about which engine is underneath, and the answer differs per build —
      // the picker resolves this against what the binary actually offers.
      sttModel: '',
      setSttModel: (sttModel) => set({ sttModel }),
      sttProvider: null,
      setSttProvider: (sttProvider) => set({ sttProvider }),
      ttsProvider: null,
      setTtsProvider: (ttsProvider) => set({ ttsProvider }),
      callEngine: 'livekit',
      setCallEngine: (callEngine) => set({ callEngine }),
      s2sProvider: null,
      setS2sProvider: (s2sProvider) => set({ s2sProvider }),
      s2sModel: {},
      callLanguage: 'auto',
      setCallLanguage: (callLanguage) => set({ callLanguage }),
      setS2sModel: (provider, model) =>
        set((st) => ({ s2sModel: { ...st.s2sModel, [provider]: model } })),
      ttsVoice: {},
      setTtsVoice: (engineId, voiceId) =>
        set((s) => ({ ttsVoice: { ...s.ttsVoice, [engineId]: voiceId } })),
    }),
    {
      name: 'cinderpaw-ui',
      partialize: (s) => ({
        navCollapsed: s.navCollapsed,
        theme: s.theme,
        // `reasoningMode` and `enabledTools` are deliberately NOT persisted any
        // more. The composer controls that set them are gone, so a saved value
        // would be a setting with no way back: someone who once picked
        // "Off: suppress thinking blocks", or ticked File Write, would carry
        // that choice forever with nothing on screen explaining it or offering
        // to undo it. Unpersisted, they start every launch at the defaults the
        // app is designed around — `auto`, and an empty tool list that agent
        // mode overrides with the agent's own tools.
        inputMode: s.inputMode,
        mascotEnabled: s.mascotEnabled,
        sttModel: s.sttModel,
        sttProvider: s.sttProvider,
        ttsProvider: s.ttsProvider,
        callEngine: s.callEngine,
        s2sProvider: s.s2sProvider,
        s2sModel: s.s2sModel,
        callLanguage: s.callLanguage,
        ttsVoice: s.ttsVoice,
      }),
      // Dropping the two keys from `partialize` only stops them being WRITTEN.
      // Every machine that already ran an older build still has them sitting in
      // `cinderpaw-ui`, and rehydration merges that blob over the defaults — so
      // without this the person the change was made for is the one person it
      // does not reach, and "Off" stays off forever. `merge` runs before the
      // store exists, which is the only point where the stale value can be
      // removed rather than reapplied.
      merge: (persisted, current) => {
        const { reasoningMode: _r, enabledTools: _t, ...rest } =
          (persisted ?? {}) as Partial<UIStore>;
        const merged = { ...current, ...rest };
        // The Romanian interface was removed; a machine that picked it still
        // has 'ro' saved, and the voice shortlist and dates read this field.
        merged.language = 'en';
        // A retired engine that is still stored is still selected. Same reason
        // as the two keys above: rehydration merges the saved blob over the
        // defaults, so the machine that has been using voice the longest is
        // exactly the one that would never move to the new engine.
        if (RETIRED_CALL_ENGINES.includes(merged.callEngine)) {
          merged.callEngine = 'livekit';
        }
        // STT + TTS is parked (`PIPELINE_PARKED` in livekit.rs). A stored pick of
        // it would still route the call button through its setup cards, so it is
        // cleared here and the picker falls back to speech to speech.
        if (merged.s2sProvider === 'pipeline') merged.s2sProvider = null;
        return merged;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const resolved = resolveTheme(state.theme);
        applyTheme(resolved);
        state.resolvedTheme = resolved;
        document.documentElement.lang = 'en';
      },
    },
  ),
);

export function useSystemThemeSync() {
  const theme = useUI((s) => s.theme);
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const resolved = getSystemTheme();
      applyTheme(resolved);
      useUI.setState({ resolvedTheme: resolved });
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);
}
