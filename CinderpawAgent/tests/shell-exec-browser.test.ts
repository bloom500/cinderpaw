/**
 * A browser started from a command runs on Cinderpaw's own profile, never the
 * person's (smoke test, 7 Nov: Chrome ran in the background on his profile,
 * mail signed in, to take one screenshot). Any browser: he uses Brave.
 */
import { describe, expect, it } from "bun:test";
import { launchedBrowser, ownBrowserProfileRefusal } from "../src/tools/builtin/shell-exec.ts";
import { fallbackBrowserProfile } from "../src/tools/fallback-browser.ts";

describe("a browser from a command", () => {
  it("is recognised in any family, however it is spelled, and grep is not a browser", () => {
    expect(launchedBrowser(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "--headless"])).toEqual({ name: "chrome", family: "chromium" });
    expect(launchedBrowser(["C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", "https://a.ro"])).toEqual({ name: "brave", family: "chromium" });
    expect(launchedBrowser(["powershell", "-Command", "Start-Process firefox -ArgumentList 'https://a.ro'"])).toEqual({ name: "firefox", family: "firefox" });
    expect(launchedBrowser(["cmd", "/c", "start opera https://a.ro"])).toEqual({ name: "opera", family: "chromium" });
    expect(launchedBrowser(["open", "-a", "Brave Browser", "https://a.ro"])).toEqual({ name: "brave", family: "chromium" });
    expect(launchedBrowser(["grep", "chrome", "notes.txt"])).toBeNull();
  });

  it("on the person's profile is refused with that browser's own flag; on Cinderpaw's it runs", () => {
    expect(ownBrowserProfileRefusal(["brave.exe", "https://a.ro"])).toContain(`--user-data-dir="${fallbackBrowserProfile("brave")}"`);
    expect(ownBrowserProfileRefusal(["firefox.exe", "https://a.ro"])).toContain(`-profile "${fallbackBrowserProfile("firefox")}" -no-remote`);
    // Pointing at the person's own data folder is the same thing, said differently.
    expect(ownBrowserProfileRefusal(["chrome.exe", "--user-data-dir=C:\\Users\\d\\AppData\\Local\\Google\\Chrome\\User Data"])).not.toBeNull();
    expect(ownBrowserProfileRefusal(["firefox", "-profile", "C:\\Users\\d\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x.default"])).not.toBeNull();
    expect(ownBrowserProfileRefusal(["brave.exe", `--user-data-dir=${fallbackBrowserProfile("brave")}`, "https://a.ro"])).toBeNull();
    expect(ownBrowserProfileRefusal(["firefox", "-profile", fallbackBrowserProfile("firefox"), "-no-remote"])).toBeNull();
    expect(ownBrowserProfileRefusal(["git", "status"])).toBeNull();
  });
});
