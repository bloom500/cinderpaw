/**
 * What the app or site in front answers to on the keyboard.
 *
 * This is the closed set the Jev call picks from when it is parked behind
 * the pill: a key the app documents, sent as a key, never a hunt through the
 * accessibility tree for a button that may or may not be exposed. "Next
 * video" on YouTube is `Shift+N`; the media key the OS has for that is
 * ignored by YouTube outside a playlist (21 Sep), and the button hunt found
 * nothing twice. Every jev-voice / Minecraft demo works this way: the harness
 * knows the keys, Jev only chooses one.
 *
 * Specs use the host's `send_keys` grammar: `{ctrl+t}`, `{shift+n}`, `{f}`
 * for named keys and combinations, bare characters for typed text. `means`
 * is the criterion Jev reads; write it as what a person says, not the key.
 *
 * Adding an app: one entry in SITE_KEYS with a title pattern. Nothing else
 * changes; the question is built from whatever matches the window in front.
 */
export interface KeyCommand { keys: string; means: string }
export interface SiteKeys { id: string; match: RegExp; commands: Record<string, KeyCommand> }

/** Keys every browser has, on any page. */
export const BROWSER_KEYS: Record<string, KeyCommand> = {
  new_tab: { keys: '{ctrl+t}', means: 'open a new tab' },
  close_tab: { keys: '{ctrl+w}', means: 'close this tab' },
  reopen_tab: { keys: '{ctrl+shift+t}', means: 'reopen the last closed tab' },
  next_tab: { keys: '{ctrl+tab}', means: 'switch to the next tab' },
  previous_tab: { keys: '{ctrl+shift+tab}', means: 'switch to the previous tab' },
  new_window: { keys: '{ctrl+n}', means: 'open a new window' },
  private_window: { keys: '{ctrl+shift+n}', means: 'open a private / incognito window' },
  address_bar: { keys: '{ctrl+l}', means: 'go to the address bar / type a web address' },
  find_in_page: { keys: '{ctrl+f}', means: 'find text on this page' },
  reload: { keys: '{f5}', means: 'reload / refresh the page' },
  hard_reload: { keys: '{ctrl+shift+r}', means: 'reload the page ignoring the cache' },
  back: { keys: '{alt+left}', means: 'go back to the previous page' },
  forward: { keys: '{alt+right}', means: 'go forward' },
  home: { keys: '{alt+home}', means: 'go to the browser home page' },
  bookmark: { keys: '{ctrl+d}', means: 'bookmark this page' },
  bookmarks_bar: { keys: '{ctrl+shift+b}', means: 'show or hide the bookmarks bar' },
  history: { keys: '{ctrl+h}', means: 'open the browsing history' },
  downloads: { keys: '{ctrl+j}', means: 'open the downloads' },
  zoom_in: { keys: '{ctrl+=}', means: 'zoom in / make the page bigger' },
  zoom_out: { keys: '{ctrl+-}', means: 'zoom out / make the page smaller' },
  zoom_reset: { keys: '{ctrl+0}', means: 'reset the zoom to normal' },
  fullscreen: { keys: '{f11}', means: 'toggle the browser full screen' },
  print: { keys: '{ctrl+p}', means: 'print this page' },
  save_page: { keys: '{ctrl+s}', means: 'save this page' },
  select_all: { keys: '{ctrl+a}', means: 'select everything' },
  copy: { keys: '{ctrl+c}', means: 'copy the selection' },
  paste: { keys: '{ctrl+v}', means: 'paste' },
  undo: { keys: '{ctrl+z}', means: 'undo' },
  escape: { keys: '{escape}', means: 'escape / dismiss / close this dialog or menu' },
  page_down: { keys: '{pagedown}', means: 'page down' },
  page_up: { keys: '{pageup}', means: 'page up' },
  top: { keys: '{ctrl+home}', means: 'jump to the top of the page' },
  bottom: { keys: '{ctrl+end}', means: 'jump to the bottom of the page' },
  devtools: { keys: '{f12}', means: 'open the developer tools' },
};

