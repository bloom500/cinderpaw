/**
 * connectors_manage — the agent's self-service door into its own connectors.
 *
 * Lets the agent connect itself to Discord / Slack / WhatsApp when the user
 * asks ("connect to my Discord, here's the token") instead of bouncing the
 * user to the settings UI. Two actions:
 *
 *   list      — supported connectors, what each needs, current state
 *               (secrets REDACTED to present/absent — never echoed back)
 *   configure — upsert one connector's row in ~/.cinderpaw/connectors.json and
 *               hot-reload the ConnectorManager so it takes effect immediately
 *
 * Security posture: this is a deliberate, narrow door through the ~/.cinderpaw
 * deny wall. Generic fs tools can never touch connectors.json (call-time deny
 * in tool-permissions.ts); this tool writes ONLY that one fixed path, through
 * the same row shape the ConnectorManager reads, and every call is audited by
 * the registry like any other tool. Secrets flow one way: in. `list` output
 * and `configure` results never contain secret values.
 */

import { readFile, mkdir } from "node:fs/promises";
import { atomicWriteFile } from "../../atomic-write.ts";
import { dirname } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";
import { configPath, WhatsAppConnector, whatsappAvailable, type ConnectorRow } from "../../transports/connectors.ts";
import { sessionHasCards } from "../../core/card-surface.ts";

/**
 * What each supported connector needs to come alive, and how a person
 * actually gets it.
 *
 * `steps` exists because "bot token from the Discord Developer Portal"
 * is only useful to someone who has already been there. Without written
 * steps the model improvises the click path from training data, which
 * for a portal that changes its labels is how a user ends up on the
 * wrong page being told they are on the right one. These are checked
 * against the real portal and are the agent's source of truth; when the
 * portal moves, this list is the one place to fix.
 *
 * `consoleUrl` mirrors `crates/cinderpaw-core/src/connectors.rs` — the
 * Rust catalog has the URL for the settings UI, and the agent had no
 * way to read it, so it was guessing the address too.
 */
interface CatalogEntry {
  secrets: string[];
  note: string;
  consoleUrl?: string;
  steps?: string[];
}

/** Exported for `tests/connector-catalog-transports.test.ts`: what the agent
 *  can talk a user through has to be what the build can actually start. */
