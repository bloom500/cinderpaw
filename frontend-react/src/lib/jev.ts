import { tauri } from '@/lib/tauri';
import { SEARCH_ENGINES, useBrowser } from '@/stores/browser';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { parked } from '@/lib/callPill';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { keysFor, type KeyCommand } from '@/lib/siteKeys';
import type { AskUserQuestion } from '@/stores/askUser';

/**
 * The Jev call's brain: a spoken sentence becomes ONE action from a closed
 * set, or is handed to the agent.
 *
 * Jev (TypeSafe's System One model) never writes text. Code cuts the
 * candidates out of the transcript, asks typed questions with closed
 * criteria, and Jev picks; code then executes what it picked. The pattern
 * and the question wording follow kevinbadi/jev-voice (MIT), the action set
 * is ours: the built-in browser's operations, which the agent already uses.
 * Anything that is not one of them goes to the agent as a normal message,
 * which is how "open Slack" or "what is the weather" still get an answer.
 */

/**
 * What a Jev call can do by itself. Keys are what Jev answers with.
 *
 * Each option is `what` / `not_for` / `examples`, the shape TypeSafe's docs
 * give for options that get confused with each other (click vs shortcut vs
 * media vs navigate all "do something to the page"). Jev reads criteria
 * literally, so the exclusions are spelled out rather than implied.
 */
export const ACTIONS: Record<string, { what: string; not_for?: string; examples: string[] }> = {
  open_app: {
    what: 'Launch, open, switch to, or bring up an application installed on the computer, including "the browser" (whichever browser they have)',
    not_for: 'A website or web page: that is open_website',
    examples: ['open Spotify', 'launch Discord', 'switch to VS Code', 'open the settings app', 'open the browser', 'can you open Brave'],
  },
  open_website: {
    what: 'Go to a website or web page by name or domain, with no search query',
    not_for: 'An installed application (open_app), or a search for something (web_search)',
    examples: ['go to youtube', 'open reddit', 'pull up gmail', 'go to hotnews dot ro', 'can you open X', 'open twitter'],
  },
  web_search: {
    what: 'Search for something on the web or on a specific site',
    not_for: 'Finding a word on the page that is already open (find)',
    examples: ['search for lofi hip hop', 'look up the weather in Cluj', 'search youtube for jazz', 'google best ramen near me'],
  },
  scroll: {
    what: 'Scroll the current page up or down, to the top or to the bottom',
    examples: ['scroll down', 'scroll up a bit', 'go to the top', 'scroll way down'],
  },
  find: {
    what: 'Find a word or phrase on the page that is already open',
    not_for: 'Searching the web (web_search)',
    examples: ['find pricing on this page', 'search this page for refund'],
  },
  click: {
    what: 'Press something the current page shows: a button, a link, a result, a video, a tab, a card, an email in a list; or do one thing to one such item (open, delete, archive, like, reply)',
    not_for: 'Playback (pause, next, volume: media), moving in the browser (back, reload, tabs: navigate), a keyboard shortcut the app has (shortcut)',
    examples: ['click the first video', 'press subscribe', 'like this video', 'accept the cookies', 'open the third result', 'go to the promotions tab', 'click sign in', 'delete the first email', 'archive the message from Ana', 'open the mail from Jefe'],
  },
  navigate: {
    what: 'Move within the browser: back, forward, reload, a new tab, close this tab, home',
    not_for: 'Pressing something on the page (click)',
    examples: ['go back', 'reload the page', 'open a new tab', 'close this tab'],
  },
  reader: {
    what: 'Switch the page to or from reader view, the clean article view without ads and menus',
    examples: ['reader view', 'show me the clean version of this article'],
  },
  media: {
    what: 'Control whatever is playing: pause, play, resume, next or previous track or video, volume, mute',
    not_for: 'Anything that is not playback',
    examples: ['pause', 'play the video', 'next video', 'skip this song', 'previous track', 'volume up', 'mute'],
  },
  shortcut: {
    what: 'A keyboard shortcut the app or site in front has, listed under `shortcuts`, when none of the other actions covers it',
    not_for: 'Playback (media), pressing or acting on something the page shows, like a button, a video or an email (click), moving in the browser (navigate)',
    examples: ['turn on captions', 'full screen', 'play faster', 'compose a new email', 'rename the file', 'new folder', 'save', 'zoom in'],
  },
  type: {
    what: 'Type words into whatever has the keyboard focus right now: a note, a document, a chat box, a form field',
    not_for: 'Searching the web (web_search), finding a word on the page (find), a keyboard shortcut (shortcut)',
    examples: ['type hello', 'write "see you tomorrow"', 'type my name is Ana', 'scrie salut'],
  },
  window_ctl: {
    what: 'Do something to the WINDOW of an application: close the app, minimise it, hide it, maximise it, make it full screen',
    not_for: 'Closing a tab or a page inside the browser (navigate), or opening an app (open_app)',
    examples: ['close Spotify', 'close this app', 'minimise WhatsApp', 'hide this window', 'maximise it', 'inchide Spotify', 'minimizeaza fereastra'],
  },
  stop: {
    what: 'Tell the assistant to stop listening, hang up, or end the call',
    examples: ['stop', 'that is all', 'hang up', 'end the call'],
  },
  none: {
    what: 'Not one of the commands above: a question, a conversation, a task of several steps, a request for something the list does not have (a file, a summary, a message to someone, words the assistant would have to compose itself)',
    examples: ['what is the weather', 'can you still hear me', 'summarise this page', 'write a reply saying yes', 'find me a cheaper flight', 'fill in my address'],
  },
};

/** Sites by name: what people say, and where it goes. */
export const SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  twitter: 'https://x.com',
  x: 'https://x.com',
  facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com',
  linkedin: 'https://www.linkedin.com',
  amazon: 'https://www.amazon.com',
  netflix: 'https://www.netflix.com',
  spotify: 'https://open.spotify.com',
  chatgpt: 'https://chatgpt.com',
  openrouter: 'https://openrouter.ai',
  duckduckgo: 'https://duckduckgo.com',
  cinderpaw: 'https://cinderpaw.ai',
};

