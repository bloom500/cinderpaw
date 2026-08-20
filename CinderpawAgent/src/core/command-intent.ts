/**
 * What a command is FOR — read, write, destroy, reach the network, touch the
 * machine.
 *
 * Two things need this and neither can get it from a whitelist. A permission
 * mode has to answer "may this run here", and `ls` and `rm` are not the same
 * question even though both are "a binary on the allowlist". And a walk-away
 * report has to answer "what did it actually do while I was out" — "27 tool
 * calls" says nothing, "22 reads, 4 writes, 1 network call" says what
 * happened.
 *
 * The classifier reads the FIRST real command, which means seeing past the
 * wrappers models reach for: `env FOO=1 sudo rm …`, `sh -c "rm …"`,
 * `cmd /c del …`. Unwrapping matters more than the table: a payload behind
 * `sh -c` that classifies as "unknown" is a destructive command nobody
 * counted.
 *
 * Best-effort by construction, like every string-level judgement about a
 * shell. It is a lens for policy and reporting, never a security boundary.
 */

/** What the command is trying to do. */
export type CommandIntent =
  | "read_only"
  | "write"
  | "destructive"
  | "network"
  | "process"
  | "package"
  | "system"
  | "unknown";

/** Human-readable, for digests. Order is the order a report should list them. */
export const INTENT_ORDER: CommandIntent[] = [
  "read_only",
  "write",
  "destructive",
  "network",
  "process",
  "package",
  "system",
  "unknown",
];

export const INTENT_LABEL: Record<CommandIntent, string> = {
  read_only: "read-only",
  write: "wrote files",
  destructive: "deleted or overwrote",
  network: "reached the network",
  process: "managed processes",
  package: "installed packages",
  system: "changed the machine",
  unknown: "unclassified",
};

const TABLE: Array<[CommandIntent, string[]]> = [
  ["read_only", [
    "ls", "dir", "cat", "type", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep",
    "find", "fd", "wc", "diff", "stat", "file", "which", "where", "whoami", "pwd", "echo",
    "date", "env", "printenv", "tree", "du", "df", "ps", "top", "uname", "hostname", "sort",
    "uniq", "cut", "awk", "sed", "jq", "md5sum", "sha256sum", "test",
  ]],
  ["write", [
    "cp", "copy", "mv", "move", "mkdir", "md", "touch", "tee", "ln", "install", "unzip", "tar",
    "zip", "patch", "new-item", "set-content", "add-content", "out-file",
  ]],
  ["destructive", [
    "rm", "rmdir", "rd", "del", "erase", "unlink", "shred", "srm", "truncate", "mkfs", "format",
    "rimraf", "remove-item", "clear-content", "dd",
  ]],
  ["network", [
    "curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "nc", "netcat", "telnet",
    "invoke-webrequest", "invoke-restmethod",
  ]],
  ["process", ["kill", "pkill", "killall", "taskkill", "stop-process", "start-process", "nohup"]],
  ["package", [
    "apt", "apt-get", "yum", "dnf", "pacman", "brew", "choco", "winget", "pip", "pip3",
    "npm", "pnpm", "yarn", "bun", "cargo", "gem", "go", "poetry", "uv",
  ]],
  ["system", [
    "sudo", "su", "doas", "chmod", "chown", "chgrp", "mount", "umount", "systemctl", "service",
    "shutdown", "reboot", "halt", "poweroff", "sc", "reg", "regedit", "setx", "net",
  ]],
];

const LOOKUP = new Map<string, CommandIntent>();
for (const [intent, names] of TABLE) for (const n of names) LOOKUP.set(n, intent);

/** Shells, whose `-c` / `/c` argument is the command that actually runs. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "cmd", "powershell", "pwsh"]);

/** Lowercased basename with any Windows executable extension removed. */
export function commandStem(nameOrPath: string): string {
  const base = (nameOrPath.split(/[\\/]/).pop() ?? nameOrPath).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "");
}

/**
 * Split on the operators that start a NEW command, so `ls && rm -rf x`
 * classifies on both halves rather than on `ls` alone. Quotes are not honored:
 * an operator inside a quoted string produces one extra fragment, which can
 * only make the classification more cautious, never less.
 */
