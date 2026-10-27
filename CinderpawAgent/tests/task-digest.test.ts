import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDigest, maybeSendDigest } from "../src/cron/digest.ts";
import type { CronJob, CronRunRecord } from "../src/types.ts";

const NOW = new Date(2026, 9, 27, 20, 30).getTime();
const HOUR = 60 * 60 * 1000;

function job(name: string, kind: CronJob["kind"], history: CronRunRecord[]): CronJob {
  return { id: name, name, task: name, kind, schedule: { kind: "every", intervalMs: HOUR }, delivery: { kind: "chat", sessionId: "s" }, enabled: true, history } as CronJob;
}
const run = (hoursAgo: number, status: CronRunRecord["status"], extra: Partial<CronRunRecord> = {}): CronRunRecord =>
  ({ runAt: NOW - hoursAgo * HOUR, status, durationMs: 10, ...extra });

describe("the daily task digest", () => {
  it("says what ran, what a watch found and what failed with its reason", () => {
    const text = buildDigest([
      job("Lalele watch", "watch", [run(6, "success", { proof: { sourceUrl: "https://florarie.ro", checkedAt: NOW, excerpt: "75 lei", contentHash: "h" } })]),
      job("Morning news", "agent", [run(30, "success"), run(12, "success"), run(2, "success")]),
      job("Weekly report", "agent", [run(3, "failed", { error: "The provider refused: rate limit reached." })]),
      job("Old one", "reminder", [run(40, "success")]),
    ], NOW - 24 * HOUR)!;
    expect(text).toContain("4 runs, 1 needs a look.");
    expect(text).toContain("Lalele watch: found it");
    expect(text).toContain("Morning news: done");
    expect(text).toContain("(2 runs)");
    expect(text).toContain("⚠️ Weekly report: failed");
    expect(text).toContain("rate limit reached");
    expect(text).not.toContain("Old one");
  });

  it("is nothing on a day nothing ran", () => {
    expect(buildDigest([job("Old", "agent", [run(30, "success")])], NOW - 24 * HOUR)).toBeNull();
  });

  describe("sending", () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "digest-")); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("goes once a day, after the hour, and waits for someone to reach", async () => {
      const file = join(dir, "sent");
      const jobs = () => [job("News", "agent", [run(1, "success")])];
      const sent: string[] = [];
      const send = async (t: string) => { sent.push(t); return "telegram"; };
      expect(await maybeSendDigest({ hour: 21, jobs, send, now: NOW, file })).toBeNull(); // 20:30 < 21:00
      // Nobody to send to: not marked, so it goes once a messenger connects.
      expect(await maybeSendDigest({ hour: 20, jobs, send: async () => null, now: NOW, file })).toBeNull();
      expect(await maybeSendDigest({ hour: 20, jobs, send, now: NOW, file })).toContain("News: done");
      expect(await maybeSendDigest({ hour: 20, jobs, send, now: NOW + 10 * 60_000, file })).toBeNull(); // already today
      expect(sent).toHaveLength(1);
    });
  });
});