/** Where a search can run. `default` is the browser's own engine setting. */
export const SEARCH_ON: Record<string, (q: string) => string> = {
  default: (q) => `${SEARCH_ENGINES.duckduckgo.url}${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  reddit: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
};

const NAV = {
  back: 'go back to the previous page',
  forward: 'go forward',
  reload: 'reload / refresh the page',
  new_tab: 'open a new tab',
  close_tab: 'close this tab',
  home: 'go to the start page / home',
};

/** The sticky place for this call: the computer's own apps, or Cinderpaw. Reset by resetTarget() on hang-up. */
export const target: { system: boolean; pid: number | null } = { system: false, pid: null };
/** What the call did last, for a one-word follow-up ("next", "back", "again"). */
export const recent = { action: 'nothing yet' };
/** What ran before `recent`: "open Notepad and type hello" types into a window that is still opening. */
let previous = 'nothing yet';
export function resetTarget() { target.system = false; target.pid = null; recent.action = 'nothing yet'; }

/**
 * Below this, Jev is not trusted with an action: the sentence goes to the agent
 * (or, for a click, nothing is pressed). 0.35 let a garbled transcript open a
 * search with 0.44 (21 Sep); an action with an effect needs more than a coin.
 */
export const MIN_CONFIDENCE = 0.4;
/**
 * On a sentence still being said, more: "Open." alone, cut at the first
 * pause, launched an app at 0.57 (22 Sep). A full "open Spotify" comes back
 * at 0.99; the end of the sentence still runs whatever this refuses.
 */
export const MIN_EARLY_CONFIDENCE = 0.75;
/** A wrong click is worse than no click: the ELEMENT choice needs this much. */
export const MIN_CLICK_CONFIDENCE = 0.7;
/**
 * The click ACTION itself needs only jev-voice's floor (0.35): "click the first
 * video" came back as click at 0.39-0.57 three times and was refused each time
 * (21 Sep). Choosing click is harmless on its own; the element gate above is
 * what stops a wrong press.
 */
export const MIN_CLICK_ACTION_CONFIDENCE = 0.2;
/** Keys sent to a named window instead of the one in front need a sure name. */
const MIN_WINDOW_CONFIDENCE = 0.6;

function clean(s: string): string {
  return s.replace(/^[\s,.!?]+|[\s,.!?]+$/g, '').trim();
}

/**
 * Candidate payloads for Jev to pick from: the text in quotes, if any, then
 * every suffix of the sentence (each cut from a word to the end). No command
 * words are guessed here, in any language: "search youtube for lofi hip hop"
 * offers "youtube for lofi hip hop", "for lofi hip hop", "lofi hip hop", ...
 * and Jev picks the one that is exactly the payload. Capped at 12 so a long
 * sentence does not become a long menu; the full sentence is always first.
 */
export function textCandidates(utterance: string): Record<string, string> {
  const out: string[] = [];
  const add = (t: string) => { const c = clean(t); if (c && !out.includes(c)) out.push(c); };
  add(utterance);
  const m = utterance.match(/["“](.+?)["”]/);
  if (m) add(m[1]);
  const words = clean(utterance).split(/\s+/);
  for (let i = 1; i < words.length && out.length < 12; i++) add(words.slice(i).join(' '));
  if (out.length === 0) out.push('(nothing)');
  return Object.fromEntries(out.map((c, i) => [`c${i}`, c]));
}

/** A bare domain spoken in the sentence ("go to hotnews dot ro"), or null. */
export function domainGuess(utterance: string): string | null {
  const spoken = utterance.replace(/\s+dot\s+/gi, '.').replace(/\s+punct\s+/gi, '.');
  const m = spoken.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  return m ? m[1].toLowerCase() : null;
}

export interface InstalledApp { name: string; path: string }
export interface OpenWindow { pid: number; title: string; app_name: string }

export function questions(cands: Record<string, string>, shortcuts?: Record<string, KeyCommand>, apps: InstalledApp[] = [], windows: OpenWindow[] = []): Record<string, unknown> {
  const withNull = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));
  // `shortcut` is offered only with a window in front that has keys: inside
  // Cinderpaw's own browser there is nothing to send them to. `open_app` only
  // with a list of apps to pick from.
  const { shortcut: _unused, open_app: _unused2, ...base } = ACTIONS;
  const actions = { ...base, ...(shortcuts ? { shortcut: ACTIONS.shortcut } : {}), ...(apps.length ? { open_app: ACTIONS.open_app } : {}) };
  return {
    ...(apps.length ? {
      app: {
        type: 'choice',
        instructions: 'Assume the user wants to open or switch to an application. Which installed application do they mean? Match on meaning: "code" means Visual Studio Code, "browser" the browser they have. Choose `none` if no listed application matches.',
        criteria: { ...withNull(apps.map((a) => a.name)), none: 'No listed application matches what the user said' },
      },
    } : {}),
    ...(windows.length ? {
      window: {
        type: 'choice',
        instructions: 'Which open window should this command act on? `windows` lists them by title. Choose the one the user names ("in Spotify", "the YouTube tab", "in Brave"); choose `front` when they name none: the window in front is the default.',
        criteria: { ...Object.fromEntries(windows.map((w, i) => [`w${i}`, `${w.title} (${w.app_name})`])), front: 'The window in front, none named' },
      },
    } : {}),
    action: {
      type: 'choice',
      instructions: 'The user is speaking to a voice assistant that controls a web browser and the computer. `utterance` is the transcript, `page` the address on screen, `front` the title of the window in front, `recent` what the assistant did last. A short word (next, back, again, stop) continues `recent`: after playback control, "next" is the next track. Which single kind of action are they asking for right now?',
      criteria: actions,
    },
    ...(shortcuts ? {
      shortcut: {
        type: 'choice',
        instructions: 'Assume the user wants a keyboard shortcut of the app or site in front pressed. `front` is that window. Which one do they mean? Choose `none` if nothing listed matches.',
        criteria: { ...Object.fromEntries(Object.entries(shortcuts).map(([k, v]) => [k, v.means])), none: 'Nothing listed matches what the user asked' },
      },
    } : {}),
    site: {
      type: 'choice',
      instructions: 'Assume the user wants to open a website. Which site do they mean? Choose `other` if it is not one of the listed sites.',
      // One letter is a weak name: said out loud, "X" was `none` at 0.50 (22 Sep).
      criteria: { ...withNull(Object.keys(SITES)), x: 'X, formerly Twitter (x.com)', other: 'A site not in this list' },
    },
    engine: {
      type: 'choice',
      instructions: 'Assume the user wants to search for something. On which site should the search run? The site they name. When they name none and `front` or `page` shows one of these sites, that site: "search for jazz" said on YouTube searches YouTube. Otherwise default.',
      criteria: { ...withNull(Object.keys(SEARCH_ON).filter((k) => k !== 'default')), default: 'No site named: the browser\'s own search engine' },
    },
    text: {
      type: 'choice',
      instructions: 'Assume the user wants some text searched, found or typed. `candidates` holds possible payloads cut from the utterance. Which candidate is exactly the payload, with no command words (like "search for", "find", "type", "on youtube")?',
      criteria: cands,
    },
    scroll_dir: {
      type: 'choice',
      instructions: 'Assume the user wants to scroll. In which direction?',
      criteria: { down: 'scroll down / further', up: 'scroll up / back up', top: 'jump to the very top', bottom: 'jump to the very bottom' },
    },
    scroll_amount: {
      type: 'choice',
      instructions: 'Assume the user wants to scroll up or down. How far?',
      criteria: { little: 'a little / a bit', page: 'a normal amount, about one screen; the default when unspecified', a_lot: 'a lot / way down / far' },
    },
    window_op: {
      type: 'choice',
      instructions: 'Assume the user wants something done to an application WINDOW. Which one?',
      criteria: {
        close: 'Close the application or its window',
        minimize: 'Minimise / hide the window, leaving the app running',
        maximize: 'Maximise the window to fill the screen',
      },
    },
    nav: {
      type: 'choice',
      instructions: 'Assume the user wants to move within the browser. Which move?',
      criteria: NAV,
    },
    addressed: {
      type: 'noul',
      instructions: 'Is `utterance` an instruction spoken to a voice assistant that controls this computer (open, search, scroll, click, go back, stop, or a question for it), rather than background chatter, a phrase like "thank you for watching", subtitles, or nothing meaningful?',
      criteria: { true: 'A real instruction or question for the assistant', false: 'Not directed at the assistant, noise, or filler' },
    },
    where: {
      type: 'choice',
      instructions: 'Does the user say WHERE this should happen? `system` when they name a browser or app on their computer (Brave, Chrome, Firefox, Edge, Safari, "my browser"); `here` only when they name Cinderpaw or its own browser ("in the app", "here in Cinderpaw"); `unnamed` when they name no place, which is most of the time.',
      criteria: { here: 'In Cinderpaw\'s own built-in browser, named by the user', system: 'In a browser application on the computer that they named', unnamed: 'No place named (the default)' },
    },
    verb: {
      type: 'choice',
      instructions: 'Assume the user names an item on the page (an email, a video, a post, a file, a result). What do they want done to it? `open` when they just want it opened, played or gone to; `none` when they name a button to press rather than an item to act on ("press subscribe", "click accept").',
      criteria: { open: 'Open, go to, play, show or select it (the default)', delete: 'Delete or trash it', archive: 'Archive it', reply: 'Reply to it', like: 'Like it', save: 'Save or bookmark it', share: 'Share it', none: 'No item named: the words name a button or control to press' },
    },
    media_op: {
      type: 'choice',
      instructions: 'Assume the user wants to control playback. What?',
      criteria: { play_pause: 'play, pause, resume or stop the current track or video', next: 'next track / skip', previous: 'previous track / go back a song', volume_up: 'louder', volume_down: 'quieter', mute: 'mute or unmute the sound' },
    },
    compound: {
      type: 'noul',
      instructions: 'Does `utterance` ask for two or more separate actions to be performed one after another (for example "open youtube and search for jazz, then click the first one")? A single action with several words is not compound.',
      criteria: { true: 'Two or more distinct actions are requested', false: 'Exactly one action is requested' },
    },
  };
}

/**
 * A compound sentence, cut at its connectors into the steps it asks for, in
 * order. Short fragments (a lone word after "and") stay with the step before
 * them: "search for rock and roll" is one step, not two.
 */
export function splitSteps(utterance: string): string[] {
  // Whitespace on both sides, not `\b`: JavaScript's word boundary knows
  // only ASCII letters, so "și" never matched and a Romanian chain stayed one
  // step ("Deschide YouTube și caută o piesă", 21 Sep).
  const parts = utterance.split(/(?:,\s*)?(?:^|\s+)(?:and then|then|and|after that|după care|dupa care|și apoi|si apoi|apoi|și|si)(?:\s+|$)/i).map(clean).filter(Boolean);
  const steps: string[] = [];
  for (const p of parts) {
    if (steps.length > 0 && p.split(/\s+/).length < 2) steps[steps.length - 1] += ` and ${p}`;
    else steps.push(p);
  }
  return steps.length > 0 ? steps : [utterance];
}

export type Plan =
  | { action: 'open_app'; name: string; path: string; confidence: number }
  | { action: 'open_website'; url: string; label: string; system: boolean; confidence: number }
  | { action: 'web_search'; url: string; query: string; system: boolean; confidence: number }
  | { action: 'scroll'; dy: number; confidence: number }
  | { action: 'find'; query: string; confidence: number }
  | { action: 'click'; target: string; verb?: ClickVerb; confidence: number }
  | { action: 'navigate'; op: keyof typeof NAV; confidence: number }
  | { action: 'reader'; confidence: number }
  | { action: 'media'; op: 'play_pause' | 'next' | 'previous' | 'volume_up' | 'volume_down' | 'mute'; keys?: string; confidence: number }
  | { action: 'shortcut'; keys: string; means: string; confidence: number }
  | { action: 'type'; text: string; confidence: number }
  | { action: 'window_ctl'; op: 'close' | 'minimize' | 'maximize'; app: string | null; confidence: number }
  | { action: 'stop'; confidence: number }
  | { action: 'none'; confidence: number };

/** Like, save and share act on what is already open ("like this video"); the others on an item named in a list. */
function actsOnOpenItem(verb: ClickVerb | undefined): boolean {
  return verb === 'like' || verb === 'save' || verb === 'share';
}

/** What a click can do to the item it lands on, once it is open; the button is found by this name. */
export type ClickVerb = 'delete' | 'archive' | 'reply' | 'like' | 'save' | 'share';

/**
 * What may run on a half-said sentence, so the app opens while the person is
 * still talking (the jev-voice demo, 22 Sep). Only actions whose payload is a
 * closed choice: an app name, a site, a direction, back/forward. A search or a
 * find carries free text that is still growing ("search for lofi hip" ->
 * "... hip hop") and would run twice; a click, a key or play/pause acts on
 * whatever is in front and is not undone by saying more. Those wait for the
 * sentence to end. The fingerprint is what makes a partial and the final run
 * of the same sentence the same action, done once.
 */
export function earlyFingerprint(plan: Plan): string | null {
  switch (plan.action) {
    case 'open_app': return `open_app:${plan.name.toLowerCase()}`;
    case 'open_website': return `open_website:${plan.url}`;
    case 'scroll': return `scroll:${plan.dy}`;
    // "Can you close?" closed a tab at 0.82 before the sentence said which (22 Sep).
    case 'navigate': return plan.op === 'close_tab' ? null : `navigate:${plan.op}`;
    default: return null;
  }
}
/**
 * How many times ONE step asks to be done: "close the last two tabs", "scroll
 * down three times", "mergi înapoi de două ori". The number must qualify the
 * repetition itself (N times, N tabs, de N ori, twice), never merely appear in
 * the sentence: "search for three little pigs" is one search.
 *
 * Read per step, not per sentence. A count on one step lifting the guard for
 * the whole sentence let "close this tab, then scroll down twice" close a
 * second tab, and let every partial of "close the last two tabs" close
 * another (22 Sep, rejected in review before merge).
 *
 * ponytail: capped at 5. More than that by voice is far likelier a
 * mis-transcription than a wish; raise it if someone asks for "close ten tabs".
 */
const COUNT_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5,
  'două': 2, doua: 2, trei: 3, patru: 4, cinci: 5,
};
const MAX_REPEAT = 5;
export function repeatCount(step: string): number {
  // Whitespace and punctuation as separators, not `\b`: it knows only ASCII
  // letters, and "două" would never match (see splitSteps, 21 Sep).
  const s = ` ${step.toLowerCase().replace(/[.,!?;:]/g, ' ')} `;
  if (/\s(twice|de două ori|de doua ori)\s/.test(s)) return 2;
  const m = s.match(/\s(\d+|two|three|four|five|două|doua|trei|patru|cinci)\s+(times?|tabs?|pages?|ori|taburi|tab-uri|pagini)\s/)
    ?? s.match(/\sde\s+(\d+|două|doua|trei|patru|cinci)\s+ori\s/);
  if (!m) return 1;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : COUNT_WORDS[m[1]] ?? 1;
  return Math.max(1, Math.min(MAX_REPEAT, n));
}

/**
 * How many more times this step still has to run, given what earlier passes
 * of the same sentence already did. A partial may have closed one tab before
 * "two" was out; the end of the sentence then closes the rest, not two more.
 */
export function runsLeft(step: string, fingerprint: string | null, done: Map<string, number>): number {
  if (!fingerprint) return 1;
  return Math.max(0, repeatCount(step) - (done.get(fingerprint) ?? 0));
}

const CLICK_VERBS: ClickVerb[] = ['delete', 'archive', 'reply', 'like', 'save', 'share'];

type Answers = Record<string, { type: string; choice?: string; confidence?: number; noul?: number }>;

/** Jev's answers, read into one plan. Only the answers the chosen action needs are read. */
export function toPlan(utterance: string, ans: Answers, cands: Record<string, string>, shortcuts?: Record<string, KeyCommand>, apps: InstalledApp[] = [], windows: OpenWindow[] = []): Plan {
  const pick = (k: string): [string, number] => [ans[k]?.choice ?? '', Number(ans[k]?.confidence ?? 0)];
  const [action, c0] = pick('action');
  // The window the command acts on: the one named, else the one in front.
  // Named, it also supplies the keys ("pause in Spotify" with a terminal in
  // front went to the terminal, 21 Sep).
  // A wrong window is worse than the one in front: named only when Jev is sure.
  const [win, cwin] = pick('window');
  const named = cwin >= MIN_WINDOW_CONFIDENCE && win.startsWith('w') ? windows[Number(win.slice(1))] : undefined;
  target.pid = named?.pid ?? null;
  if (named) shortcuts = keysFor(named.title).commands;
  // Where it happens sticks: once they said "in Brave", the next commands mean
  // Brave too, until they name Cinderpaw or the call ends. Parked behind the
  // pill, it is the desktop regardless (see execute). A sentence that names
  // no place is `unnamed` and changes nothing: with only two options, Jev
  // answered `here` for "click the first video" and the next command went
  // back to the app's own browser (21 Sep).
  const [where, cwhere] = pick('where');
  if (cwhere >= MIN_CONFIDENCE && where === 'system') target.system = true;
  else if (cwhere >= MIN_CONFIDENCE && where === 'here') target.system = false;
  const system = target.system;
  let conf = c0;
  switch (action) {
    case 'open_app': {
      const [name, c] = pick('app');
      const app = apps.find((a) => a.name === name);
      return app ? { action, name: app.name, path: app.path, confidence: Math.min(conf, c) } : { action: 'none', confidence: conf };
    }
    case 'open_website': {
      const [site, c] = pick('site');
      if (site !== 'other' && SITES[site]) return { action, url: SITES[site], label: site, system, confidence: Math.min(conf, c) };
      const dom = domainGuess(utterance);
      if (dom) return { action, url: `https://${dom}`, label: dom, system, confidence: conf };
      // Nothing to navigate to: it is a search after all.
      const [engine] = pick('engine');
      const [tkey, ct] = pick('text');
      const query = cands[tkey] ?? utterance;
      return { action: 'web_search', url: (SEARCH_ON[engine] ?? SEARCH_ON.default)(query), query, system, confidence: Math.min(conf, ct) };
    }
    case 'web_search': {
      const [engine] = pick('engine');
      const [tkey, ct] = pick('text');
      const query = cands[tkey] ?? utterance;
      return { action, url: (SEARCH_ON[engine] ?? SEARCH_ON.default)(query), query, system, confidence: Math.min(conf, ct) };
    }
    case 'scroll': {
      const [dir, c] = pick('scroll_dir');
      const [amount] = pick('scroll_amount');
      const step = amount === 'little' ? 250 : amount === 'a_lot' ? 2400 : 700;
      const dy = dir === 'up' ? -step : dir === 'top' ? -1e7 : dir === 'bottom' ? 1e7 : step;
      return { action, dy, confidence: Math.min(conf, c) };
    }
    case 'find': {
      const [tkey, ct] = pick('text');
      return { action, query: cands[tkey] ?? utterance, confidence: Math.min(conf, ct) };
    }
    case 'navigate': {
      const [op, c] = pick('nav');
      conf = Math.min(conf, c);
      return op in NAV ? { action, op: op as keyof typeof NAV, confidence: conf } : { action: 'none', confidence: conf };
    }
    case 'click': {
      const [tkey, ct] = pick('text');
      // "Delete the first email" is two presses: the item, then its delete
      // button. Handing it to the agent instead took a minute (21 Sep).
      const [v, cv] = pick('verb');
      const verb = cv >= MIN_CONFIDENCE ? CLICK_VERBS.find((x) => x === v) : undefined;
      return { action, target: cands[tkey] ?? utterance, ...(verb ? { verb } : {}), confidence: Math.min(conf, ct) };
    }
    case 'media': {
      const [op, c] = pick('media_op');
      const ops = ['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute'] as const;
      const found = ops.find((o) => o === op);
      // The site's own key for it, when the window in front has one: YouTube's
      // Shift+N is "next"; the OS media key is ignored outside a playlist.
      let keys = shortcuts?.[`media_${found}`]?.keys;
      // "Pause" with a terminal in front (a denylisted window, 21 Sep) means
      // the thing that is playing: the first open window whose site has a
      // key for it takes the command, unless one was named.
      if (!keys && !named) {
        const playing = windows.find((w) => keysFor(w.title).commands[`media_${found}`]);
        if (playing) { target.pid = playing.pid; keys = keysFor(playing.title).commands[`media_${found}`].keys; }
      }
      return found ? { action, op: found, keys, confidence: Math.min(conf, c) } : { action: 'none', confidence: conf };
    }
    case 'shortcut': {
      const [key, c] = pick('shortcut');
      const cmd = shortcuts?.[key];
      return cmd ? { action, keys: cmd.keys, means: cmd.means, confidence: Math.min(conf, c) } : { action: 'none', confidence: conf };
    }
    case 'type': {
      const [tkey, ct] = pick('text');
      const text = cands[tkey] ?? '';
      return text ? { action, text, confidence: Math.min(conf, ct) } : { action: 'none', confidence: conf };
    }
    case 'window_ctl': {
      const [op, c] = pick('window_op');
      // The app is a nicety (the front window is the default), so a weak name
      // must not drag the whole decision down: `window` is picked already for
      // keys, and code below reads it the same way.
      const [wkey, cw] = pick('window');
      const named = cw >= MIN_WINDOW_CONFIDENCE && wkey.startsWith('w') ? windows[Number(wkey.slice(1))] : undefined;
      const valid = op === 'close' || op === 'minimize' || op === 'maximize';
      return valid
        ? { action, op: op as 'close' | 'minimize' | 'maximize', app: named?.app_name ?? null, confidence: Math.min(conf, c) }
        : { action: 'none', confidence: conf };
    }
    case 'reader': return { action, confidence: conf };
    case 'stop': return { action, confidence: conf };
    default: return { action: 'none', confidence: conf };
  }
}

