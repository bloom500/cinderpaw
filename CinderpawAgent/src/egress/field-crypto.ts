/**
 * Field-level encryption for sensitive DB columns at rest (H-1).
 *
 * The host (Rust) provisions a 256-bit key in the OS keychain and hands it to
 * this process as `FERAL_DB_KEY` (base64). We encrypt the highest-density PII
 * column — semantic memory values — with AES-256-GCM so a stolen copy of the
 * SQLite file alone does not reveal those facts. Episodic/conversation text is
 * FTS-indexed and stays plaintext; it is covered by full-disk encryption.
 *
 * Envelope format (string, SQLite-friendly):
 *   enc:v1:<base64(iv)>:<base64(ciphertext || authTag)>
 *
 * Design constraints:
 *   - No key ⇒ store/return PLAINTEXT (graceful). The host only sets the key
 *     when the keychain could persist it; encrypting with an unpersisted key
 *     would make data permanently unreadable after a restart.
 *   - Reads are content-sniffed: only `enc:v1:`-prefixed values are decrypted,
 *     so legacy plaintext rows (written before this feature, or with the key
 *     off) keep working with no migration step.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { cfgPath } from "../config.ts";

const PREFIX = "enc:v1:";
const IV_BYTES = 12; // standard GCM nonce length
const TAG_BYTES = 16;

/**
 * Load and validate the 32-byte key from the env, or null when absent/invalid.
 * Resolved per-call (not memoized) so the value tracks the env the host set —
 * semantic ops are infrequent, so the cost is irrelevant and testability wins.
 */
function loadKey(): Buffer | null {
  const raw = cfgPath("FERAL_DB_KEY");
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** True when at-rest field encryption is active (a valid key is present). */
export function fieldEncryptionEnabled(): boolean {
  return loadKey() !== null;
}

/** Encrypt a field value. Returns the plaintext unchanged when no key is set. */
export function encryptField(plain: string): string {
  const KEY = loadKey();
  if (!KEY) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([ct, tag]);
  return `${PREFIX}${iv.toString("base64")}:${blob.toString("base64")}`;
}

/**
 * Decrypt a stored field. Non-enveloped values (legacy plaintext) are returned
 * as-is. If the value is enveloped but no/invalid key is available, it is
 * returned unchanged rather than throwing — auditing/recall must not crash on a
 * key mismatch.
 */
export function decryptField(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // plaintext / legacy
  const KEY = loadKey();
  if (!KEY) return stored;
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 2) return stored;
  try {
    const iv = Buffer.from(parts[0]!, "base64");
    const blob = Buffer.from(parts[1]!, "base64");
    if (blob.length <= TAG_BYTES) return stored;
    const ct = blob.subarray(0, blob.length - TAG_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext — don't crash the read path.
    return stored;
  }
}
