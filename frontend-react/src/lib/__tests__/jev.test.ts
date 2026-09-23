import { describe, it, expect } from 'vitest';
import { textCandidates, domainGuess, toPlan, earlyFingerprint, inReadingOrder, repeatCount, runsLeft } from '../jev';

const choice = (choice: string, confidence = 0.9) => ({ type: 'choice', choice, confidence });

describe('jev brain', () => {
  it('cuts the payload out of a search sentence, and Jev picks it', () => {
    const c = textCandidates('search youtube for lofi hip hop');
    expect(Object.values(c)).toContain('lofi hip hop');
    const plan = toPlan('search youtube for lofi hip hop', {
      action: choice('web_search'), engine: choice('youtube'), text: choice(Object.keys(c).find((k) => c[k] === 'lofi hip hop')!),
    }, c);
    expect(plan).toMatchObject({ action: 'web_search', query: 'lofi hip hop' });
    expect((plan as { url: string }).url).toBe('https://www.youtube.com/results?search_query=lofi%20hip%20hop');
  });

  it('"play X on Spotify" searches the installed app and plays the first result', () => {
    const said = 'Now, can you play praying mantis on Spotify?';
    const c = textCandidates(said);
    const key = Object.keys(c).find((k) => c[k].toLowerCase() === 'praying mantis');
    expect(key).toBeDefined();
    const ans = { action: choice('web_search'), engine: choice('spotify'), text: choice(key!) };
    const inApp = toPlan(said, ans, c, undefined, [{ name: 'Spotify', path: 'C:/Spotify.lnk' }]);
    expect(inApp).toMatchObject({ action: 'web_search', url: 'spotify:search:praying+mantis', system: true, play: true });
    // No app installed: the web player, still played.
    expect(toPlan(said, ans, c)).toMatchObject({ url: 'https://open.spotify.com/search/praying%20mantis', play: true });
    // A search is not a play.
    expect(toPlan('search spotify for praying mantis', ans, c)).not.toHaveProperty('play');
  });

  it('editing, folders and screenshots are their own closed choices', () => {
    const c = textCandidates('paste');
    expect(toPlan('paste', { action: choice('edit'), edit_op: choice('paste') }, c)).toMatchObject({ action: 'edit', op: 'paste' });
    expect(toPlan('open downloads', { action: choice('open_folder'), folder: choice('downloads') }, c)).toMatchObject({ action: 'open_folder', folder: 'downloads' });
    expect(toPlan('open the attic', { action: choice('open_folder'), folder: choice('attic') }, c)).toMatchObject({ action: 'none' });
    expect(toPlan('take a screenshot', { action: choice('screenshot') }, c)).toMatchObject({ action: 'screenshot' });
  });

  it('a spoken domain opens as a site, a known name opens its address', () => {
    expect(domainGuess('go to hotnews dot ro')).toBe('hotnews.ro');
    const c = textCandidates('go to hotnews dot ro');
    expect(toPlan('go to hotnews dot ro', { action: choice('open_website'), site: choice('other') }, c)).toMatchObject({ action: 'open_website', url: 'https://hotnews.ro' });
    expect(toPlan('open reddit', { action: choice('open_website'), site: choice('reddit') }, c)).toMatchObject({ url: 'https://www.reddit.com' });
  });

  it('scroll direction and amount become one delta; confidence is the weakest link', () => {
    const c = textCandidates('scroll down a lot');
    expect(toPlan('scroll down a lot', { action: choice('scroll', 0.9), scroll_dir: choice('down', 0.5), scroll_amount: choice('a_lot') }, c))
      .toEqual({ action: 'scroll', dy: 2400, confidence: 0.5 });
    expect(toPlan('go to the top', { action: choice('scroll'), scroll_dir: choice('top'), scroll_amount: choice('page') }, c)).toMatchObject({ dy: -1e7 });
  });

  it('anything else is for the agent', () => {
    const c = textCandidates('what is the weather like');
    expect(toPlan('what is the weather like', { action: choice('none') }, c)).toEqual({ action: 'none', confidence: 0.9 });
    expect(toPlan('x', { action: choice('navigate'), nav: choice('teleport') }, c)).toMatchObject({ action: 'none' });
  });
});

