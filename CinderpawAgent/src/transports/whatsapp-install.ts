/**
 * WhatsApp support, downloaded when the person asks for it.
 *
 * The WhatsApp library (Baileys) carries libsignal, which is GPL-3.0, so it is
 * not in anything we ship (THIRD-PARTY-NOTICES.md). OpenClaw solves the same
 * thing the same way: their WhatsApp plugin is a separate package the user's
 * machine fetches from npm on request. Here the engine does it with the Bun
 * it already carries (BUN_BE_BUN turns this executable into the Bun CLI), into
 * ~/.cinderpaw/whatsapp/, then packs the library into one whatsapp.js, which
 * is the only form a compiled executable can load (see CinderpawAgent/README.md).
 *
 * The lockfile pins every one of the 69 packages to what was tested: a
 * floating install would run whatever npm serves that day.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";
import lockfile from "./whatsapp/bun.lock" with { type: "text" };

export const BAILEYS_VERSION = "7.0.0-rc13";

export function whatsappDir(): string {
  return join(cinderpawHome(), "whatsapp");
}

/** Where the downloaded library lives once packed. */
export function whatsappBundlePath(): string {
  return join(whatsappDir(), "whatsapp.js");
}

export function whatsappDownloaded(): boolean {
  return existsSync(whatsappBundlePath());
}

function run(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let err = "";
    child.stderr?.on("data", (d) => (err = (err + String(d)).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `exit ${code}`)),
    );
  });
}

/**
 * Download and pack the library. whatsapp.js appears only when both steps
 * worked, so a half-finished download never counts as installed.
 */
export async function installWhatsApp(): Promise<void> {
  const dir = whatsappDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "cinderpaw-whatsapp", private: true, dependencies: { "@whiskeysockets/baileys": BAILEYS_VERSION } }),
  );
  await writeFile(join(dir, "bun.lock"), lockfile);
  await run(["install", "--production", "--frozen-lockfile"], dir);
  const tmp = join(dir, "whatsapp.js.part");
  await rm(tmp, { force: true });
  await run(["build", "node_modules/@whiskeysockets/baileys/lib/index.js", "--target=bun", `--outfile=${tmp}`], dir);
  await rename(tmp, whatsappBundlePath());
}