/** Keys any Windows application answers to, when the window in front is not a browser. */
export const WINDOWS_KEYS: Record<string, KeyCommand> = {
  select_all: BROWSER_KEYS.select_all,
  copy: BROWSER_KEYS.copy,
  paste: BROWSER_KEYS.paste,
  cut: { keys: '{ctrl+x}', means: 'cut the selection' },
  undo: BROWSER_KEYS.undo,
  redo: { keys: '{ctrl+y}', means: 'redo' },
  save: { keys: '{ctrl+s}', means: 'save' },
  save_as: { keys: '{ctrl+shift+s}', means: 'save as / save a copy' },
  open: { keys: '{ctrl+o}', means: 'open a file' },
  new: { keys: '{ctrl+n}', means: 'new file / new document / new window' },
  find: { keys: '{ctrl+f}', means: 'find' },
  print: BROWSER_KEYS.print,
  close_window: { keys: '{alt+f4}', means: 'close this window / quit the app' },
  close_tab: { keys: '{ctrl+w}', means: 'close this tab or document' },
  escape: BROWSER_KEYS.escape,
  enter: { keys: '{enter}', means: 'press enter / confirm / OK' },
  tab: { keys: '{tab}', means: 'press tab / move to the next field' },
  delete: { keys: '{delete}', means: 'delete the selection' },
  maximize: { keys: '{win+up}', means: 'maximize the window' },
  minimize: { keys: '{win+down}', means: 'minimize the window' },
  snap_left: { keys: '{win+left}', means: 'snap the window to the left half of the screen' },
  snap_right: { keys: '{win+right}', means: 'snap the window to the right half of the screen' },
  show_desktop: { keys: '{win+d}', means: 'show the desktop / hide all windows' },
  task_view: { keys: '{win+tab}', means: 'show all open windows (task view)' },
  file_explorer: { keys: '{win+e}', means: 'open File Explorer' },
  lock: { keys: '{win+l}', means: 'lock the computer' },
  settings: { keys: '{win+i}', means: 'open Windows Settings' },
  screenshot: { keys: '{win+shift+s}', means: 'take a screenshot of part of the screen' },
  emoji: { keys: '{win+.}', means: 'open the emoji picker' },
  clipboard_history: { keys: '{win+v}', means: 'open the clipboard history' },
  zoom_in: BROWSER_KEYS.zoom_in,
  zoom_out: BROWSER_KEYS.zoom_out,
};