import { splitSteps } from '../jev';
describe('splitSteps', () => {
  it('cuts a chain at its connectors, in order, in either language', () => {
    expect(splitSteps('open youtube and search for future konichiwa, then click the first result'))
      .toEqual(['open youtube', 'search for future konichiwa', 'click the first result']);
    expect(splitSteps('intra pe youtube si cauta Future Konichiwa dupa care da click pe prima piesa'))
      .toEqual(['intra pe youtube', 'cauta Future Konichiwa', 'da click pe prima piesa']);
  });
  it('a lone word after "and" stays with its step', () => {
    expect(splitSteps('search for rock and roll')).toEqual(['search for rock and roll']);
  });
  it('the Romanian "și" cuts too (no ASCII word boundary), and "și" inside a word does not', () => {
    expect(splitSteps('Deschide YouTube și caută o piesă la alegere')).toEqual(['Deschide YouTube', 'caută o piesă la alegere']);
    expect(splitSteps('caută mașina roșie')).toEqual(['caută mașina roșie']);
  });
});

describe('site keys', () => {
  it('the window title picks the map: a site over its browser, plain Windows keys elsewhere', async () => {
    const { keysFor } = await import('../siteKeys');
    const yt = keysFor('Reble - Praying Mantis - YouTube - Brave');
    expect(yt.site).toBe('youtube');
    expect(yt.commands.media_next.keys).toBe('{shift+n}');
    expect(yt.commands.new_tab.keys).toBe('{ctrl+t}');
    expect(keysFor('Untitled - Notepad').site).toBeNull();
    expect(keysFor('Untitled - Notepad').commands.save.keys).toBe('{ctrl+s}');
  });

  it('media takes the site key when there is one; a shortcut is the key Jev picked', async () => {
    const { keysFor } = await import('../siteKeys');
    const { commands } = keysFor('x - YouTube - Brave');
    const c = textCandidates('next video');
    expect(toPlan('next video', { action: choice('media'), media_op: choice('next') }, c, commands)).toMatchObject({ action: 'media', op: 'next', keys: '{shift+n}' });
    expect(toPlan('next video', { action: choice('media'), media_op: choice('next') }, c)).toMatchObject({ action: 'media', op: 'next', keys: undefined });
    expect(toPlan('captions on', { action: choice('shortcut'), shortcut: choice('captions') }, c, commands)).toMatchObject({ action: 'shortcut', keys: 'c' });
    expect(toPlan('like this', { action: choice('shortcut'), shortcut: choice('none') }, c, commands)).toMatchObject({ action: 'none' });
    // YouTube has no like key; "like" is a click on the like button (21 Sep).
    expect(commands.like).toBeUndefined();
  });
});

// The desktop side, with the host mocked: no Tauri in a test.
import { vi } from 'vitest';
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => { throw 'desktop control is disabled. Set CINDERPAW_ENABLE_DESKTOP_CONTROL=true to enable it.'; }) }));

describe('executeOnDesktop with desktop control off (the default)', () => {
  it('an open it cannot watch is reported as done, not as a failure', async () => {
    const { executeOnDesktop } = await import('../jev');
    const { open } = await import('@tauri-apps/plugin-shell');
    await expect(executeOnDesktop({ action: 'open_website', url: 'https://www.youtube.com', label: 'youtube', system: true, confidence: 1 }))
      .resolves.toBe('Opening youtube in your browser.');
    expect(open).toHaveBeenCalledWith('https://www.youtube.com');
    await expect(executeOnDesktop({ action: 'web_search', url: 'https://duckduckgo.com/?q=x', query: 'x', system: true, confidence: 1 }))
      .resolves.toBe('Searching for x in your browser.');
  });

  it('a refusal is a sentence for the person, never the host\'s env-var line', async () => {
    const { executeOnDesktop, DESKTOP_CONTROL_OFF } = await import('../jev');
    await expect(executeOnDesktop({ action: 'open_app', name: 'Spotify', path: 'C:/apps/Spotify.lnk', confidence: 1 })).rejects.toThrow(DESKTOP_CONTROL_OFF);
    await expect(executeOnDesktop({ action: 'scroll', dy: 700, confidence: 1 })).rejects.toThrow(DESKTOP_CONTROL_OFF);
  });
});