/** Ask Jev. Throws the host's error strings (`jev-no-key`, `jev-http-401`...). */
export async function decide(utterance: string, page: string | null): Promise<{ plan: Plan; ms: number; compound: boolean; compoundScore: number; addressed: boolean; desktop: boolean }> {
  const cands = textCandidates(utterance);
  const desktop = target.system || (await outOfSight());
  const [front, windows, apps] = await Promise.all([desktop ? frontTitle() : null, desktop ? openWindows() : [], installedApps()]);
  const shortcuts = front !== null ? keysFor(front).commands : undefined;
  const r = await tauri.raw.jevDecide(
    // Only what every question needs. A list of open windows in the state
    // was a distractor for the other fifteen questions (TypeSafe: accuracy
    // falls as unrelated state grows); it lives in the `window` criteria.
    // On the desktop the app's own address is not what anyone is looking at.
    { utterance, page: desktop ? (front ?? 'unknown') : (page ?? 'the start page'), front: front ?? (desktop ? 'unknown' : 'Cinderpaw'), recent: recent.action, candidates: cands },
    questions(cands, shortcuts, apps, windows),
  );
  const compoundScore = Number(r.answers.compound?.noul ?? 0);
  // Below 0.5 the sentence was not for the assistant: chatter, or a phrase the
  // transcriber invented over silence ("Thank you for watching"). It is dropped,
  // not handed to the agent as a message.
  const addressed = Number(r.answers.addressed?.noul ?? 1) >= 0.5;
  return { plan: toPlan(utterance, r.answers as Answers, cands, shortcuts, apps, windows), ms: r.ms, compound: compoundScore > 0.5, compoundScore, addressed, desktop };
}