function segments(commandLine: string): string[] {
  return commandLine
    .split(/\|\||&&|[;|&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip `VAR=value` prefixes and privilege wrappers to reach the real command. */
function realFirstToken(tokens: string[]): { stem: string; rest: string[] } {
  let i = 0;
  let wrapper = "";
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // env assignment
    const stem = commandStem(t);
    // `env` is two commands in one: with something after it, it is a wrapper
    // (`env FOO=1 rm x` deletes); with nothing, it prints the environment.
    if (stem === "env" && i + 1 < tokens.length) { wrapper = stem; i++; continue; }
    if (stem === "sudo" || stem === "doas" || stem === "command" || stem === "time") {
      // Do NOT try to skip the wrapper's own flags by shape: `sudo -u root rm x`
      // has a flag with a value, and guessing which flags take one is how
      // `root` ends up classified as the command. Scan forward for the first
      // token we actually recognise instead.
      wrapper = stem;
      const found = tokens.slice(i + 1).findIndex((t) => {
        const s = commandStem(t);
        return LOOKUP.has(s) || SHELLS.has(s);
      });
      if (found === -1) break;
      i = i + 1 + found;
      continue;
    }
    return { stem, rest: tokens.slice(i + 1) };
  }
  // Nothing but wrappers: `sudo` on its own is still a machine-level command,
  // `env` on its own just prints. Classify the wrapper we actually saw.
  return { stem: wrapper, rest: [] };
}

const RANK: CommandIntent[] = [
  "destructive", "system", "package", "process", "network", "write", "read_only", "unknown",
];

/** The more consequential of two intents — what a whole command line counts as. */
function worse(a: CommandIntent, b: CommandIntent): CommandIntent {
  return RANK.indexOf(a) <= RANK.indexOf(b) ? a : b;
}

/**
 * Classify one argv. A shell invocation is classified by its PAYLOAD, and a
 * payload with several commands takes the most consequential of them — the
 * question a policy asks is "what is the worst thing this line does", not
 * "what does it start with".
 */
export function classifyCommand(argv: string[]): CommandIntent {
  const tokens = argv.filter((t) => typeof t === "string" && t.length > 0);
  if (tokens.length === 0) return "unknown";

  const { stem, rest } = realFirstToken(tokens);
  if (!stem) return "unknown";

  if (SHELLS.has(stem)) {
    // The payload is whatever follows -c / /c; without one, a shell that runs
    // nothing is harmless to classify as read-only, but we do not assume it —
    // an interactive shell can do anything, so it stays unknown.
    const flag = rest.findIndex((t) => /^([-/])c$/i.test(t));
    const payload = flag >= 0 ? rest.slice(flag + 1).join(" ") : "";
    if (!payload.trim()) return "unknown";
    return classifyCommandLine(payload);
  }

  return LOOKUP.get(stem) ?? "unknown";
}

/** Classify a raw command LINE (what a shell would interpret). */
export function classifyCommandLine(commandLine: string): CommandIntent {
  const parts = segments(commandLine);
  if (parts.length === 0) return "unknown";
  let result: CommandIntent | null = null;
  for (const part of parts) {
    const intent = classifyCommand(part.split(/\s+/));
    result = result === null ? intent : worse(result, intent);
  }
  return result ?? "unknown";
}

/**
 * What a session's commands added up to, for the walk-away report.
 *
 * In memory on purpose: it describes the run being reported on, and a run that
 * outlives the process gets its account rebuilt from `run_turns` rather than
 * from a counter nobody flushed. Cleared per session so a long-lived sidecar
 * does not report yesterday's numbers.
 */
const COUNTS = new Map<string, Map<CommandIntent, number>>();

export function recordIntent(sessionId: string, intent: CommandIntent): void {
  let bucket = COUNTS.get(sessionId);
  if (!bucket) COUNTS.set(sessionId, (bucket = new Map()));
  bucket.set(intent, (bucket.get(intent) ?? 0) + 1);
}

/** `[["read-only", 22], ["wrote files", 4]]`, most consequential last. */
export function intentSummary(sessionId: string): Array<[string, number]> {
  const bucket = COUNTS.get(sessionId);
  if (!bucket) return [];
  return INTENT_ORDER.filter((i) => (bucket.get(i) ?? 0) > 0).map(
    (i) => [INTENT_LABEL[i], bucket.get(i)!] as [string, number],
  );
}

export function clearIntents(sessionId: string): void {
  COUNTS.delete(sessionId);
}