describe('a named item beats the count', () => {
  it('shares a real word, not an ordinal every row has', async () => {
    const { sharesName } = await import('../jev');
    expect(sharesName('primul mail, Hefe Junior', 'Jefe Junior, Invoice for September, 10:32')).toBe(true);
    expect(sharesName('the first video', 'Asmongold TV reacts to everything 12 minutes')).toBe(false);
    expect(sharesName('delete the first email', 'Newsletter: email tips for the week')).toBe(false);
  });
});

describe('media follows the playing window', () => {
  it('with a terminal in front, the YouTube window takes the pause', async () => {
    const { target } = await import('../jev');
    const c = textCandidates('pause');
    const windows = [{ pid: 7, title: 'Windows PowerShell', app_name: 'WindowsTerminal' }, { pid: 9, title: 'lofi - YouTube - Brave', app_name: 'brave' }];
    const plan = toPlan('pause', { action: choice('media'), media_op: choice('play_pause') }, c, undefined, [], windows);
    expect(plan).toMatchObject({ action: 'media', op: 'play_pause', keys: 'k' });
    expect(target.pid).toBe(9);
  });
  it('a click on a named item carries its verb', () => {
    const c = textCandidates('delete the first email');
    expect(toPlan('delete the first email', { action: choice('click'), text: choice('c0'), verb: choice('delete') }, c)).toMatchObject({ action: 'click', verb: 'delete' });
    expect(toPlan('press subscribe', { action: choice('click'), text: choice('c0'), verb: choice('none') }, c)).not.toHaveProperty('verb');
  });
});

describe('where a command runs', () => {
  it('a sentence that names no place keeps the last one (it used to reset to the app)', async () => {
    const { target, resetTarget } = await import('../jev');
    resetTarget();
    const c = textCandidates('open youtube in brave');
    toPlan('open youtube in brave', { action: choice('open_website'), site: choice('youtube'), where: choice('system') }, c);
    expect(target.system).toBe(true);
    toPlan('click the first video', { action: choice('click'), text: choice('c0'), where: choice('unnamed') }, c);
    expect(target.system).toBe(true);
    // A place Jev is unsure of changes nothing either.
    toPlan('whatever', { action: choice('click'), text: choice('c0'), where: choice('here', 0.2) }, c);
    expect(target.system).toBe(true);
    toPlan('open it in cinderpaw', { action: choice('open_website'), site: choice('youtube'), where: choice('here') }, c);
    expect(target.system).toBe(false);
  });

  it('a window is only taken as named when Jev is sure of it', async () => {
    const { target } = await import('../jev');
    const c = textCandidates('pause in spotify');
    const windows = [{ pid: 5, title: 'Spotify Premium', app_name: 'Spotify' }];
    toPlan('pause', { action: choice('media'), media_op: choice('play_pause'), window: choice('w0', 0.3) }, c, undefined, [], windows);
    // Unsure: not "named"; the playing window rule may still route it, but through the site map.
    const named = toPlan('pause in spotify', { action: choice('media'), media_op: choice('play_pause'), window: choice('w0', 0.9) }, c, undefined, [], windows);
    expect(named).toMatchObject({ action: 'media', keys: ' ' });
    expect(target.pid).toBe(5);
  });
});