/**
 * True when the person is not looking at Cinderpaw: parked behind the pill,
 * hidden, minimised, or another window in front. Commands then act on the
 * desktop, where they are looking. The pill's flag alone was not enough: a
 * search said with the pill up opened in the hidden app's own browser, six
 * favicons loading in a window nobody could see (21 Sep).
 *
 * The host asks the OS which window is in front (`main_in_front`). The
 * window's own focus flag cannot say it: it turns false whenever the focus
 * goes into one of the app's webviews. Without the host, visibility decides.
 */
export async function outOfSight(): Promise<boolean> {
  if (parked.current) return true;
  if (!('__TAURI_INTERNALS__' in window)) return false;
  const inFront = await invoke<boolean>('main_in_front').catch(() => null);
  if (inFront !== null) return !inFront;
  const w = getCurrentWindow();
  const [visible, minimized] = await Promise.all([w.isVisible().catch(() => true), w.isMinimized().catch(() => false)]);
  return !visible || minimized;
}

/**
 * Is `said` the answer to the question Cinder is waiting on, and which option
 * does it pick? One Jev request, which reads the answer by meaning in any
 * language. Matching words against the labels could not: "da" to "Allow /
 * Deny" named no label, went back as free text, and the desktop step it was
 * meant to allow was refused (21 Sep). `reply` is false for speech that is
 * not an answer (a video talking, a new command); `selected` is empty when
 * the answer is in the person's own words.
 */
