Exit code: 0
Wall time: 0.6 seconds
Output:
import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ReasoningMode = 'auto' | 'on' | 'off';
export type ToolId = 'web_search' | 'http_request' | 'file_read' | 'file_write' | 'code_execute';
export type LangPref = 'en' | 'ro';
export type InputMode = 'chat' | 'agent';
export type WhisperModel = 'small' | 'base';
/** Speech-to-text backend for voice messages. `null` = user hasn't chosen yet
 *  (first mic tap opens the provider card). `groq` = cloud whisper-large-v3. */
export type SttProvider = 'local' | 'groq';

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
  setLanguage: (l: LangPref) => void;
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
  inputMode: InputMode;
  setInputMode: (m: InputMode) => void;
  /** #24: pixel-art mascot on the typing bar. Some users want it off. */
  mascotEnabled: boolean;
  setMascotEnabled: (v: boolean) => void;
  /** Whisper STT model size for voice messages. */
  whisperModel: WhisperModel;
  setWhisperModel: (m: WhisperModel) => void;
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
   */
  callEngine: 'pipeline' | 'live';
  setCallEngine: (e: 'pipeline' | 'live') => void;
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
      setLanguage: (language) => {
        document.documentElement.lang = language;
        set({ language });
      },
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
      inputMode: 'chat',
      setInputMode: (inputMode) => set({ inputMode }),
      mascotEnabled: true,
      setMascotEnabled: (mascotEnabled) => set({ mascotEnabled }),
      whisperModel: 'small',
      setWhisperModel: (whisperModel) => set({ whisperModel }),
      sttProvider: null,
      setSttProvider: (sttProvider) => set({ sttProvider }),
      ttsProvider: null,
      setTtsProvider: (ttsProvider) => set({ ttsProvider }),
      callEngine: 'pipeline',
      setCallEngine: (callEngine) => set({ callEngine }),
      ttsVoice: {},
      setTtsVoice: (engineId, voiceId) =>
        set((s) => ({ ttsVoice: { ...s.ttsVoice, [engineId]: voiceId } })),
    }),
    {
      name: 'cinderpaw-ui',
      partialize: (s) => ({
        navCollapsed: s.navCollapsed,
        theme: s.theme,
        language: s.language,
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
        whisperModel: s.whisperModel,
        sttProvider: s.sttProvider,
        ttsProvider: s.ttsProvider,
        callEngine: s.callEngine,
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
        return { ...current, ...rest };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const resolved = resolveTheme(state.theme);
        applyTheme(resolved);
        state.resolvedTheme = resolved;
        document.documentElement.lang = state.language ?? 'en';
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