describe('an answer to Cinder, read by Jev', () => {
  const q = { question: 'Allow the agent to click "Send"?', header: 'Desktop', options: [{ label: 'Allow', recommended: true }, { label: 'Deny' }], multiSelect: false };

  it('"da" picks Allow; a video talking is not an answer', async () => {
    const { interpretReply } = await import('../jev');
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementationOnce(async () => ({ answers: { reply: { type: 'noul', noul: 0.93 }, option: { type: 'choice', choice: 'o0', confidence: 0.91 } }, usage: null, ms: 300 }));
    await expect(interpretReply(q, 'da')).resolves.toEqual({ reply: true, selected: ['Allow'] });
    vi.mocked(invoke).mockImplementationOnce(async () => ({ answers: { reply: { type: 'noul', noul: 0.08 }, option: { type: 'choice', choice: 'none', confidence: 0.6 } }, usage: null, ms: 300 }));
    await expect(interpretReply(q, "don't forget to subscribe")).resolves.toEqual({ reply: false, selected: [] });
  });

  it('an unsure option is the words, not a guess', async () => {
    const { interpretReply } = await import('../jev');
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementationOnce(async () => ({ answers: { reply: { type: 'noul', noul: 0.9 }, option: { type: 'choice', choice: 'o1', confidence: 0.2 } }, usage: null, ms: 300 }));
    await expect(interpretReply(q, 'only if it is the draft')).resolves.toEqual({ reply: true, selected: [] });
  });
});

describe('an open window of the app asked for', () => {
  it('matches the short process name to the long app name, and nothing looser', async () => {
    const { windowOfApp } = await import('../jev');
    const w = (app_name: string) => ({ pid: 1, title: 'x', app_name });
    expect(windowOfApp('Brave', w('brave.exe'))).toBe(true);
    expect(windowOfApp('Visual Studio Code', w('Code.exe'))).toBe(true);
    expect(windowOfApp('WhatsApp', w('WhatsApp.Root.exe'))).toBe(true);
    expect(windowOfApp('Spotify', w('Spotify.exe'))).toBe(true);
    expect(windowOfApp('Calculator', w('ApplicationFrameHost.exe'))).toBe(false);
    expect(windowOfApp('Brave', w('ai.exe'))).toBe(false);
  });
});

describe('type', () => {
  it('types the payload Jev cut out, never at a partial', () => {
    const c = textCandidates('type hello there');
    const key = Object.keys(c).find((k) => c[k] === 'hello there')!;
    const plan = toPlan('type hello there', { action: choice('type'), text: choice(key) }, c);
    expect(plan).toMatchObject({ action: 'type', text: 'hello there' });
    expect(earlyFingerprint(plan)).toBeNull();
  });
});

describe('earlyFingerprint', () => {
  it('names the closed-payload actions once, case-blind, and nothing that carries free text or acts on the page', () => {
    expect(earlyFingerprint({ action: 'open_app', name: 'Spotify', path: 'x', confidence: 0.9 })).toBe('open_app:spotify');
    expect(earlyFingerprint({ action: 'open_app', name: 'spotify', path: 'y', confidence: 0.5 })).toBe('open_app:spotify');
    expect(earlyFingerprint({ action: 'open_website', url: 'https://youtube.com', label: 'YouTube', system: false, confidence: 0.9 })).toBe('open_website:https://youtube.com');
    expect(earlyFingerprint({ action: 'scroll', dy: 600, confidence: 0.9 })).toBe('scroll:600');
    expect(earlyFingerprint({ action: 'navigate', op: 'back', confidence: 0.9 })).toBe('navigate:back');
    expect(earlyFingerprint({ action: 'navigate', op: 'close_tab', confidence: 0.9 })).toBeNull();
    for (const plan of [
      { action: 'web_search', url: 'u', query: 'lofi hip', system: false, confidence: 0.9 },
      { action: 'find', query: 'refund', confidence: 0.9 },
      { action: 'click', target: 'first video', confidence: 0.9 },
      { action: 'media', op: 'play_pause', confidence: 0.9 },
      { action: 'shortcut', keys: 'k', means: 'pause', confidence: 0.9 },
      { action: 'stop', confidence: 0.9 },
      { action: 'none', confidence: 0.9 },
    ] as const) expect(earlyFingerprint(plan)).toBeNull();
  });
});