export async function interpretReply(q: AskUserQuestion, said: string): Promise<{ reply: boolean; selected: string[] }> {
  const criteria: Record<string, string> = Object.fromEntries(q.options.map((o, i) => [`o${i}`, o.description ? `${o.label}: ${o.description}` : o.label]));
  criteria.none = 'None of the options: they answered in their own words';
  const r = await tauri.raw.jevDecide({ question: q.question, options: q.options.map((o) => o.label), said }, {
    reply: {
      type: 'noul',
      instructions: 'The assistant asked `question` out loud and is waiting for the answer. Is `said` the user answering it, in any language (yes, no, "da", "nu", an option, a short answer), rather than a new command, speech from a video in the background, or noise?',
      criteria: { true: 'An answer to the question', false: 'Not an answer to this question' },
    },
    option: {
      type: 'choice',
      instructions: 'Assume `said` answers `question`. Which option did the user choose? They may answer in any language, or with yes or no: yes, "da", "sure", "go ahead" pick the option that agrees or allows; no, "nu", "stop", "do not" pick the one that refuses. Choose none when they chose no option.',
      criteria,
    },
  });
  const pick = r.answers.option?.choice ?? 'none';
  const label = Number(r.answers.option?.confidence ?? 0) >= MIN_CONFIDENCE && pick.startsWith('o') ? q.options[Number(pick.slice(1))]?.label : undefined;
  return { reply: Number(r.answers.reply?.noul ?? 1) >= 0.5, selected: label ? [label] : [] };
}

/**
 * The Start Menu, kept for thirty seconds; empty off Windows or when it cannot
 * be read. The host answers from its own cache, and completes it in the
 * background (Store apps take seconds to read), so a short hold here is what
 * lets "open Calculator" work a moment after the call starts.
 */
let appsCache: { at: number; apps: InstalledApp[] } | null = null;
/**
 * "Open the browser" names no Start Menu entry, and picking Brave out of 254
 * apps for it came back at 0.45 (22 Sep). One listed app IS the browser, by
 * that name; its `path` is this marker and it opens the default browser on
 * the start page instead of a shortcut.
 */
export const THE_BROWSER = 'the-default-browser';
export async function installedApps(): Promise<InstalledApp[]> {
  if (appsCache && Date.now() - appsCache.at < 30_000) return appsCache.apps;
  // A Choice takes at most 255 options; `none` is one of them, the browser another.
  const apps = [{ name: 'Browser (the web browser, whichever is the default)', path: THE_BROWSER }, ...(await invoke<InstalledApp[]>('list_apps').catch(() => [] as InstalledApp[])).slice(0, 253)];
  appsCache = { at: Date.now(), apps };
  return apps;
}

/** The windows on screen, titled, for "in Spotify"; at most 30, and never Cinderpaw's own. */
async function openWindows(): Promise<OpenWindow[]> {
  const all = await invoke<OpenWindow[]>('list_windows').catch(() => [] as OpenWindow[]);
  return all.filter((w) => w.title && !/cinderpaw/i.test(w.app_name)).slice(0, 30);
}

/**
 * The title of the window in front ("Reble - YouTube - Brave"), or null when
 * desktop control is off or nothing has the focus. The title is what picks
 * the key map; Jev also reads it as `front`.
 */