export const CATALOG: Record<string, CatalogEntry> = {
  discord: {
    secrets: ["DISCORD_TOKEN"],
    note: "Bot token from the Discord Developer Portal (Bot → Reset Token). The bot must be invited to the server with the Message Content intent enabled.",
    consoleUrl: "https://discord.com/developers/applications",
    steps: [
      "Open https://discord.com/developers/applications and sign in with your Discord account.",
      "Click 'New Application', give it a name (this is what the bot will be called), and accept the terms.",
      "Open the 'Bot' tab in the left sidebar.",
      "Under 'Privileged Gateway Intents', turn ON 'Message Content Intent' and save. Without it the bot can see that messages exist but not what they say.",
      "Click 'Reset Token', confirm, then 'Copy'. Discord shows this token exactly once — if you navigate away you have to reset it again.",
      "Paste the token in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Then open 'OAuth2' → 'URL Generator', tick 'bot', tick the 'Send Messages' and 'Read Message History' permissions, open the generated URL, and pick your server.",
    ],
  },
  slack: {
    secrets: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    note: "Socket-mode app token (xapp-…) + bot token (xoxb-…) from api.slack.com/apps.",
    consoleUrl: "https://api.slack.com/apps",
    steps: [
      "Open https://api.slack.com/apps and click 'Create New App' → 'From scratch'. Name it and pick your workspace.",
      "Open 'Socket Mode' and turn it on. Slack asks for a token name; any name works. Copy the app-level token it gives you — it starts with 'xapp-'.",
      "Open 'OAuth & Permissions' → 'Bot Token Scopes' and add: chat:write, im:history, app_mentions:read.",
      "Scroll up on the same page and click 'Install to Workspace', then approve.",
      "Copy the 'Bot User OAuth Token' — it starts with 'xoxb-'.",
      "Paste both tokens in this chat. I keep them in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
    ],
  },
  whatsapp: {
    secrets: [],
    note: "No secrets — pairing is QR-based. Enable it, then the user scans the QR code shown in the Cinderpaw app (Connectors page or TUI).",
    steps: [
      "There is nothing to copy and no token to fetch — WhatsApp pairs by QR code.",
      "Say the word and I'll enable it, then open the Connectors page in the Cinderpaw app.",
      "Scan the QR code there with WhatsApp on your phone: Settings → Linked devices → Link a device.",
    ],
  },
  // Every other transport the sidecar can run. Without an entry the agent
  // answered "unknown connector" to a person asking for Telegram.
  // ponytail: steps written from what each transport reads, not walked
  // through each portal; a portal that moved gets fixed here.
  telegram: {
    secrets: ["TELEGRAM_BOT_TOKEN"],
    note: "Bot token from @BotFather. Allowlist holds numeric Telegram user ids; a group is answered only when its chat id is in channels.",
    consoleUrl: "https://t.me/BotFather",
    steps: [
      "Open https://t.me/BotFather in Telegram and press Start.",
      "Send /newbot, then a display name, then a username ending in 'bot'.",
      "BotFather replies with a token like 123456:ABC-... Copy it. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Your own numeric user id goes in the allowlist: message @userinfobot in Telegram and it replies with it.",
      "For a group, add the bot to the group and send me the group's chat id for channels; in a private chat nothing else is needed.",
    ],
  },
  matrix: {
    secrets: ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"],
    note: "Homeserver URL and the bot account's access token. Allowlist holds full user ids like @name:matrix.org.",
    consoleUrl: "https://app.element.io",
    steps: [
      "Make a separate Matrix account for me (not your own), for example at https://app.element.io.",
      "Signed in as that account in Element: Settings, Help & About, Advanced, Access Token. Copy it.",
      "The homeserver is the address the account lives on, e.g. https://matrix.org.",
      "Send me both. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Your own full id (@you:server) goes in the allowlist; invite my account to the rooms you want me in.",
    ],
  },
  mattermost: {
    secrets: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
    note: "Server URL and a personal access token for the account the agent speaks as.",
    consoleUrl: "https://developers.mattermost.com/integrate/reference/personal-access-token/",
    steps: [
      "Personal access tokens must be enabled by the server admin (System Console, Integrations). See https://developers.mattermost.com/integrate/reference/personal-access-token/.",
      "Signed in as the account I should speak as: Profile, Security, Personal Access Tokens, Create Token. Copy the token.",
      "The URL is the address you open Mattermost at, e.g. https://chat.example.com.",
      "Send me both. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
    ],
  },
  signal: {
    secrets: ["SIGNAL_BRIDGE_URL", "SIGNAL_NUMBER"],
    note: "Needs a running signal-cli REST bridge and the phone number registered with it.",
    consoleUrl: "https://github.com/bbernhard/signal-cli-rest-api",
    steps: [
      "Signal has no bot API, so I talk through a bridge you run: https://github.com/bbernhard/signal-cli-rest-api (Docker).",
      "Register or link a phone number in that bridge, following its README. Use a number that is not your main one.",
      "Send me the bridge's address (e.g. http://localhost:8080) and that number with its country code.",
      "Your own number goes in the allowlist.",
    ],
  },
  irc: {
    secrets: ["IRC_HOST", "IRC_NICK"],
    note: "Server host and nickname; IRC_PASSWORD is optional (NickServ). Channels to join go in channels.",
    consoleUrl: "https://libera.chat",
    steps: [
      "Pick a network and its server, e.g. irc.libera.chat (see https://libera.chat).",
      "Pick a nickname for me that is not taken on that network.",
      "If the nick is registered with NickServ, send its password as IRC_PASSWORD too; otherwise skip it.",
      "Tell me which channels to join, and put your own nick in the allowlist.",
    ],
  },
  feishu: {
    secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
    note: "App id and app secret of a custom app from the Feishu/Lark developer console.",
    consoleUrl: "https://open.feishu.cn/app",
    steps: [
      "Open https://open.feishu.cn/app (Lark: open.larksuite.com/app) and create a custom app.",
      "Turn on its bot capability and give it permission to read and send messages.",
      "Under Credentials, copy the App ID and App Secret.",
      "Send me both. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Publish the app version so it can be added to chats.",
    ],
  },
  "nextcloud-talk": {
    secrets: ["NEXTCLOUD_TALK_URL", "NEXTCLOUD_TALK_USER", "NEXTCLOUD_TALK_APP_PASSWORD"],
    note: "Nextcloud server URL, the bot user's name, and an app password made in that user's Security settings.",
    consoleUrl: "https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html",
    steps: [
      "Make a separate Nextcloud user for me on your server.",
      "Signed in as that user: Settings, Security, Devices & sessions, create an app password. See https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html.",
      "Send me the server address, that user's name, and the app password. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Add that user to the Talk conversations you want me in, and put your own user name in the allowlist.",
    ],
  },
  nostr: {
    secrets: ["NOSTR_PRIVATE_KEY", "NOSTR_RELAY_URLS"],
    note: "The agent's own private key (a new one, never the user's) and comma-separated relay URLs.",
    consoleUrl: "https://nostr.how",
    steps: [
      "Make a NEW key pair for me with any Nostr client (see https://nostr.how). Never give me your own private key.",
      "Copy that new private key (nsec... or hex). Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Send the relays to use, comma-separated, e.g. wss://relay.damus.io,wss://nos.lol.",
      "Your own public key goes in the allowlist; I answer direct messages from it.",
    ],
  },
  twitch: {
    secrets: ["OAUTH_ACCESS"],
    note: "An OAuth access token with chat:read and chat:edit for the bot account. Channels to join go in channels.",
    consoleUrl: "https://dev.twitch.tv/console/apps",
    steps: [
      "Make a separate Twitch account for me, and register an app at https://dev.twitch.tv/console/apps.",
      "Signed in as my account, get a user access token for that app with the chat:read and chat:edit scopes.",
      "Send me the token. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Tell me which channels to join, and put your own Twitch login in the allowlist.",
    ],
  },
  zalo: {
    secrets: ["ZALO_BOT_TOKEN"],
    note: "Bot token from Zalo Bot Platform.",
    consoleUrl: "https://bot.zaloplatforms.com/",
    steps: [
      "Open https://bot.zaloplatforms.com/ and sign in with Zalo.",
      "Create a bot and copy its token.",
      "Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Put your own Zalo user id in the allowlist.",
    ],
  },
  // The three ported from OpenClaw last, and the only ones no one has run
  // against the real thing yet. Their steps say that out loud: a user who
  // hits a wall should know whether they mistyped something or found our bug.
  imessage: {
    secrets: [],
    note: "macOS only. Talks to Messages.app through the `imsg` bridge; nothing leaves the Mac. Needs Full Disk Access (to read chat.db) and Automation permission (to send). Optional IMESSAGE_CLI_PATH if `imsg` is not on PATH.",
    consoleUrl: "https://github.com/steipete/imsg",
    steps: [
      "This one needs a Mac that stays awake and signed in to iMessage. It cannot run from Windows or Linux: Apple has no bot API, so I read the local database.",
      "On that Mac install the bridge: `brew install steipete/tap/imsg` (what it is: https://github.com/steipete/imsg).",
      "Give the terminal (or the Cinderpaw app) Full Disk Access in System Settings, Privacy & Security, or I can see that messages exist but not what they say.",
      "The first send asks for permission to control Messages.app. Allow it, once.",
      "If `imsg` is not on PATH, send me its full path and I will store it as IMESSAGE_CLI_PATH.",
      "Put your own phone number or Apple ID in the allowlist, in the form it appears in Messages.",
      "Say honestly what happens when you enable it: this connector was written against the documented protocol and has never been run against a real Mac. If it complains, the message it prints is the bug report.",
    ],
  },
  tlon: {
    secrets: ["TLON_SHIP", "TLON_URL", "TLON_CODE"],
    note: "Direct messages on Urbit through your own ship. No public address needed, we connect out to the ship.",
    consoleUrl: "https://tlon.io",
    steps: [
      "You need a running Urbit ship, your own or one hosted by Tlon (https://tlon.io).",
      "Send me its name, the ~sampel-palnet form, and the URL where Landscape opens in your browser.",
      "In the ship's dojo type +code and copy what it prints. That is the access code, NOT the master ticket, and it is the one thing here you must never paste anywhere else. Paste it in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Put the ships allowed to DM me in the allowlist, ~sampel-palnet form. A DM from a ship nobody listed arrives as an invite and I leave it unanswered, so a stranger cannot open a conversation.",
      "Say honestly what happens when you enable it: written against Urbit's documented channel protocol, never run against a real ship. A wrong code shows up as a login failure the moment you enable, not later.",
    ],
  },
  zalouser: {
    secrets: [],
    note: "Your PERSONAL Zalo account, paired by QR like WhatsApp. Unofficial protocol (zca-js): Zalo may suspend an account it decides is automated.",
    consoleUrl: "https://chat.zalo.me",
    steps: [
      "Read this first: this connects your own Zalo account, not a bot, through a community re-implementation Zalo does not sanction. Zalo can suspend an account it decides is automated, and that is not something I can undo for you. If the account matters, use the Zalo bot connector instead.",
      "If you still want it: enable it and I write a QR code to a file, opening it in your image viewer where I can.",
      "Scan that QR with Zalo on your phone: Settings, Linked devices. The session is saved, so a restart does not ask again.",
      "Put the user ids I may answer in the allowlist, and the named groups in channels.",
      "Say honestly what happens: this one has never been paired against a real account by us.",
    ],
  },
  // The five that arrive over a webhook. Their `steps` end with the public
  // address the platform must reach, because without one they connect and
  // stay silent, which reads as broken rather than as unconfigured.
  line: {
    secrets: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
    note: "Channel access token and channel secret of a Messaging API channel. Inbound arrives on the webhook path /connectors/line.",
    consoleUrl: "https://developers.line.biz/console/",
    steps: [
      "Open https://developers.line.biz/console/ and create a provider, then a Messaging API channel.",
      "In the channel's Messaging API tab, issue a long-lived channel access token and copy it.",
      "In the Basic settings tab, copy the channel secret.",
      "Send it to me in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "Then set the channel's Webhook URL to your public address + /connectors/line and turn 'Use webhook' on. This one is INBOUND-ONLY over a webhook: the platform has to reach your machine, so it needs a public HTTPS address pointing at Cinderpaw (a tunnel or a reverse proxy). Without that it connects and never hears anything.",
    ],
  },
  sms: {
    secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_WEBHOOK_URL"],
    note: "Twilio account SID, auth token, the number messages are sent from, and the exact public URL you configured on that number (the signature is computed over it).",
    consoleUrl: "https://console.twilio.com",
    steps: [
      "Open https://console.twilio.com and copy the Account SID and Auth Token from the dashboard.",
      "Buy or pick a phone number with SMS capability and copy it in full international form.",
      "Set that number's 'A message comes in' webhook to your public address + /connectors/sms, method POST.",
      "Send me all four: SID, auth token, the number, and that exact URL. The URL is part of how the signature is checked, so it must match character for character. This one is INBOUND-ONLY over a webhook: the platform has to reach your machine, so it needs a public HTTPS address pointing at Cinderpaw (a tunnel or a reverse proxy). Without that it connects and never hears anything.",
    ],
  },
  "synology-chat": {
    secrets: ["SYNOLOGY_CHAT_WEBHOOK_URL", "SYNOLOGY_CHAT_TOKEN"],
    note: "The NAS's incoming-webhook URL (we POST to it) and the outgoing-webhook token (it POSTs to us).",
    consoleUrl: "https://www.synology.com/en-global/dsm/feature/chat",
    steps: [
      "In Synology Chat on your NAS (what it is: https://www.synology.com/en-global/dsm/feature/chat), open the profile menu, Integration, and create an Incoming Webhook. Copy the URL it gives you.",
      "In the same place create an Outgoing Webhook pointing at your public address + /connectors/synology-chat, and copy its token.",
      "Send me both. Send it to me in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "This one is INBOUND-ONLY over a webhook: the platform has to reach your machine, so it needs a public HTTPS address pointing at Cinderpaw (a tunnel or a reverse proxy). Without that it connects and never hears anything.",
    ],
  },
  googlechat: {
    secrets: ["GOOGLE_CHAT_PROJECT_NUMBER", "GOOGLE_CHAT_SERVICE_ACCOUNT"],
    note: "The Google Cloud project number and a service-account key JSON. Inbound requests are verified by the signed token Google sends.",
    consoleUrl: "https://console.cloud.google.com/apis/library/chat.googleapis.com",
    steps: [
      "Open https://console.cloud.google.com/apis/library/chat.googleapis.com and enable the Google Chat API in a project.",
      "In the Chat API's Configuration tab, create the app and set Connection settings to 'HTTP endpoint URL' = your public address + /connectors/googlechat.",
      "Copy the project NUMBER from the project's dashboard (the number, not the id).",
      "Create a service account in that project, add a JSON key, and send me the whole JSON plus the project number. Send it to me in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "This one is INBOUND-ONLY over a webhook: the platform has to reach your machine, so it needs a public HTTPS address pointing at Cinderpaw (a tunnel or a reverse proxy). Without that it connects and never hears anything.",
    ],
  },
  msteams: {
    secrets: ["MSTEAMS_APP_ID", "MSTEAMS_APP_PASSWORD"],
    note: "Bot Framework app id and password (client secret); MSTEAMS_TENANT_ID as well for a single-tenant bot.",
    consoleUrl: "https://dev.botframework.com",
    steps: [
      "Register a bot at https://dev.botframework.com (or an Azure Bot resource) and copy its Microsoft App ID.",
      "Create a client secret for that app registration and copy its value; it is shown once.",
      "Set the bot's messaging endpoint to your public address + /connectors/msteams.",
      "Send me the app id and the secret, and the tenant id too if the bot is single-tenant. Send it to me in this chat. I keep it in a private file on this computer and out of my memory, but the AI service I use sees that one message. In the Cinderpaw page I give you a secure box instead.",
      "This one is INBOUND-ONLY over a webhook: the platform has to reach your machine, so it needs a public HTTPS address pointing at Cinderpaw (a tunnel or a reverse proxy). Without that it connects and never hears anything.",
    ],
  },
};

