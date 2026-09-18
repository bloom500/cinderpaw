/**
 * Every transport this build can start, in one list.
 *
 * Importing a transport module runs its `registerTransport(...)` as a side
 * effect, so "which connectors exist" was, until now, whichever imports
 * `boot.ts` happened to carry. `tests/connector-catalog-transports.test.ts`
 * kept a second copy of that list to check the first one, which meant the
 * test could only catch a drift both lists made together — and that is
 * exactly what happened: iMessage, Tlon and Zalo Personal were written,
 * registered and tested, and then imported by nobody. They were dead code in
 * the shipped binary and absent from the agent's own catalog for four days,
 * with no failure anywhere, because the test's list was missing them too.
 *
 * One list. `boot.ts` imports this file, the test imports this file, so a
 * transport that is not here is visibly not shipped.
 */

import "./connectors.ts"; // discord, slack, whatsapp
import "./feishu.ts";
import "./googlechat.ts";
import "./irc.ts";
import "./line.ts";
import "./matrix.ts";
import "./mattermost.ts";
import "./msteams.ts";
import "./nextcloud-talk.ts";
import "./nostr.ts";
import "./signal.ts";
import "./sms.ts";
import "./synology-chat.ts";
import "./telegram.ts";
import "./tlon.ts";
import "./twitch.ts";
import "./zalo.ts";
import "./zalouser.ts";

// iMessage registers through a call, not a side effect: it was written to be
// switched on the day a Mac had proven it, and that day is a one-line change
// here rather than a hunt through the module.
import { registerImessage } from "./imessage.ts";

registerImessage();