async function frontTitle(): Promise<string | null> {
  try {
    const el = await invoke<DesktopElement>('get_focused_element');
    const pid = Number(el.id.split(':')[0]);
    // A browser's Document element is named after the page ("… - YouTube"),
    // and the focused element's process is not always the one that owns a
    // top-level window (Brave, 21 Sep): the page's own name comes first.
    const docs = await invoke<DesktopElement[]>('find_elements', { pid, query: { role: 'Document', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
    const page = docs.find((d) => d.name && !d.is_offscreen);
    const windows = await invoke<OpenWindow[]>('list_windows');
    const w = windows.find((x) => x.pid === pid);
    const title = [page?.name, w?.title, w?.app_name].filter(Boolean).join(' - ');
    return title || null;
  } catch {
    return null;
  }
}

/** One clickable thing on the page, as the snapshot names it. */
interface Clickable { ref: string; name: string; tag?: string; role?: string; inView?: boolean }

/**
 * Which element on the page did they mean? The snapshot's clickable elements
 * become the menu (name by ref, first 150 with a name), and Jev picks; "the
 * first one" is a meaning it can match against the list order. Returns the
 * ref, or null when Jev says none of them.
 */
export async function decideClick(target: string, elements: Clickable[]): Promise<{ ref: string | null; ms: number }> {
  // What is on screen first: the like button is in view, a footer link is not.
  const named = elements.filter((e) => e.name);
  const menu = [...named.filter((e) => e.inView), ...named.filter((e) => !e.inView)].slice(0, 150);
  if (menu.length === 0) return { ref: null, ms: 0 };
  const criteria: Record<string, string> = Object.fromEntries(menu.map((e) => [`r${e.ref}`, `${e.role ?? e.tag ?? ''}: ${e.name}`]));
  criteria.none = 'None of the listed elements is what the user means';
  // Jev does not count reliably over long lists (its own docs). So "the third
  // result" is two small judgements for Jev (which position, what kind of
  // thing) and the counting is done here, in page order. Nothing ordinal, and
  // the element is chosen by meaning from the menu as before.
  const r = await tauri.raw.jevDecide({ target, elements: menu.map((e) => `${e.role ?? ''}: ${e.name}`) }, {
    element: {
      type: 'choice',
      instructions: 'The user asked to click something on the page; `target` is their words. `elements` lists what can be clicked, in page order. Which element do they mean, by meaning? Choose none if nothing fits.',
      criteria,
    },
    position: {
      type: 'choice',
      instructions: 'Does `target` point at a position in a list ("the first video", "the second result", "the last one")? Which position? Choose none when it names a thing, not a position ("the like button", "sign in").',
      criteria: { first: null, second: null, third: null, fourth: null, fifth: null, last: null, none: 'No position named' },
    },
    kind: {
      type: 'choice',
      instructions: 'Assume `target` points at a position in a list. What kind of element is it counting?',
      criteria: {
        link: { what: 'A link or hyperlink: a search result, a video, an article, a post, a song', examples: ['the first video', 'the third result', 'the second article'] },
        button: { what: 'A button', examples: ['the first button', 'the second option'] },
        tab: { what: 'A tab', examples: ['the second tab'] },
        item: { what: 'A row, list item, menu entry or card', examples: ['the first item', 'the last row'] },
        any: 'Not clear what kind: count everything clickable',
      },
    },
  });
  const a = r.answers.element;
  const pos = r.answers.position?.choice ?? 'none';
  let ref: string | null = null;
  // "The first mail from Jefe" names the thing AND a position. Counting won
  // and the first row went, whoever it was from; a named item is found by
  // meaning, and the name in the words is the proof that it was named: a
  // word of the target that the chosen element carries too, and that is not
  // an ordinal ("first", "video"), which every row would share.
  const byMeaning = a?.choice && a.choice !== 'none' && Number(a.confidence ?? 0) >= MIN_CLICK_CONFIDENCE ? menu.find((e) => `r${e.ref}` === a.choice) : undefined;
  const nameMatch = byMeaning !== undefined && sharesName(target, byMeaning.name);
  if (nameMatch) {
    ref = byMeaning!.ref;
    console.info(`[jev] click "${target}": named -> ${byMeaning!.name}`);
  } else if (pos !== 'none' && Number(r.answers.position?.confidence ?? 0) >= MIN_CLICK_CONFIDENCE) {
    const kind = r.answers.kind?.choice ?? 'any';
    const fits = (e: Clickable) => kind === 'any' ? true
      : kind === 'link' ? /link|hyperlink|a$/i.test(e.role ?? e.tag ?? '')
      : kind === 'button' ? /button/i.test(e.role ?? e.tag ?? '')
      : kind === 'tab' ? /tab/i.test(e.role ?? '')
      : /item|row|cell|menu/i.test(e.role ?? '');
    const ordered = menu.filter(fits);
    const index = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: ordered.length - 1 }[pos as 'first'] ?? 0;
    ref = ordered[index]?.ref ?? null;
    console.info(`[jev] click "${target}": ${pos} ${kind} of ${ordered.length} -> ${ref ? ordered[index].name : 'nothing'}`);
  } else {
    ref = a?.choice && a.choice !== 'none' && Number(a.confidence ?? 0) >= MIN_CLICK_CONFIDENCE ? a.choice.slice(1) : null;
  }
  // When nothing is picked, the menu itself is the evidence: was the element
  // there at all, or did the window expose only its chrome?
  if (!ref) console.info(`[jev] click "${target}": ${a?.choice ?? 'no answer'} at ${Number(a?.confidence ?? 0).toFixed(2)}; menu: ${menu.slice(0, 20).map((e) => e.name).join(' | ')}`);
  return { ref, ms: r.ms };
}


/** Words that any item in a list can match, so they prove nothing about which one. */
const GENERIC_WORDS = /^(the|first|second|third|fourth|fifth|last|one|video|videoclip|videoclipul|result|rezultat|rezultatul|mail|email|emailul|mailul|message|mesaj|mesajul|post|postarea|item|link|button|butonul|click|press|open|delete|sterge|șterge|archive|arhiveaza|reply|like|primul|prima|al|a|doilea|doua|treilea|treia|ultimul|ultima|pe|la|din|de|from|on|in|and|si|și|please|te|rog|frumos)$/i;

/** True when a word of four or more letters in `target` also appears in `name`, and is not a word every item has. */
export function sharesName(target: string, name: string): boolean {
  const words = new Set(name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
  return target.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 4 && !GENERIC_WORDS.test(w) && words.has(w));
}

/**
 * The desktop side of the same actions, for a call parked behind the pill.
 *
 * With the app hidden, the built-in browser is off limits: a page opened in a
 * hidden window is a page nobody sees, and it is what the person was NOT
 * asking for. Every action here lands on the window in front instead: pages
 * open in the system browser, scrolling and navigation are the keys every
 * browser understands, a click goes through the accessibility tree of the
 * front window with Jev choosing the element. What has no desktop equivalent
 * says so. All of it needs desktop control, which is a Settings switch, off
 * by default; the refusal names it.
 */
const MEDIA_KEYS = { play_pause: '{playpause}', next: '{nexttrack}', previous: '{prevtrack}', volume_up: '{volumeup}', volume_down: '{volumedown}', mute: '{volumemute}' };

interface DesktopElement {
  id: string;
  role: string;
  name: string;
  is_offscreen: boolean;
  is_enabled: boolean;
  /** Screen rectangle. The host has always sent it; nothing here read it until 22 Sep. */
  bounding_rect?: { x: number; y: number; width: number; height: number };
}

/**
 * Reading order: top to bottom, then left to right, by where a thing actually
 * IS on screen.
 *
 * "The first link" and "the first video" kept pressing something else because
 * the list handed to Jev was in accessibility-tree order, which follows the
 * page's markup and is not what a person sees. Rows within 24 px of each other
 * count as the same line, so two results side by side are ordered left to
 * right rather than by a few pixels of vertical jitter.
 */
export function inReadingOrder(elements: DesktopElement[]): DesktopElement[] {
  const ROW = 24;
  return [...elements].sort((a, b) => {
    const ra = a.bounding_rect, rb = b.bounding_rect;
    if (!ra || !rb) return 0;
    return Math.abs(ra.y - rb.y) > ROW ? ra.y - rb.y : ra.x - rb.x;
  });
}

/** The one refusal a person can act on; it is spoken, so it is a sentence, not a log line. */
export const DESKTOP_CONTROL_OFF = 'Desktop control is off. Turn it on in Settings to use commands outside Cinderpaw.';

/**
 * A host error, worded for the person. The host's own line names an
 * environment variable ("Set CINDERPAW_ENABLE_DESKTOP_CONTROL=true"), which is
 * for whoever runs the code, not whoever talks to it.
 */
function desktopError(e: unknown): Error {
  const msg = String(e);
  if (msg.includes('disabled')) return new Error(DESKTOP_CONTROL_OFF);
  // A terminal or a password manager in front: the host will not touch it,
  // by design. Said so, with what to do; "That did not work" said nothing.
  const denied = msg.match(/"([^"]+)" is on the security denylist/);
  if (denied) return new Error(`${denied[1].replace(/\.exe$/i, '')} is in front, and I never control that window. Put the page you mean in front.`);
  return new Error(msg);
}

async function frontElement(): Promise<DesktopElement> {
  try {
    // A named window ("in Spotify") is the target whatever is in front: its
    // top-level element takes the focus when the keys are sent to it.
    if (target.pid !== null) {
      const wins = await invoke<DesktopElement[]>('find_elements', { pid: target.pid, query: { role: 'Window', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
      const w = wins.find((x) => x.is_enabled);
      if (w) return w;
    }
    return await invoke<DesktopElement>('get_focused_element');
  } catch (e) {
    throw desktopError(e);
  }
}

async function keys(spec: string): Promise<void> {
  const el = await frontElement();
  await invoke('send_keys', { elementId: el.id, keys: spec });
}

/**
 * A site's own keys ("k" pauses YouTube) work with the focus on the page
 * body. Sent to whatever had the focus, "k" typed a k into the search box
 * and "pause" did nothing, twice, while the chime said done (21 Sep). The
 * page's Document element takes the focus first, then the keys.
 */
async function siteKeys(spec: string): Promise<void> {
  const el = await frontElement();
  const pid = Number(el.id.split(':')[0]);
  const docs = await invoke<DesktopElement[]>('find_elements', { pid, query: { role: 'Document', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
  const page = docs.find((d) => d.is_enabled && !d.is_offscreen);
  await invoke('send_keys', { elementId: page?.id ?? el.id, keys: spec });
  console.info(`[jev] site keys ${spec} to ${page ? `document "${page.name}"` : 'the focused element'}`);
}

/** The roles a click can land on, as the host names them (one UIA control type each). */
const CLICKABLE_ROLES = 'Button,Hyperlink,ListItem,TabItem,CheckBox,RadioButton,ComboBox,MenuItem,TreeItem,DataItem,SplitButton';

/** Names of a browser's own buttons and menus (en/ro), never what a person means by "the first one". */
const BROWSER_CHROME = /^(minimi[sz]e|maximi[sz]e|restore|close|reload|refresh|back|forward|new tab|search tabs|bookmark|extensions?|profile|customi[sz]e|brave|leo|vpn|wallet|rewards|shields|translate|install|reading list|side ?bar|minimizează|maximizează|restabilește|închide|reîncarcă|înapoi|înainte|filă nouă|marchează|afișea?ză|extensii|personal|portofel|recompense|tradu|instalează|gestionează)/i;

/** Press the element in the front window that matches `target`, if Jev finds one. */
async function clickInFront(target: string): Promise<boolean> {
  const front = await frontElement();
  const pid = Number(front.id.split(':')[0]);
  let clickable: DesktopElement[] = [];
  // A browser exposes its page through the accessibility tree only after the
  // first query, and a page just opened is still loading: the first read saw
  // 48 elements of Brave's own chrome and not one link (21 Sep), and a later
  // one saw YouTube's header but no results yet. jev-desktop re-observes
  // while the UI is pending; here the page is read again, 400 ms apart, until
  // the number of links stops growing (or four looks are spent).
  let links = -1;
  for (let look = 0; look < 4; look++) {
    // Inside the page's main landmark when it has one, the whole page (the
    // Document) otherwise: what the page shows, without the browser's own
    // buttons, the site's header or its side menu. Counted over the whole
    // Document, "the first video" on YouTube was the logo ("YouTube Home")
    // and "the second" was "Home" in the guide (21 Sep). The name cut below
    // is the last net, for apps whose page has neither.
    // Only what can be pressed, filtered by the page itself: asking for every
    // element of a results page and sorting them here was most of the time a
    // click took, and the 500-element cap ran out before the tenth result.
    const found = await invoke<DesktopElement[]>('find_elements', { pid, query: { role: CLICKABLE_ROLES, name: null, automation_id: null, value_contains: null, under_role: 'Main,Document' }, windowTitle: null });
    clickable = found.filter((e) => e.name && e.is_enabled && !e.is_offscreen && !BROWSER_CHROME.test(e.name));
    const now = clickable.filter((e) => /link|hyperlink/i.test(e.role)).length;
    // Two looks that agree are enough, zero links included: an app with no
    // web page in it (Spotify, WhatsApp) spent four looks and 1.6 s waiting
    // for links that were never coming.
    if (look > 0 && now === links) break;
    console.info(`[jev] desktop look ${look + 1}: ${clickable.length} clickable, ${now} links`);
    links = now;
    await new Promise((r) => setTimeout(r, 400));
  }
  // In the order a person reads them. The tree's own order follows the page's
  // markup, so "the first link" was whatever the DOM happened to put first and
  // the click landed on something else every time (22 Sep, five tries).
  clickable = inReadingOrder(clickable);
  const { ref, ms } = await decideClick(target, clickable.map((e) => ({ ref: e.id, name: e.name, role: e.role, inView: true })));
  console.info(`[jev] desktop click ${ref ? 'found' : 'none'} among ${clickable.length} in ${ms}ms`);
  if (!ref) return false;
  // A link opens a page, and the title says whether it did; a button (like,
  // subscribe) changes nothing the title shows, so it is not checked.
  const isLink = /link|hyperlink/i.test(clickable.find((e) => e.id === ref)?.role ?? '');
  const before = isLink ? await frontTitle() : null;
  const chosen = clickable.find((e) => e.id === ref);
  console.info(`[jev] desktop click pressing ${chosen?.role ?? '?'} "${chosen?.name ?? '?'}"`);
  await invoke('click_element', { elementId: ref });
  if (before !== null && !(await pageChanged(before))) throw new Error('The click landed but the page did not change.');
  return true;
}

/** True when the front title differs from `before` within about a second: the page did something. */
async function pageChanged(before: string | null): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if ((await frontTitle()) !== before) return true;
  }
  return false;
}

/**
 * Is this open window the app with that name? Process names are short
 * ("brave.exe", "Code.exe", "WhatsApp.Root.exe"), app names long ("Brave",
 * "Visual Studio Code", "WhatsApp"): one holds the other, letters only.
 */
export function windowOfApp(appName: string, w: OpenWindow): boolean {
  const key = (s: string) => s.toLowerCase().replace(/\.exe$/, '').replace(/[^\p{L}\p{N}]/gu, '');
  const app = key(appName);
  const proc = key(w.app_name);
  return proc.length >= 3 && app.length >= 3 && (app === proc || app.includes(proc) || proc.includes(app));
}

/**
 * Put the caret in the window's text field, when it has one and does not
 * already hold the focus. Best effort: a window with no such field (or one
 * the tree does not expose) is left alone and the keys go where they would
 * have gone anyway.
 */
async function focusTextField(): Promise<void> {
  try {
    const el = await frontElement();
    if (/edit|text|combobox|document/i.test(el.role)) return;
    const pid = Number(el.id.split(':')[0]);
    const fields = await invoke<DesktopElement[]>('find_elements', { pid, query: { role: 'Edit', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
    const field = fields.find((f) => f.is_enabled && !f.is_offscreen);
    if (field) { await invoke('take_element_action', { elementId: field.id, action: 'focus' }); return; }
    // A web page has no Edit: its composer lives inside the Document, and
    // clicking the document at least puts the keyboard inside the page.
    const docs = await invoke<DesktopElement[]>('find_elements', { pid, query: { role: 'Document', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
    const doc = docs.find((d) => d.is_enabled && !d.is_offscreen);
    if (doc) await invoke('take_element_action', { elementId: doc.id, action: 'focus' });
  } catch {
    // Typing is still worth attempting where the focus already is.
  }
}

/** Bring a named app's window to the front, so window keys land on it. */
async function focusWindowOf(appName: string): Promise<void> {
  const open = (await openWindows()).find((w) => windowOfApp(appName, w));
  if (!open) return;
  const wins = await invoke<DesktopElement[]>('find_elements', { pid: open.pid, query: { role: 'Window', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
  const win = wins.find((x) => x.is_enabled);
  if (win) await invoke('take_element_action', { elementId: win.id, action: 'focus' }).catch(() => {});
}

export async function executeOnDesktop(plan: Plan): Promise<string> {
  switch (plan.action) {
    case 'open_app': {
      if (plan.path === THE_BROWSER) { await shellOpen(SITES.duckduckgo); return 'Opening the browser.'; }
      // Already open: to the front. "Open Brave" with Brave open opened a
      // second window, and "switch to" did not switch.
      const open = (await openWindows()).find((w) => windowOfApp(plan.name, w));
      if (open) {
        const wins = await invoke<DesktopElement[]>('find_elements', { pid: open.pid, query: { role: 'Window', name: null, automation_id: null, value_contains: null }, windowTitle: null }).catch(() => [] as DesktopElement[]);
        const win = wins.find((x) => x.is_enabled);
        if (win && (await invoke('take_element_action', { elementId: win.id, action: 'focus' }).then(() => true, () => false))) return `Switching to ${plan.name}.`;
      }
      await invoke('launch_app', { app: plan.path }).catch((e) => { throw desktopError(e); });
      return `Opening ${plan.name}.`;
    }
    // Opening a page in the system browser needs no desktop control; only
    // checking that it happened does. With the switch off (the default),
    // `frontTitle` is null before and after, and reading that as "nothing
    // changed" reported every successful open as a failure (21 Sep). What
    // cannot be observed is not reported either way.
    case 'open_website': {
      const before = await frontTitle();
      await shellOpen(plan.url);
      return before === null || (await pageChanged(before)) ? `Opening ${plan.label} in your browser.` : `I asked your browser to open ${plan.label}, but nothing new came up.`;
    }
    case 'web_search': {
      const before = await frontTitle();
      await shellOpen(plan.url);
      return before === null || (await pageChanged(before)) ? `Searching for ${plan.query} in your browser.` : `I asked your browser to search for ${plan.query}, but nothing new came up.`;
    }
    case 'scroll': {
      const spec = plan.dy <= -1e6 ? '{ctrl+home}' : plan.dy >= 1e6 ? '{ctrl+end}'
        : Math.abs(plan.dy) <= 300 ? (plan.dy < 0 ? '{up}{up}{up}' : '{down}{down}{down}')
          : Math.abs(plan.dy) >= 2000 ? (plan.dy < 0 ? '{pageup}{pageup}{pageup}' : '{pagedown}{pagedown}{pagedown}')
            : (plan.dy < 0 ? '{pageup}' : '{pagedown}');
      await keys(spec);
      return '';
    }
    case 'navigate': {
      const spec = { back: '{browserback}', forward: '{browserforward}', reload: '{browserrefresh}', new_tab: '{ctrl+t}', close_tab: '{ctrl+w}', home: '' }[plan.op];
      if (!spec) return 'There is no home outside Cinderpaw.';
      const before = plan.op === 'reload' ? null : await frontTitle();
      await keys(spec);
      if (before !== null && !(await pageChanged(before))) return `That did not change the page; there may be nothing to go ${plan.op === 'back' ? 'back' : plan.op === 'forward' ? 'forward' : 'to'}.`;
      return '';
    }
    case 'find': await keys(`{ctrl+f}${plan.query}`); return '';
    case 'click': {
      // "Like this song", "save this": the verb's own button, on what is
      // already open. Looking for "this song" as a thing to open first found
      // nothing, and the like never happened (21 Sep).
      if (actsOnOpenItem(plan.verb) && (await clickInFront(`the ${plan.verb} button`))) return '';
      const pressed = await clickInFront(plan.target);
      if (!pressed) return `I could not find ${plan.target} in the window in front.`;
      if (!plan.verb) return '';
      // The item is open; now the button that does the verb to it (Gmail's
      // "Delete" toolbar button, YouTube's like button). A moment for the
      // page to show it: the toolbar arrives with the mail, not before.
      await new Promise((r) => setTimeout(r, 700));
      const done = await clickInFront(`the ${plan.verb} button`);
      return done ? '' : `I opened it, but could not find a ${plan.verb} button.`;
    }
    case 'shortcut': await siteKeys(plan.keys); return '';
    // Literal characters; `{` is the key parser's escape, doubled it is itself.
    // Alt+F4, Win+Down, Win+Up: the shortcuts every Windows app honours, sent
    // to the window itself. Before this there was no window action at all, so
    // "close Spotify" came back as `navigate` and closed a browser tab, and
    // "minimise WhatsApp" came back as `open_app` and re-opened what the person
    // wanted out of the way (22 Sep, four times in one round).
    case 'window_ctl': {
      if (plan.app) await focusWindowOf(plan.app);
      const spec = plan.op === 'close' ? '{alt+f4}' : plan.op === 'minimize' ? '{win+down}' : '{win+up}';
      await keys(spec);
      const said = plan.op === 'close' ? 'Closing' : plan.op === 'minimize' ? 'Minimising' : 'Maximising';
      return `${said} ${plan.app ?? 'this window'}.`;
    }
    case 'type': {
      // An app launched by the step before is not in front yet; a second and
      // a half is what Notepad takes here. ponytail: a fixed wait, poll the
      // front window's pid if an app turns out slower.
      if (previous === 'open_app') await new Promise((r) => setTimeout(r, 1500));
      // Into the text field, not into whatever holds the focus. Notepad focuses
      // its own text area, so typing worked there and nothing at all reached
      // ChatGPT's composer (22 Sep, twice, at 0.98 and 1.00 confidence).
      await focusTextField();
      await keys(plan.text.replace(/\{/g, '{{'));
      return `Typing "${plan.text}".`;
    }
    case 'media': {
      // The site's own key first (Shift+N on YouTube). Failing that, "next"
      // and "previous" press the player's button when the window has one;
      // the OS media key is the last resort, a player ignores it outside a
      // playlist (YouTube, 21 Sep).
      if (plan.keys) {
        // "Next" and "previous" change the page, and the window title says
        // so: the one check that separates "the key was sent" from "it did
        // something", which the chime otherwise could not tell apart (21 Sep).
        const before = plan.op === 'next' || plan.op === 'previous' ? await frontTitle() : null;
        await siteKeys(plan.keys);
        if (before !== null && !(await pageChanged(before))) return `That did not change the page; there may be no ${plan.op} one.`;
        return '';
      }
      if (plan.op === 'next' || plan.op === 'previous') {
        const pressed = await clickInFront(plan.op === 'next' ? 'the next track or next video button' : 'the previous track or previous video button').catch(() => false);
        if (pressed) { console.info(`[jev] media ${plan.op} via button`); return ''; }
      }
      await keys(MEDIA_KEYS[plan.op]); console.info(`[jev] media key ${plan.op}`); return '';
    }
    case 'reader': return 'Reader view only exists in Cinderpaw\'s browser.';
    default: return '';
  }
}

/**
 * Do it, through the browser store: the same actions the panel's own buttons
 * call, so the panel opens, the tab row follows, and "close this tab" knows
 * which tab is active. Calling the host ops directly skipped all of that:
 * "open a new tab" left the panel closed and "close this tab" had no id.
 * Returns the short line to say back.
 */
export async function execute(plan: Plan, desktop?: boolean): Promise<string> {
  previous = recent.action;
  recent.action = plan.action === 'media' ? `media ${plan.op}` : plan.action === 'navigate' ? `navigate ${plan.op}` : plan.action;
  // Out of sight (parked, hidden, minimised, another window in front), or a
  // named app on the computer: the desktop, never the hidden app (see
  // executeOnDesktop). An application opens on the desktop wherever the call
  // is. `desktop` is what `decide` saw, so a plan runs where it was made.
  const onDesktop = desktop ?? (await outOfSight());
  if (onDesktop || target.system || plan.action === 'open_app' || plan.action === 'type' || plan.action === 'window_ctl') return executeOnDesktop(plan);
  const b = useBrowser.getState();
  const ui = tauri.browser.ui;
  switch (plan.action) {
    // On the computer's own browser when the person named one, or when the app
    // is parked behind the call pill: a page opened in a hidden window is a
    // page nobody sees.
    case 'open_website':
      if (plan.system) { await shellOpen(plan.url); return `Opening ${plan.label} in your browser.`; }
      await b.open(plan.url); return `Opening ${plan.label}.`;
    case 'web_search':
      if (plan.system) { await shellOpen(plan.url); return `Searching for ${plan.query} in your browser.`; }
      await b.open(plan.url); return `Searching for ${plan.query}.`;
    case 'scroll': b.setPanel(true); await ui('scroll', { dy: plan.dy }); return '';
    case 'find': {
      b.setPanel(true);
      const r = (await ui('find', { query: plan.query })) as { total?: number };
      return r?.total ? `${r.total} matches for ${plan.query}.` : `Nothing on this page says ${plan.query}.`;
    }
    case 'navigate': {
      b.setPanel(true);
      if (plan.op === 'new_tab') await b.newTab();
      else if (plan.op === 'close_tab') { if (b.active != null) await b.closeTab(b.active); else return 'No tab to close.'; }
      else await b.go(plan.op);
      return '';
    }
    case 'click': {
      b.setPanel(true);
      const press = async (target: string): Promise<boolean> => {
        const snap = (await ui('snapshot')) as { elements?: Clickable[] };
        const { ref, ms } = await decideClick(target, snap.elements ?? []);
        console.info(`[jev] click ${ref ? `ref ${ref}` : 'none'} in ${ms}ms`);
        if (!ref) return false;
        await ui('click', { ref });
        return true;
      };
      if (actsOnOpenItem(plan.verb) && (await press(`the ${plan.verb} button`))) return '';
      if (!(await press(plan.target))) return `I could not find ${plan.target} on this page.`;
      if (!plan.verb) return '';
      // Same second press as on the desktop: the item first, then its button.
      await new Promise((r) => setTimeout(r, 700));
      return (await press(`the ${plan.verb} button`)) ? '' : `I opened it, but could not find a ${plan.verb} button.`;
    }
    case 'media': {
      // Playback keys are the OS's, not the page's; they need desktop control.
      await keys(MEDIA_KEYS[plan.op]);
      return '';
    }
    case 'shortcut': return 'That shortcut works in a browser on your computer, not inside Cinderpaw.';
    case 'reader': {
      b.setPanel(true);
      const r = (await ui('reader')) as { ok?: boolean; error?: string };
      return r?.ok === false ? (r.error ?? 'No article on this page to read.') : '';
    }
    default: return '';
  }
}
