import type { Database } from "bun:sqlite";
import type { SpendAccount } from "./inference-spend-authority.ts";

const MICRO_USD = 1_000_000;

export interface ChatSpendView {
  limitUsd: number | null;
  usedUsd: number;
}

type Row = { limit_micro_usd: number | null; used_micro_usd: number };

/** A hold must survive a crash: the provider may already have charged for it. */
export class ChatSpendRepo {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_spending (
      session_id TEXT PRIMARY KEY,
      limit_micro_usd INTEGER,
      used_micro_usd INTEGER NOT NULL DEFAULT 0
    )`);
  }

  get(sessionId: string): ChatSpendView {
    const row = this.db.query<Row, [string]>(
      "SELECT limit_micro_usd, used_micro_usd FROM chat_spending WHERE session_id = ?",
    ).get(sessionId);
    return {
      limitUsd: row?.limit_micro_usd == null ? null : row.limit_micro_usd / MICRO_USD,
      usedUsd: (row?.used_micro_usd ?? 0) / MICRO_USD,
    };
  }

  setLimit(sessionId: string, limitUsd: number | null): ChatSpendView {
    const limit = limitUsd === null ? null : Math.round(limitUsd * 100);
    if (limitUsd !== null && limit !== null &&
      (!Number.isSafeInteger(limit * 10_000) || limitUsd < 0 || Math.abs(limit / 100 - limitUsd) > 1e-9)) {
      throw new Error("Enter a valid dollar amount with at most two decimal places.");
    }
    this.db.query(`INSERT INTO chat_spending (session_id, limit_micro_usd) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET limit_micro_usd = excluded.limit_micro_usd`)
      .run(sessionId, limit === null ? null : limit * 10_000);
    return this.get(sessionId);
  }

  account(sessionId: string): SpendAccount {
    return {
      hold: (usd) => {
        const amount = Math.ceil(usd * MICRO_USD);
        if (!Number.isSafeInteger(amount) || amount < 0) return false;
        if (amount === 0) return true;
        return this.db.query(`UPDATE chat_spending SET used_micro_usd = used_micro_usd + ?
          WHERE session_id = ? AND (limit_micro_usd IS NULL OR used_micro_usd + ? <= limit_micro_usd)`)
          .run(amount, sessionId, amount).changes === 1;
      },
      settle: (held, actual) => {
        const amount = Math.ceil(actual * MICRO_USD);
        if (!Number.isSafeInteger(amount) || amount < 0) return;
        const delta = amount - Math.ceil(held * MICRO_USD);
        if (delta) this.db.query("UPDATE chat_spending SET used_micro_usd = used_micro_usd + ? WHERE session_id = ?")
          .run(delta, sessionId);
      },
    };
  }
}

export function isOpenRouterChatTarget(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://openrouter.ai" && url.pathname.replace(/\/$/, "") === "/api" &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Subagent ids can nest. Their generated suffix is not part of the chat id. */
export function chatSessionOf(sessionId: string, teammateThread: (id: string) => string | null): string {
  while (sessionId.startsWith("subagent:")) {
    const separator = sessionId.lastIndexOf(":");
    if (separator <= "subagent:".length) break;
    sessionId = sessionId.slice("subagent:".length, separator);
  }
  const base = sessionId.replace(/__(facts|obs)$/, "");
  return base.startsWith("cowork:") ? teammateThread(base.slice("cowork:".length)) ?? base : base;
}
