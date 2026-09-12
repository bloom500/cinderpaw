import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Compile the real entry point: a source-only assertion misses transitive imports.
test("default executable contains no libsignal implementation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-no-signal-"));
  try {
    const binary = join(dir, process.platform === "win32" ? "agent.exe" : "agent");
    const build = Bun.spawnSync([
      process.execPath, "build", "src/index.ts", "--compile", "--outfile", binary,
    ], { cwd: resolve(import.meta.dir, ".."), timeout: 120_000 });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const contents = readFileSync(binary).toString("latin1");
    expect(contents.match(/libsignal|Closing session:|SessionBuilder/g)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 150_000);

test("compiled WhatsApp loader supports the external installation and explains missing configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-external-wa-"));
  try {
    const entry = join(dir, "probe.ts");
    const binary = join(dir, process.platform === "win32" ? "probe.exe" : "probe");
    const connector = resolve(import.meta.dir, "../src/transports/connectors.ts").replaceAll("\\", "/");
    writeFileSync(entry, `
      import { loadWhatsAppModule } from ${JSON.stringify(connector)};
      try {
        const wa = await loadWhatsAppModule();
        if (typeof wa.default !== "function" || typeof wa.useMultiFileAuthState !== "function"
            || typeof wa.DisconnectReason.loggedOut !== "number") throw new Error("Invalid Baileys exports");
        const auth = await wa.useMultiFileAuthState("./wa-auth");
        if (!auth.state.creds.noiseKey.private.length) throw new Error("Missing auth key");
        await auth.saveCreds();
        const restored = await wa.useMultiFileAuthState("./wa-auth");
        if (!Buffer.from(restored.state.creds.noiseKey.private).equals(auth.state.creds.noiseKey.private))
          throw new Error("Auth key did not survive persistence");
        console.log("external WhatsApp loaded");
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
      }
    `);
    const build = Bun.spawnSync([
      process.execPath, "build", entry, "--compile", "--outfile", binary,
    ], { timeout: 120_000 });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    // The probe uses the production loader, with the real package, without opening a socket.
    const installed = fileURLToPath(import.meta.resolve("@whiskeysockets/baileys"));
    const addon = join(dir, "whatsapp.js");
    const addonBuild = Bun.spawnSync([
      process.execPath, "build", installed, "--target=bun", "--outfile", addon,
    ], { timeout: 120_000 });
    expect(addonBuild.exitCode, addonBuild.stderr.toString()).toBe(0);
    const loaded = Bun.spawnSync([binary], {
      cwd: dir, env: { ...process.env, CINDERPAW_WHATSAPP_MODULE: addon }, timeout: 30_000,
    });
    expect(loaded.exitCode, loaded.stderr.toString()).toBe(0);
    expect(loaded.stdout.toString()).toContain("external WhatsApp loaded");
    for (const setting of ["", "relative/index.js"]) {
      const missing = Bun.spawnSync([binary], {
        cwd: dir, env: { ...process.env, CINDERPAW_WHATSAPP_MODULE: setting }, timeout: 30_000,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain("WhatsApp is an optional external dependency");
      expect(missing.stderr.toString()).toContain("CINDERPAW_WHATSAPP_MODULE");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 150_000);
