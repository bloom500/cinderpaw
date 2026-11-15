import { beforeEach, describe, expect, it, vi } from 'vitest';

// The engine, faked: a `welcome` op answers with `welcome_ready` for that chat.
let engine: ((sessionId: string, apps: string) => void) | null = null;
const cronOp = vi.fn((_id: string, action: string, opts: { sessionId?: string; task?: string }) => {
  if (action === 'welcome' && engine) { queueMicrotask(() => engine!(opts.sessionId!, opts.task ?? '')); return Promise.resolve(); }
  return Promise.reject(new Error('cinderpaw-agent is not running'));
});
let apps: { name: string; path: string }[] | null = [];
vi.mock('@tauri-apps/api/core', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/api/core')>('@tauri-apps/api/core');
  return { ...actual, invoke: vi.fn((cmd: string) => (cmd === 'list_apps' && apps ? Promise.resolve(apps) : Promise.reject(new Error(cmd)))) };
});
vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, tauri: { ...actual.tauri, raw: { ...actual.tauri.raw, cinderpawCronOp: (...a: Parameters<typeof cronOp>) => cronOp(...a) } } };
});

import { maybeWelcome, receiveWelcome, welcomeText } from '../welcome';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useOnboarding } from '@/stores/onboarding';

function fresh(chats: number, appNames: string[] = []) {
  localStorage.clear();
  cronOp.mockClear();
  apps = appNames.map((name) => ({ name, path: `C:/${name}.lnk` }));
  engine = (sid, list) => receiveWelcome(sid, `Hi Ana! I'm Pixel. (written from ${list.split('\n').filter(Boolean).length} apps)`);
  useChat.getState().newSession();
  useConversations.setState({ loaded: true, list: Array.from({ length: chats }, (_, i) => ({ id: `c${i}` })) as never, saveCurrent: vi.fn(() => Promise.resolve()) });
  useOnboarding.setState({ agentName: 'Pixel', userName: 'Ana' });
}
const said = () => useChat.getState().messages.filter((m) => m.role === 'assistant').map((m) => m.content);
const welcomes = () => cronOp.mock.calls.filter((c) => c[1] === 'welcome');

describe('the first message after a model is connected', () => {
  beforeEach(() => fresh(0));

  it('a new install: the model is asked once, with the app names, and its words are shown', async () => {
    fresh(0, ['Visual Studio Code', 'Figma']);
    await Promise.all([maybeWelcome(true), maybeWelcome(true)]);
    expect(welcomes()).toHaveLength(1);
    expect(welcomes()[0]![2]).toEqual({ sessionId: useChat.getState().sessionId, task: 'Visual Studio Code\nFigma' });
    expect(said()).toEqual(["Hi Ana! I'm Pixel. (written from 2 apps)"]);
  });

  it('after Skip: nothing while there is no model, the welcome when one is added, even with chats', async () => {
    fresh(2);
    await maybeWelcome(false);
    expect(said()).toHaveLength(0);
    await maybeWelcome(true);
    expect(said()).toHaveLength(1);
  });

  it('someone who updated, with chats and a model already, is not greeted', async () => {
    fresh(3);
    await maybeWelcome(true);
    await maybeWelcome(false); // a model removed later does not re-open the welcome
    await maybeWelcome(true);
    expect(said()).toHaveLength(0);
    expect(welcomes()).toHaveLength(0);
  });

  it('never written into a chat that already has messages', async () => {
    useChat.getState().addMessage({ id: 'u', role: 'user', content: 'hey', createdAt: 1 });
    await maybeWelcome(true);
    expect(said()).toHaveLength(0);
  });

  it('they started typing while it was written: it is not dropped on top of their message', async () => {
    engine = (sid) => {
      useChat.getState().addMessage({ id: 'u', role: 'user', content: 'hey', createdAt: 1 });
      receiveWelcome(sid, 'Hi!');
    };
    await maybeWelcome(true);
    expect(said()).toHaveLength(0);
  });

  it('the engine cannot be reached and the apps cannot be read: the fixed welcome, by the agent\'s own name', async () => {
    apps = null;
    engine = null;
    await maybeWelcome(true);
    expect(said()).toEqual([welcomeText('Pixel', 'Ana')]);
    expect(said()[0]).toMatch(/^Hi Ana! I'm Pixel/);
    expect(said()[0]).not.toContain('Cubby');
  });

  it('no name given: plain hello, and Cinderpaw when the agent has no name', () => {
    expect(welcomeText('', '')).toMatch(/^Hi! I'm Cinderpaw/);
  });
});
