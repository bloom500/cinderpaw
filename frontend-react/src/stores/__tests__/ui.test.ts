import { describe, it, expect, beforeEach } from 'vitest';
import { useUI } from '@/stores/ui';

const reset = () =>
  useUI.setState({
    sidebarCollapsed: false,
    theme: 'system',
    resolvedTheme: 'dark',
    reasoningMode: 'auto',
    enabledTools: [],
  });

describe('useUI reasoning', () => {
  beforeEach(reset);

  it('default reasoningMode is auto', () => {
    expect(useUI.getState().reasoningMode).toBe('auto');
  });

  it('cycleReasoningMode: auto → on → off → auto', () => {
    const s = useUI.getState();
    s.cycleReasoningMode();
    expect(useUI.getState().reasoningMode).toBe('on');
    s.cycleReasoningMode();
    expect(useUI.getState().reasoningMode).toBe('off');
    s.cycleReasoningMode();
    expect(useUI.getState().reasoningMode).toBe('auto');
  });
});

describe('useUI tools', () => {
  beforeEach(reset);

  it('default enabledTools is empty', () => {
    expect(useUI.getState().enabledTools).toEqual([]);
  });

  it('toggleTool adds a tool', () => {
    useUI.getState().toggleTool('web_search');
    expect(useUI.getState().enabledTools).toContain('web_search');
  });

  it('toggleTool removes an already-active tool', () => {
    useUI.getState().toggleTool('web_search');
    useUI.getState().toggleTool('web_search');
    expect(useUI.getState().enabledTools).not.toContain('web_search');
  });

  it('toggleTool keeps other tools intact', () => {
    useUI.getState().toggleTool('web_search');
    useUI.getState().toggleTool('file_read');
    useUI.getState().toggleTool('web_search');
    expect(useUI.getState().enabledTools).toEqual(['file_read']);
  });
});