/** Connectors connectors_pair can let someone into by hearing their first message
 *  (their transports report senders, see `ConnectorContext.onSender`), with the
 *  name the person knows them by. */
export const PAIRABLE: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
};

/** Sentences that ask for a secret in the chat, or describe what happens to one pasted there. */
const ASKS_FOR_PASTE = /in this chat|^send me |private file on this computer|secure box instead/i;

/**
 * The steps as this chat should hear them. Where the page can show a secure
 * field, every "paste it here" becomes "call request_secret": seen live, an
 * agent with the paste sentence still in front of it used it the moment the
 * field was declined, and a token typed into the chat reaches the AI service.
 */
export function stepsFor(id: string, cards: boolean): string[] {
  const entry = CATALOG[id];
  const steps = entry?.steps ?? [];
  if (!cards || !entry) return steps;
  const fields = entry.secrets.join(" and ");
  return steps.map((step) => {
    const sentences = step.split(/(?<=[.!?;])\s+/);
    const kept = sentences.filter((x) => !ASKS_FOR_PASTE.test(x));
    if (kept.length === sentences.length) return step;
    const ask = `Then call request_secret for ${fields}. It opens a secure box on this page. Never ask for these in the chat.`;
    return [...kept, ask].join(" ");
  });
}

/**
 * Secrets the host holds in the keychain, which connectors.json no longer
 * shows once the host has moved them there. Set when the tool is built.
 * ponytail: module-level, one manager per process.
 */
