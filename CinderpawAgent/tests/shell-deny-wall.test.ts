/**
 * The file tools' deny wall, for the shell too. Seen live 25 Sep: asked to
 * connect WhatsApp, the agent read ~/.cinderpaw/connectors.json through
 * PowerShell, a file its own file tools would have refused.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cinderpawHome } from "../src/config.ts";
import { shellReachesDenied } from "../src/tools/builtin/shell-exec.ts";

const profile = cinderpawHome();

test("the exact command from 25 Sep is refused", () => {
  const cmd = `Get-Content '${join(homedir(), ".cinderpaw", "connectors.json")}' -Raw`;
  expect(shellReachesDenied(["powershell", "-NoProfile", "-Command", cmd])).not.toBeNull();
});

test("the running profile, ~/.ssh, and the shortcuts people write are all walled", () => {
  for (const argv of [
    ["cat", join(profile, "byok.json")],
    ["type", join(homedir(), ".ssh", "id_ed25519")],
    ["sh", "-c", "cat ~/.cinderpaw/connectors.json"],
    ["powershell", "-Command", "Get-ChildItem $env:USERPROFILE\\.cinderpaw"],
    ["cmd", "/c", "type %USERPROFILE%\\.cinderpaw\\settings.json"],
    ["powershell", "-Command", "Get-Content .cinderpaw/byok.json"],
  ]) expect(shellReachesDenied(argv)).not.toBeNull();
});

test("the agent's own workspace and skills stay open", () => {
  expect(shellReachesDenied(["dir", join(profile, "workspace", "notes")])).toBeNull();
  expect(shellReachesDenied(["cat", join(profile, "skills", "x", "SKILL.md")])).toBeNull();
  expect(shellReachesDenied(["sh", "-c", "ls ~/.cinderpaw/workspace"])).toBeNull();
});

test("ordinary commands, and names that only look alike, pass", () => {
  expect(shellReachesDenied(["git", "status"])).toBeNull();
  expect(shellReachesDenied(["cat", join(homedir(), "Documents", "cinderpaw-notes.txt")])).toBeNull();
  expect(shellReachesDenied(["ls", join(homedir(), ".cinderpaw-old-backup")])).toBeNull();
});

test("a profile reached through a link is walled by the name the command uses", () => {
  // macOS tmp dirs are /var -> /private/var: the command says one, realpath the other.
  const real = mkdtempSync(join(tmpdir(), "cp-real-"));
  const link = join(tmpdir(), `cp-link-${process.pid}`);
  symlinkSync(real, link, "junction");
  const prev = process.env.CINDERPAW_HOME;
  process.env.CINDERPAW_HOME = link;
  try {
    expect(shellReachesDenied(["cat", join(link, "byok.json")])).not.toBeNull();
    expect(shellReachesDenied(["cat", join(link, "workspace", "notes.md")])).toBeNull();
  } finally {
    if (prev === undefined) delete process.env.CINDERPAW_HOME;
    else process.env.CINDERPAW_HOME = prev;
    rmSync(link, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
