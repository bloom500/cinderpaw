import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), upload: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauri: { google: { status: mocks.status, connect: mocks.connect, disconnect: mocks.disconnect, upload: mocks.upload } } }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mocks.open }));
import { useArtifacts } from '../artifacts';

/**
 * The Google buttons, 12 Oct 2026: a saved login Google had stopped accepting
 * still counted as "connected", so the button never offered sign-in again and
 * every click ended on "connect again" with nothing to click. google.rs now
 * forgets a dead login; the button then signs in once more and carries on.
 */
const doc = { title: 'Report', kind: 'markdown', content: '# Hi' };
const LINK = 'https://docs.google.com/document/d/abc/edit';

beforeEach(() => {
  // reset, not clear: a queued mockResolvedValueOnce must not leak into the next test.
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined);
  useArtifacts.setState({ google: null });
});

describe('Send to Google', () => {
  it('opens the file in the person’s own browser when it lands', async () => {
    mocks.status.mockResolvedValue(true);
    mocks.upload.mockResolvedValue(LINK);
    await useArtifacts.getState().sendToGoogle(doc, 'docs');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(LINK);
    expect(useArtifacts.getState().google).toEqual({ link: LINK, dest: 'docs' });
  });

  it('signs in first when nothing is saved', async () => {
    mocks.status.mockResolvedValue(false);
    mocks.upload.mockResolvedValue(LINK);
    await useArtifacts.getState().sendToGoogle(doc, 'docs');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith(LINK);
  });

  it('signs in again when Google stopped accepting the saved login', async () => {
    // Saved login present, Google refuses it, google.rs forgets it.
    mocks.status.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.upload.mockRejectedValueOnce('Your Google sign-in expired. Sign in again.').mockResolvedValueOnce(LINK);
    await useArtifacts.getState().sendToGoogle(doc, 'docs');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenCalledWith(LINK);
    expect(useArtifacts.getState().google).toEqual({ link: LINK, dest: 'docs' });
  });

  it('shows the reason, without a sign-in loop, when signing in would not help', async () => {
    mocks.status.mockResolvedValue(true);
    mocks.upload.mockRejectedValue('Google refused the upload: quota exceeded');
    await useArtifacts.getState().sendToGoogle(doc, 'docs');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useArtifacts.getState().google?.error).toContain('quota exceeded');
  });

  it('does not sign in twice in one click', async () => {
    mocks.status.mockResolvedValue(false);
    mocks.upload.mockRejectedValue('Your Google sign-in expired. Sign in again.');
    await useArtifacts.getState().sendToGoogle(doc, 'docs');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(useArtifacts.getState().google?.error).toContain('Sign in again');
  });

  it('Cancel frees the buttons at once, and the abandoned sign-in is never shown', async () => {
    mocks.status.mockResolvedValue(false);
    let finish!: () => void;
    mocks.connect.mockReturnValue(new Promise<void>((r) => { finish = r; }));
    const sending = useArtifacts.getState().sendToGoogle(doc, 'docs');
    await vi.waitFor(() => expect(useArtifacts.getState().google?.signingIn).toBe(true));
    useArtifacts.getState().cancelGoogle();
    expect(useArtifacts.getState().google).toBeNull();
    finish(); // the person finishes in the old tab minutes later
    await sending;
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(useArtifacts.getState().google).toBeNull();
  });

  it('a browser that will not open is not reported as a failed send', async () => {
    mocks.status.mockResolvedValue(true);
    mocks.upload.mockResolvedValue(LINK);
    mocks.open.mockRejectedValue(new Error('no default browser'));
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    await useArtifacts.getState().sendToGoogle(doc, 'docs');
    expect(opened).toHaveBeenCalledWith(LINK, '_blank', 'noopener,noreferrer');
    expect(useArtifacts.getState().google).toEqual({ link: LINK, dest: 'docs' });
  });

  it('Sign out forgets the login and says what happens next', async () => {
    mocks.disconnect.mockResolvedValue(undefined);
    await useArtifacts.getState().signOutGoogle();
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(useArtifacts.getState().google?.note).toContain('which account');
  });
});