let hostHas: (id: string, key: string) => boolean = () => false;

const has = (row: ConnectorRow | undefined, id: string, k: string) =>
  Boolean(row?.secrets?.[k]?.trim() || (id === "discord" && row?.token?.trim()) || hostHas(id, k));

const redact = (row: ConnectorRow | undefined, id: string, cards = false) => ({
  id,
  enabled: row?.enabled ?? false,
  configured: CATALOG[id]!.secrets.map((k) => ({
    secret: k,
    present: has(row, id, k),
  })),
  allowlist: row?.allowlist ?? [],
  channels: row?.channels ?? [],
  ...(row?.mode ? { mode: row.mode } : {}),
  requires: CATALOG[id]!.secrets,
  note: CATALOG[id]!.note,
  ...(CATALOG[id]!.consoleUrl ? { consoleUrl: CATALOG[id]!.consoleUrl } : {}),
  ...(CATALOG[id]!.steps ? { steps: stepsFor(id, cards) } : {}),
  ...(id === "whatsapp" && !whatsappAvailable() ? { available: false, why: WHATSAPP_MISSING } : {}),
});

/** Said instead of an error: seen live 25 Sep, the raw "optional external
 *  dependency" error sent the agent searching the person's folders for it. */
const WHATSAPP_MISSING =
  "WhatsApp is not included in this version of Cinderpaw (its library has a license we cannot ship). " +
  "Discord and Telegram work right away. Offer one of those instead; do not look for the library yourself.";