describe('window_ctl', () => {
  const windows = [{ pid: 5, title: 'Spotify Premium', app_name: 'Spotify' }];

  it('closes the named app, and the name does not drag the confidence down', () => {
    const c = textCandidates('close spotify');
    expect(toPlan('close spotify',
      { action: choice('window_ctl'), window_op: choice('close'), window: choice('w0', 0.9) }, c, undefined, [], windows))
      .toEqual({ action: 'window_ctl', op: 'close', app: 'Spotify', confidence: 0.9 });
  });

  it('an unsure name falls back to the front window; a wrong op is for the agent', () => {
    const c = textCandidates('minimize this');
    expect(toPlan('minimize this',
      { action: choice('window_ctl'), window_op: choice('minimize'), window: choice('w0', 0.1) }, c, undefined, [], windows))
      .toEqual({ action: 'window_ctl', op: 'minimize', app: null, confidence: 0.9 });
    expect(toPlan('close spotify',
      { action: choice('window_ctl'), window_op: choice('explode'), window: choice('w0', 0.9) }, c, undefined, [], windows))
      .toMatchObject({ action: 'none' });
  });

  it('never runs on a partial: no fingerprint', () => {
    expect(earlyFingerprint({ action: 'window_ctl', op: 'close', app: 'Spotify', confidence: 0.9 })).toBeNull();
  });
});

describe('inReadingOrder', () => {
  const at = (x: number, y: number, name: string) =>
    ({ id: name, role: 'Link', name, is_offscreen: false, is_enabled: true, bounding_rect: { x, y, width: 10, height: 10 } });

  it('orders by what is highest on screen, and left to right within a row', () => {
    // Deliberately handed in the order a markup tree might produce.
    const order = inReadingOrder([at(500, 300, 'third'), at(40, 100, 'first'), at(300, 108, 'second')])
      .map((e) => e.name);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('leaves the list alone when the host sent no rectangles', () => {
    const noRects = [{ id: 'a', role: 'Link', name: 'a', is_offscreen: false, is_enabled: true },
                     { id: 'b', role: 'Link', name: 'b', is_offscreen: false, is_enabled: true }];
    expect(inReadingOrder(noRects).map((e) => e.name)).toEqual(['a', 'b']);
  });
});

describe('repeatCount', () => {
  it('reads a count that qualifies the repetition itself', () => {
    expect(repeatCount('close the last two tabs')).toBe(2);
    expect(repeatCount('scroll down three times')).toBe(3);
    expect(repeatCount('go back twice')).toBe(2);
    expect(repeatCount('mergi înapoi de două ori')).toBe(2);
    expect(repeatCount('închide 3 taburi')).toBe(3);
  });

  it('ignores a number that is only part of what is said', () => {
    expect(repeatCount('search for three little pigs')).toBe(1);
    expect(repeatCount('click the first video')).toBe(1);
    expect(repeatCount('open two thousand and one')).toBe(1);
  });

  it('caps a count that is far likelier a mishearing than a wish', () => {
    expect(repeatCount('close 40 tabs')).toBe(5);
  });
});

describe('runsLeft', () => {
  it('runs what is left of the count after a partial already did some', () => {
    const done = new Map([['navigate:close_tab', 1]]);
    expect(runsLeft('close the last two tabs', 'navigate:close_tab', done)).toBe(1);
    expect(runsLeft('close the last two tabs', 'navigate:close_tab', new Map())).toBe(2);
  });

  it('never repeats a single step a partial already ran', () => {
    const done = new Map([['open_app:spotify', 1]]);
    expect(runsLeft('open spotify', 'open_app:spotify', done)).toBe(0);
  });

  it('a count on one step does not free another step of the same sentence', () => {
    // "close this tab, then scroll down twice": the close ran early, and the
    // "twice" belongs to the scroll, so the close must not run again.
    const done = new Map([['navigate:close_tab', 1]]);
    expect(runsLeft('close this tab', 'navigate:close_tab', done)).toBe(0);
    expect(runsLeft('scroll down twice', 'scroll:600', done)).toBe(2);
  });

  it('steps that never run early run once', () => {
    expect(runsLeft('search for jazz twice', null, new Map())).toBe(1);
  });
});
