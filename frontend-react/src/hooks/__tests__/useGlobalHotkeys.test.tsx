import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useGlobalHotkeys } from '../useGlobalHotkeys';
import { useConversations } from '@/stores/conversations';
import { useArtifacts } from '@/stores/artifacts';
import { useBrowser } from '@/stores/browser';
import { waitFor } from '@testing-library/react';

function Harness() {
  useGlobalHotkeys();
  return <textarea aria-label="composer" />;
}

describe('useGlobalHotkeys', () => {
  // The composer has the focus nearly all the time; a new-chat shortcut that
  // only works outside it does not work.
  it('starts a new chat on Ctrl+N even while typing in the composer', () => {
    const newChat = vi.spyOn(useConversations.getState(), 'newChat').mockImplementation(() => {});
    const { getByLabelText } = render(<MemoryRouter><Harness /></MemoryRouter>);
    const box = getByLabelText('composer');
    box.focus();
    fireEvent.keyDown(box, { key: 'n', ctrlKey: true });
    expect(newChat).toHaveBeenCalledTimes(1);
    newChat.mockRestore();
  });

  it('closes the side panel on Esc, but not while a dialog owns the key', async () => {
    const { getByLabelText } = render(<MemoryRouter><Harness /></MemoryRouter>);
    const box = getByLabelText('composer');

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    useArtifacts.setState({ panelOpen: true });
    fireEvent.keyDown(box, { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 20));
    expect(useArtifacts.getState().panelOpen).toBe(true);

    dialog.remove();
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(useArtifacts.getState().panelOpen).toBe(false));
  });

  // The palette's commands answer the keys the palette shows (lib/commands.ts).
  function Where() {
    const { pathname, search, state } = useLocation();
    return <output data-testid="where">{pathname + search + ((state as { compose?: string } | null)?.compose ?? '')}</output>;
  }
  function Editor() {
    useGlobalHotkeys();
    return <><div aria-label="doc" contentEditable suppressContentEditableWarning /><textarea aria-label="composer" /><Where /></>;
  }

  it('answers the palette keys: Ctrl+Shift+A, Ctrl+B, Ctrl+M', () => {
    const setPanel = vi.spyOn(useBrowser.getState(), 'setPanel').mockImplementation(() => {});
    const { getByLabelText, getByTestId } = render(<MemoryRouter initialEntries={['/settings']}><Editor /></MemoryRouter>);
    const box = getByLabelText('composer');

    fireEvent.keyDown(box, { key: 'A', ctrlKey: true, shiftKey: true });
    expect(getByTestId('where').textContent).toBe('/chatCreate ');

    fireEvent.keyDown(box, { key: 'm', ctrlKey: true });
    expect(getByTestId('where').textContent).toBe('/models');
    // ⌘M is the Mac's minimise; it is left to the system.
    fireEvent.keyDown(box, { key: 'm', metaKey: true });
    expect(getByTestId('where').textContent).toBe('/models');

    fireEvent.keyDown(box, { key: 'b', ctrlKey: true });
    expect(setPanel).toHaveBeenCalledWith(true);
    expect(getByTestId('where').textContent).toBe('/chat');
    setPanel.mockRestore();
  });

  it('leaves Ctrl+B to a document being edited, where it means bold', () => {
    const setPanel = vi.spyOn(useBrowser.getState(), 'setPanel').mockImplementation(() => {});
    const { getByLabelText } = render(<MemoryRouter><Editor /></MemoryRouter>);
    fireEvent.keyDown(getByLabelText('doc'), { key: 'b', ctrlKey: true });
    expect(setPanel).not.toHaveBeenCalled();
    setPanel.mockRestore();
  });
});
