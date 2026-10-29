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
