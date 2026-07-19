/**
 * YOLO shell_exec denylist — the best-effort catastrophe guard.
 *
 * The denylist is NOT a security boundary (a determined caller evades it);
 * it exists to stop the agent from footgunning the host on an obvious
 * irreversible command. These assertions pin the two things that matter:
 *   1. the catastrophic patterns are caught (even inside a `sh -c` payload)
 *   2. ordinary destructive-but-fine work is NOT blocked (no false positives)
 */

import { describe, expect, it } from "bun:test";
import { isDestructive } from "../src/tools/builtin/shell-exec.ts";

describe("shell_exec denylist", () => {
  it("blocks catastrophic, irreversible commands", () => {
    for (const cmd of [
      "rm -rf /",
      "rm -rf ~",
      "rm -fr /",
      "sh -c rm -rf /", // shell payload, joined argv
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      ":(){ :|:& };:", // fork bomb
      "shutdown -h now",
      "reboot",
    ]) {
      expect(isDestructive(cmd)).toBe(true);
    }
  });

  it("allows ordinary work, including scoped rm", () => {
    for (const cmd of [
      "rm -rf node_modules",
      "rm -rf ./build",
      "git status",
      "npm install",
      "python script.py",
      "cargo build --release",
      "dd if=input.img of=output.img", // file-to-file, not a raw disk
    ]) {
      expect(isDestructive(cmd)).toBe(false);
    }
  });
});
