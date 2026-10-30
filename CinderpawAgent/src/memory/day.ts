/**
 * The user's own calendar day as `YYYY-MM-DD`, in this machine's time zone.
 * `toISOString()` gives London's day: from midnight to 02:00 or 03:00 in
 * Romania the agent was told it was still yesterday ("azi, miercuri 28" on
 * Thursday the 29th, 29 Oct 2026).
 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const OS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const MODE: Record<string, string> = {
  read_only: "Look only. You may read files and the web but change nothing on this computer. If the task needs a change, say so and ask the person to pick Can edit files or Full access under the box where they type.",
  workspace_write: "Can edit files. You may change files inside the workspace folders; outside them you only read.",
  full_access: "Full access. You may work in every folder; anything that cannot be undone still asks the person first, and the folders with keys stay closed.",
};

/**
 * Where the agent is, sent with every message. It knew the date but not the
 * hour, guessed the operating system from nothing, and learned its permission
 * mode only by being refused, one wasted step (and on a cloud model, money) at
 * a time (29 Oct 2026).
 */
export function situation(ts: number, platform: string, mode: string): string {
  const d = new Date(ts);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  return [
    "## Right now",
    `- Local time: ${weekday} ${localDay(ts)}, ${clock} (${zone}).`,
    `- This computer runs ${OS[platform] ?? platform}.`,
    `- What you may do: ${MODE[mode] ?? mode}`,
  ].join("\n");
}
