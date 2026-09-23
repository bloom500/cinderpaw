import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useGlobalHotkeys } from '../useGlobalHotkeys';
import { useConversations } from '@/stores/conversations';

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
});
