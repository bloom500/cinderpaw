/**
 * Publish new Evolution Journal rows to the public Cubby Journal.
 *
 *   bun scripts/publish-public-journal.ts            # one pass, then exit
 *   bun scripts/publish-public-journal.ts --watch    # keep publishing
 *   bun scripts/publish-public-journal.ts --dry-run  # print, send nothing
 *
 * Environment (see docs/public-journal.md):
 *   FERAL_PUBLIC_JOURNAL_URL    https endpoint of the landing-page ingest route
 *   FERAL_PUBLIC_JOURNAL_TOKEN  shared secret, must match the site's
 *   FERAL_PUBLIC_JOURNAL_PUBLISHER  "cubby" (default) or "paw"
 *
 * Run it on a timer rather than as a service if you prefer — it is stateless
 * apart from the cursor file, so a missed run only delays events.
 */

import {
  buildPayload,
  collectEvents,
  configFromEnv,
  readCursor,
  runExport,
  WORKING_WINDOW_MS,
} from "../src/public-journal/exporter.ts";

/** How often --watch publishes. Also the heartbeat rate, so the site's
 *  staleness threshold must be a comfortable multiple of it. */
const WATCH_INTERVAL_MS = 60_000;

async function once(dryRun: boolean): Promise<void> {
  const config = configFromEnv();

  if (dryRun) {
    const cursor = readCursor(config.cursorFile);
    const collected = collectEvents({
      journalDir: config.journalDir,
      publisher: config.publisher,
      since: cursor.lastTimestamp,
      limit: config.limit,
    });
    const payload = buildPayload({
      publisher: config.publisher,
      events: collected.events,
      now: Date.now(),
      newestTimestamp: collected.newestTimestamp,
      agentVersion: config.agentVersion,
    });
    console.log(JSON.stringify(payload, null, 2));
    console.log(
      `\n[dry-run] ${collected.events.length} event(s), ${collected.skipped} skipped, ` +
        `cursor would advance to ${collected.cursor.lastTimestamp}. Nothing was sent.`,
    );
    return;
  }

  const result = await runExport(config);
  console.log(
    `published ${result.sent} event(s) — accepted ${result.accepted}, ` +
      `duplicate ${result.duplicates}, skipped ${result.skipped} (HTTP ${result.status})`,
  );
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

if (args.has("--watch")) {
  console.log(
    `watching; publishing every ${WATCH_INTERVAL_MS / 1000}s ` +
      `(activity within ${WORKING_WINDOW_MS / 60000}min reports as "working")`,
  );
  // A failed pass must not kill the watcher: the endpoint may be redeploying,
  // the laptop may have just woken with no network yet. Log and try again.
  const tick = async () => {
    try {
      await once(dryRun);
    } catch (err) {
      console.error("publish failed:", err instanceof Error ? err.message : err);
    }
  };
  await tick();
  setInterval(tick, WATCH_INTERVAL_MS);
} else {
  await once(dryRun);
}
