import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ReasoningMode = 'auto' | 'on' | 'off';
export type ToolId = 'web_search' | 'http_request' | 'file_read' | 'file_write' | 'code_execute';
export type LangPref = 'en' | 'ro';

const REASONING_CYCLE: ReasoningMode[] = ['auto', 'on', 'off'];

interface UIStore {
  sidebarCollapsed: boolean;
  theme: ThemePref;
  resolvedTheme: ResolvedTheme;
  language: LangPref;
  reasoningMode: ReasoningMode;
  enabledTools: ToolId[];
  toggleSidebar: () => void;
  setTheme: (t: ThemePref) => void;
  setLanguage: (l: LangPref) => void;
  cycleReasoningMode: () => void;
  setReasoningMode: (m: ReasoningMode) => void;
  toggleTool: (id: ToolId) => void;
  searchOpen:  boolean;
  openSearch:  () => void;
  closeSearch: () => void;
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
      sidebarCollapsed: false,
      theme: 'dark',
      resolvedTheme: 'dark',
      language: 'en',
      reasoningMode: 'auto',
      enabledTools: [],
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setLanguage: (language) => {
        document.documentElement.lang = language;
        set({ language });
      },
      setTheme: (theme) => {
        const resolved = resolveTheme(theme);
        applyTheme(resolved);
        set({ theme, resolvedTheme: resolved });
      },
      cycleReasoningMode: () =>
        set((s) => {
          const idx = REASONING_CYCLE.indexOf(s.reasoningMode);
          return { reasoningMode: REASONING_CYCLE[(idx + 1) % REASONING_CYCLE.length] };
        }),
      setReasoningMode: (reasoningMode) => set({ reasoningMode }),
      toggleTool: (id) =>
        set((s) => ({
          enabledTools: s.enabledTools.includes(id)
            ? s.enabledTools.filter((t) => t !== id)
            : [...s.enabledTools, id],
        })),
      searchOpen: false,
      openSearch:  () => set({ searchOpen: true }),
      closeSearch: () => set({ searchOpen: false }),
    }),
    {
      name: 'feral-ui',
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
        language: s.language,
        reasoningMode: s.reasoningMode,
        enabledTools: s.enabledTools,
      }),
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
