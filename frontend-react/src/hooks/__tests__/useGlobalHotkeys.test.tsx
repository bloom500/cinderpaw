import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useGlobalHotkeys } from '../useGlobalHotkeys';
import { useConversations } from '@/stores/conversations';
import { useArtifacts } from '@/stores/artifacts';
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
});
