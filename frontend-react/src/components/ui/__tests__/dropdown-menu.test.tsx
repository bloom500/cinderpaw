import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, MenuInOverlay } from '../dropdown-menu';
import { Dialog, DialogContent, DialogTitle } from '../dialog';

function Menu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Options</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A modal menu blocks everything under it: Radix turns pointer events off on <body>. */
const blocksThePage = () => document.body.style.pointerEvents === 'none';

afterEach(cleanup);

describe('a menu on the page', () => {
  it('leaves the page under it clickable: one click closes it and does what it was on', async () => {
    const user = userEvent.setup();
    let newChats = 0;
    render(<><Menu /><button onClick={() => { newChats += 1; }}>New chat</button></>);
    await user.click(screen.getByText('Options'));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(blocksThePage()).toBe(false);
    await user.click(screen.getByText('New chat'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(newChats).toBe(1);
  });
});

describe('a menu inside an overlay that closes on an outside click', () => {
  it('in a dialog, blocks what is under it, so the first click only closes the menu', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Search</DialogTitle>
          <Menu />
        </DialogContent>
      </Dialog>,
    );
    // The dialog blocks the page by itself; what the menu adds when it is
    // modal is to shut out everything but itself, the dialog included.
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('[aria-hidden="true"]')).toBeNull();
    await user.click(screen.getByText('Options'));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(dialog.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('in the search overlay (its own provider), the same', async () => {
    const user = userEvent.setup();
    render(<MenuInOverlay.Provider value><Menu /></MenuInOverlay.Provider>);
    await user.click(screen.getByText('Options'));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(blocksThePage()).toBe(true);
  });
});