export const SITE_KEYS: SiteKeys[] = [
  {
    id: 'youtube',
    match: /youtube/i,
    commands: {
      media_play_pause: { keys: 'k', means: 'play or pause the video' },
      media_next: { keys: '{shift+n}', means: 'next video / skip to the next one' },
      media_previous: { keys: '{shift+p}', means: 'previous video' },
      media_mute: { keys: 'm', means: 'mute or unmute the video' },
      seek_back: { keys: 'j', means: 'go back 10 seconds' },
      seek_forward: { keys: 'l', means: 'skip forward 10 seconds' },
      seek_back_5: { keys: '{left}', means: 'go back 5 seconds' },
      seek_forward_5: { keys: '{right}', means: 'skip forward 5 seconds' },
      restart: { keys: '0', means: 'restart the video from the beginning' },
      volume_up: { keys: '{up}', means: 'video volume up' },
      volume_down: { keys: '{down}', means: 'video volume down' },
      fullscreen: { keys: 'f', means: 'full screen / exit full screen' },
      theater: { keys: 't', means: 'theater mode' },
      miniplayer: { keys: 'i', means: 'miniplayer / picture in picture' },
      captions: { keys: 'c', means: 'turn captions / subtitles on or off' },
      faster: { keys: '{shift+.}', means: 'play faster / increase the speed' },
      slower: { keys: '{shift+,}', means: 'play slower / decrease the speed' },
      search: { keys: '/', means: 'go to the search box on YouTube' },
      // No like or dislike here: YouTube has no key for them (Shift+= did
      // nothing, 21 Sep). "Like this video" is a click on the like button.
      next_frame: { keys: '.', means: 'next frame while paused' },
      previous_frame: { keys: ',', means: 'previous frame while paused' },
      chapter_next: { keys: '{ctrl+right}', means: 'next chapter' },
      chapter_previous: { keys: '{ctrl+left}', means: 'previous chapter' },
      shortcuts_help: { keys: '{shift+/}', means: 'show the keyboard shortcuts' },
    },
  },
  {
    id: 'spotify',
    match: /spotify/i,
    commands: {
      media_play_pause: { keys: ' ', means: 'play or pause' },
      media_next: { keys: '{ctrl+right}', means: 'next track / skip this song' },
      media_previous: { keys: '{ctrl+left}', means: 'previous track' },
      volume_up: { keys: '{ctrl+up}', means: 'volume up' },
      volume_down: { keys: '{ctrl+down}', means: 'volume down' },
      shuffle: { keys: '{ctrl+s}', means: 'shuffle on or off' },
      repeat: { keys: '{ctrl+r}', means: 'repeat on or off' },
      search: { keys: '{ctrl+k}', means: 'search on Spotify' },
      like: { keys: '{alt+shift+b}', means: 'like / save this song' },
      home: { keys: '{alt+shift+h}', means: 'go to Spotify home' },
      queue: { keys: '{alt+shift+q}', means: 'show the queue' },
      now_playing: { keys: '{alt+shift+j}', means: 'show what is playing now' },
    },
  },
  {
    id: 'gmail',
    match: /gmail|mail\.google/i,
    commands: {
      compose: { keys: 'c', means: 'compose / write a new email' },
      reply: { keys: 'r', means: 'reply to this email' },
      reply_all: { keys: 'a', means: 'reply to all' },
      forward: { keys: 'f', means: 'forward this email' },
      archive: { keys: 'e', means: 'archive this email' },
      delete: { keys: '#', means: 'delete this email' },
      mark_read: { keys: '{shift+i}', means: 'mark as read' },
      mark_unread: { keys: '{shift+u}', means: 'mark as unread' },
      star: { keys: 's', means: 'star this email' },
      snooze: { keys: 'b', means: 'snooze this email' },
      spam: { keys: '!', means: 'report as spam' },
      newer: { keys: 'k', means: 'go to the newer / next conversation' },
      older: { keys: 'j', means: 'go to the older / previous conversation' },
      open: { keys: 'o', means: 'open the selected email' },
      back_to_list: { keys: 'u', means: 'back to the inbox list' },
      search: { keys: '/', means: 'search the mail' },
      inbox: { keys: 'gi', means: 'go to the inbox' },
      starred: { keys: 'gs', means: 'go to starred emails' },
      sent: { keys: 'gt', means: 'go to sent mail' },
      drafts: { keys: 'gd', means: 'go to drafts' },
      send: { keys: '{ctrl+enter}', means: 'send the email being written' },
      select_all_list: { keys: '*a', means: 'select all conversations' },
      shortcuts_help: { keys: '{shift+/}', means: 'show the keyboard shortcuts' },
    },
  },
  {
    id: 'google_docs',
    match: /google (docs|sheets|slides)|- google docs|\.google\.com\/(document|spreadsheets|presentation)/i,
    commands: {
      bold: { keys: '{ctrl+b}', means: 'make the selection bold' },
      italic: { keys: '{ctrl+i}', means: 'make the selection italic' },
      underline: { keys: '{ctrl+u}', means: 'underline the selection' },
      heading_1: { keys: '{ctrl+alt+1}', means: 'make this a heading 1' },
      heading_2: { keys: '{ctrl+alt+2}', means: 'make this a heading 2' },
      normal_text: { keys: '{ctrl+alt+0}', means: 'make this normal text' },
      bullet_list: { keys: '{ctrl+shift+8}', means: 'bulleted list' },
      numbered_list: { keys: '{ctrl+shift+7}', means: 'numbered list' },
      link: { keys: '{ctrl+k}', means: 'insert a link' },
      comment: { keys: '{ctrl+alt+m}', means: 'add a comment' },
      find_replace: { keys: '{ctrl+h}', means: 'find and replace' },
      word_count: { keys: '{ctrl+shift+c}', means: 'show the word count' },
      align_left: { keys: '{ctrl+shift+l}', means: 'align left' },
      align_center: { keys: '{ctrl+shift+e}', means: 'center the text' },
      align_right: { keys: '{ctrl+shift+r}', means: 'align right' },
      undo: BROWSER_KEYS.undo,
      redo: { keys: '{ctrl+y}', means: 'redo' },
      select_all: BROWSER_KEYS.select_all,
      print: BROWSER_KEYS.print,
    },
  },
  {
    id: 'twitter',
    match: /\bx\.com|twitter|\/ x$/i,
    commands: {
      new_post: { keys: 'n', means: 'write a new post / tweet' },
      next_post: { keys: 'j', means: 'next post' },
      previous_post: { keys: 'k', means: 'previous post' },
      like: { keys: 'l', means: 'like this post' },
      reply: { keys: 'r', means: 'reply to this post' },
      repost: { keys: 't', means: 'repost / retweet' },
      bookmark: { keys: 'b', means: 'bookmark this post' },
      search: { keys: '/', means: 'search' },
      home: { keys: 'gh', means: 'go to the home timeline' },
      notifications: { keys: 'gn', means: 'go to notifications' },
      messages: { keys: 'gm', means: 'go to direct messages' },
      profile: { keys: 'gp', means: 'go to my profile' },
      load_new: { keys: '.', means: 'load the new posts' },
    },
  },
  {
    id: 'discord',
    match: /discord/i,
    commands: {
      search: { keys: '{ctrl+k}', means: 'find or start a conversation / jump to a channel' },
      mute_mic: { keys: '{ctrl+shift+m}', means: 'mute or unmute my microphone' },
      deafen: { keys: '{ctrl+shift+d}', means: 'deafen or undeafen' },
      mark_read: { keys: '{escape}', means: 'mark the channel as read' },
      next_unread: { keys: '{alt+shift+down}', means: 'go to the next unread channel' },
      previous_unread: { keys: '{alt+shift+up}', means: 'go to the previous unread channel' },
      next_server: { keys: '{ctrl+alt+down}', means: 'go to the next server' },
      previous_server: { keys: '{ctrl+alt+up}', means: 'go to the previous server' },
      upload: { keys: '{ctrl+shift+u}', means: 'upload a file' },
      emoji: { keys: '{ctrl+e}', means: 'open the emoji picker' },
      answer_call: { keys: '{ctrl+enter}', means: 'answer the incoming call' },
      hang_up: { keys: '{ctrl+shift+h}', means: 'hang up the call' },
    },
  },
  {
    id: 'vscode',
    match: /visual studio code|- code$|cursor$/i,
    commands: {
      command_palette: { keys: '{ctrl+shift+p}', means: 'open the command palette' },
      quick_open: { keys: '{ctrl+p}', means: 'open a file by name / quick open' },
      save: { keys: '{ctrl+s}', means: 'save the file' },
      save_all: { keys: '{ctrl+k}s', means: 'save all files' },
      find: { keys: '{ctrl+f}', means: 'find in this file' },
      find_in_files: { keys: '{ctrl+shift+f}', means: 'search across all files' },
      replace: { keys: '{ctrl+h}', means: 'find and replace' },
      terminal: { keys: '{ctrl+`}', means: 'show or hide the terminal' },
      sidebar: { keys: '{ctrl+b}', means: 'show or hide the sidebar' },
      explorer: { keys: '{ctrl+shift+e}', means: 'show the file explorer' },
      source_control: { keys: '{ctrl+shift+g}', means: 'show source control / git' },
      extensions: { keys: '{ctrl+shift+x}', means: 'show the extensions' },
      problems: { keys: '{ctrl+shift+m}', means: 'show the problems panel' },
      go_to_line: { keys: '{ctrl+g}', means: 'go to a line number' },
      go_to_definition: { keys: '{f12}', means: 'go to the definition' },
      rename_symbol: { keys: '{f2}', means: 'rename the symbol' },
      format: { keys: '{shift+alt+f}', means: 'format the document' },
      comment_line: { keys: '{ctrl+/}', means: 'comment or uncomment the line' },
      close_editor: { keys: '{ctrl+w}', means: 'close this editor tab' },
      next_editor: { keys: '{ctrl+pagedown}', means: 'next editor tab' },
      previous_editor: { keys: '{ctrl+pageup}', means: 'previous editor tab' },
      zen: { keys: '{ctrl+k}z', means: 'zen mode / distraction free' },
      split: { keys: '{ctrl+\\}', means: 'split the editor' },
      undo: BROWSER_KEYS.undo,
      redo: { keys: '{ctrl+y}', means: 'redo' },
    },
  },
  {
    id: 'slack',
    match: /slack/i,
    commands: {
      search: { keys: '{ctrl+k}', means: 'jump to a channel or person / search' },
      unreads: { keys: '{ctrl+shift+a}', means: 'show all unread messages' },
      threads: { keys: '{ctrl+shift+t}', means: 'show threads' },
      mentions: { keys: '{ctrl+shift+m}', means: 'show mentions and reactions' },
      mark_read: { keys: '{escape}', means: 'mark the channel as read' },
      mark_all_read: { keys: '{shift+escape}', means: 'mark everything as read' },
      next_unread: { keys: '{alt+shift+down}', means: 'go to the next unread channel' },
      previous_unread: { keys: '{alt+shift+up}', means: 'go to the previous unread channel' },
      upload: { keys: '{ctrl+u}', means: 'upload a file' },
      edit_last: { keys: '{up}', means: 'edit my last message' },
    },
  },
  {
    id: 'explorer',
    match: /file explorer|- explorer$|^explorer$|this pc|acest pc/i,
    commands: {
      new_folder: { keys: '{ctrl+shift+n}', means: 'create a new folder' },
      rename: { keys: '{f2}', means: 'rename the selected file' },
      delete: { keys: '{delete}', means: 'delete the selected file (to the recycle bin)' },
      delete_permanently: { keys: '{shift+delete}', means: 'delete the selected file permanently' },
      properties: { keys: '{alt+enter}', means: 'show the properties of the selected file' },
      up_folder: { keys: '{alt+up}', means: 'go up one folder' },
      back: { keys: '{alt+left}', means: 'go back' },
      forward: { keys: '{alt+right}', means: 'go forward' },
      address_bar: { keys: '{ctrl+l}', means: 'go to the address bar / type a path' },
      search: { keys: '{ctrl+f}', means: 'search in this folder' },
      new_tab: { keys: '{ctrl+t}', means: 'open a new tab' },
      close_tab: { keys: '{ctrl+w}', means: 'close this tab' },
      preview: { keys: '{alt+p}', means: 'show or hide the preview pane' },
      select_all: BROWSER_KEYS.select_all,
      copy: BROWSER_KEYS.copy,
      paste: BROWSER_KEYS.paste,
      cut: { keys: '{ctrl+x}', means: 'cut the selection' },
      undo: BROWSER_KEYS.undo,
    },
  },
];

const BROWSER_TITLE = /brave|chrome|chromium|edge|firefox|opera|vivaldi|arc/i;

/**
 * The keys the window in front answers to, from its title. A browser gets
 * the site's keys over the browser's; a known app gets its own; anything
 * else gets the keys every Windows program shares. Site keys win on a
 * conflict because they are the more specific claim.
 */
export function keysFor(title: string): { site: string | null; commands: Record<string, KeyCommand> } {
  const site = SITE_KEYS.find((s) => s.match.test(title));
  const browser = BROWSER_TITLE.test(title);
  if (site && browser) return { site: site.id, commands: { ...BROWSER_KEYS, ...site.commands } };
  if (site) return { site: site.id, commands: { ...WINDOWS_KEYS, ...site.commands } };
  return { site: null, commands: browser ? BROWSER_KEYS : WINDOWS_KEYS };
}