export async function readRows(): Promise<ConnectorRow[]> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8")) as {
      connectors?: ConnectorRow[];
    };
    return Array.isArray(parsed.connectors) ? parsed.connectors : [];
  } catch {
    return []; // no file yet
  }
}

async function writeRows(rows: ConnectorRow[]): Promise<void> {
  const file = configPath();
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify({ connectors: rows }, null, 2));
}

/** Add one person to a connector's allowlist, keeping everyone already on it. */
export async function allowSender(id: string, userId: string): Promise<void> {
  const rows = await readRows();
  const row: ConnectorRow = rows.find((r) => r.id === id) ?? { id };
  const allow = row.allowlist ?? [];
  if (!allow.includes(userId)) row.allowlist = [...allow, userId];
  await writeRows([...rows.filter((r) => r.id !== id), row]);
}

/** Is this secret stored for this connector? Never returns the value. */
export async function secretPresent(connector: string, field: string): Promise<boolean> {
  const row = (await readRows()).find((r) => r.id === connector);
  return redact(row, connector).configured.some((c) => c.secret === field && c.present);
}

export function createConnectorsManageTool(
  manager: { reload(): Promise<void>; hasHostSecret?(id: string, key: string): boolean; pairWhatsApp?(): Promise<boolean> },
  isLinked: () => boolean = WhatsAppConnector.isLinked,
  hasWhatsApp: () => boolean = whatsappAvailable,
): Tool {
  if (manager.hasHostSecret) hostHas = (id, key) => manager.hasHostSecret!(id, key);
  const manifest: ToolManifest = {
    name: "connectors_manage",
    description:
      "Configure YOUR OWN messaging connectors (Discord, Slack, WhatsApp, Telegram, Matrix and more; 'list' names all) — the " +
      "accounts you yourself speak through. This does NOT configure any other " +
      "bot: if the user asks you to set up a different bot, this tool changes " +
      "you instead, and the usual result is that you go silent. Use action " +
      "'list' to see what's supported and what each needs; 'configure' with an " +
      "id (and secrets/allowlist if required) to connect or disconnect. Changes " +
      "apply immediately. Secrets are stored, never echoed. " +
      "When a user asks how to connect you to something, call 'list' FIRST and " +
      "walk them through the returned 'steps' verbatim, except that wherever a step says to paste or send a secret you call request_secret first (it shows a secure field when the chat can) and only fall back to the paste if it returns unsupported_surface — they are checked " +
      "against the real console and your own recollection of these portals is " +
      "probably out of date. Give the steps a few at a time, wait at the one " +
      "that says to paste a token, and never invent a step that isn't there.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "'list' or 'configure'.",
        required: true,
      },
      id: {
        type: "string",
        description: "Connector id, as 'list' returns it (discord, slack, whatsapp, telegram, ...). Required for 'configure'.",
        required: false,
      },
      enabled: {
        type: "boolean",
        description: "Turn the connector on/off (configure).",
        required: false,
      },
      secrets: {
        type: "object",
        description:
          "Secret values keyed by name, e.g. {\"DISCORD_TOKEN\":\"…\"}. Merged into the stored config (configure).",
        required: false,
        schema: { type: "object", additionalProperties: { type: "string" } },
      },
      allowlist: {
        type: "array",
        description:
          "The ONLY user ids this connector answers (configure). Not a filter on " +
          "top of an open door — it IS the door: an id that is not listed gets no " +
          "reply at all. An empty list therefore means NOBODY, not everyone, and " +
          "is refused. Send the full list you want, including yourself.",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
      channels: {
        type: "array",
        description: "Channel ids the connector listens on (configure).",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
    },
    async execute(args, ctx) {
      const action = typeof args.action === "string" ? args.action : "";

      if (action === "list") {
        const rows = await readRows();
        return {
          ok: true,
          content: JSON.stringify(
            Object.keys(CATALOG).map((id) => redact(rows.find((r) => r.id === id), id, sessionHasCards(ctx?.sessionId ?? ""))),
            null,
            2,
          ),
        };
      }

      if (action !== "configure") {
        return { ok: false, content: "action must be 'list' or 'configure'.", error: "bad_args" };
      }
      const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
      if (!CATALOG[id]) {
        return {
          ok: false,
          content: `unknown connector "${id}" — supported: ${Object.keys(CATALOG).join(", ")}`,
          error: "bad_args",
        };
      }

      if (id === "whatsapp" && args.enabled === true && !hasWhatsApp()) {
        return { ok: false, content: WHATSAPP_MISSING, error: "not_included" };
      }
      const rows = await readRows();
      const row: ConnectorRow = rows.find((r) => r.id === id) ?? { id };
      if (typeof args.enabled === "boolean") row.enabled = args.enabled;
      if (args.secrets && typeof args.secrets === "object" && !Array.isArray(args.secrets)) {
        row.secrets = { ...row.secrets };
        for (const [k, v] of Object.entries(args.secrets as Record<string, unknown>)) {
          if (typeof v === "string" && v.trim()) row.secrets[k] = v.trim();
        }
      }
      if (Array.isArray(args.allowlist)) {
        const next = (args.allowlist as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((s) => s.trim())
          .filter(Boolean);
        // An empty allowlist is not "everyone" — it is NOBODY.
        //
        // `ConnectorManager` builds `new Set(allowlist)` and answers only ids in
        // it, so clearing the list makes the connector deaf to every human,
        // including whoever is asking. This is not hypothetical: on 2026-08-14
        // this agent cleared its own Discord allowlist, announced "orice user
        // primește răspuns", and went silent for four hours. The only signal was
        // `(0 allowed)` in a log line nobody reads.
        //
        // Refused rather than corrected, because the two things the caller might
        // have meant — "let everyone in" and "lock it down" — are opposites, and
        // guessing between them is how the bot goes quiet again.
        if (next.length === 0 && (row.allowlist?.length ?? 0) > 0) {
          return {
            ok: false,
            content:
              `Refusing to empty ${id}'s allowlist. Empty does NOT mean "everyone" — ` +
              `the connector answers only ids on the list, so clearing it makes ${id} ` +
              `ignore every message, including yours, with no error anywhere. ` +
              `To keep it open to specific people, pass their ids. To take someone off, ` +
              `pass the list without them. Current list: ${JSON.stringify(row.allowlist)}.`,
            error: "would_lock_out",
          };
        }
        row.allowlist = next;
      }
      if (Array.isArray(args.channels)) {
        row.channels = (args.channels as unknown[]).filter((x): x is string => typeof x === "string");
      }

      await writeRows([...rows.filter((r) => r.id !== id), row]);
      await manager.reload();
      // An enabled WhatsApp with no phone linked stays idle on purpose (no QR
      // nobody asked for). Turning it on here IS the asking, and before this
      // nothing called pair at all: no surface could link a phone on a fresh
      // machine.
      const pairing = id === "whatsapp" && row.enabled === true && !isLinked() && (await manager.pairWhatsApp?.()) === true;

      const missing = CATALOG[id]!.secrets.filter((k) => !has(row, id, k));
      const state = redact(row, id);
      // An enabled connector with nobody on the allowlist is the failure this
      // whole file now guards against, and refusing it outright is not an
      // option: on a first connection the user may not know their own id yet,
      // and blocking here would leave them unable to connect at all. So it
      // saves, and says — in the result the model reads, not only in a log line
      // it never sees — that the bot it just brought online answers no one.
      const deaf = row.enabled && (row.allowlist?.length ?? 0) === 0;
      const hint =
        row.enabled && missing.length > 0
          ? ` Still missing secrets: ${missing.join(", ")} — the connector stays offline until provided.`
          : pairing
            // Before the allowlist: nobody can message a WhatsApp that has no phone yet.
            ? " A QR code is on its way to the Cinderpaw page (in the terminal chat: /connectors qr). " +
              "Tell the user: on your phone open WhatsApp, then Settings, Linked devices, Link a device, and point the camera at the code."
            : deaf
              ? ` WARNING: ${id} is online but its allowlist is EMPTY, which means it ` +
                `answers NOBODY — not "everyone". ` +
                (PAIRABLE[id]
                  ? `Tell the user to send the bot a direct message now, then call connectors_pair ` +
                    `with id "${id}": it asks them "Is that you?" and lets them in, no user id needed.`
                  : `Ask the user for their ${id} user id and call configure again with ` +
                    `allowlist:["<their id>"], or the bot will look connected and silently ignore ` +
                    `every message, including theirs.`)
              : id === "whatsapp" && row.enabled
                ? " WhatsApp pairs via QR — tell the user to scan the code in the Cinderpaw app (Connectors page or TUI)."
                : "";
      return {
        ok: true,
        content: `Saved and reloaded.${hint}\n${JSON.stringify(state, null, 2)}`,
        data: state,
      };
    },
  };
}
