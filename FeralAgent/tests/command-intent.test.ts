/**
 * Classification is only useful if it survives the wrappers models actually
 * emit. A payload behind `sh -c` that reads as "unknown" is a destructive
 * command nobody counted — which is worse than no classifier at all, because
 * the report would look complete.
 */
import { describe, expect, test } from "bun:test";
import { classifyCommand, classifyCommandLine } from "../src/core/command-intent.ts";

describe("classifying what a command is for", () => {
  test("the obvious cases", () => {
    expect(classifyCommand(["ls", "-la"])).toBe("read_only");
    expect(classifyCommand(["grep", "-r", "token", "."])).toBe("read_only");
    expect(classifyCommand(["cp", "a", "b"])).toBe("write");
    expect(classifyCommand(["rm", "-rf", "build"])).toBe("destructive");
    expect(classifyCommand(["curl", "https://example.com"])).toBe("network");
    expect(classifyCommand(["kill", "-9", "123"])).toBe("process");
    expect(classifyCommand(["npm", "install"])).toBe("package");
    expect(classifyCommand(["chmod", "600", "key"])).toBe("system");
  });

  test("a shell is classified by its payload, not by being a shell", () => {
    expect(classifyCommand(["sh", "-c", "rm -rf build"])).toBe("destructive");
    expect(classifyCommand(["bash", "-c", "ls -la"])).toBe("read_only");
    expect(classifyCommand(["cmd", "/c", "del notes.txt"])).toBe("destructive");
    expect(classifyCommand(["powershell", "-c", "Remove-Item x"])).toBe("destructive");
  });

  test("env assignments and sudo are stepped over, not classified", () => {
    expect(classifyCommand(["env", "FOO=1", "rm", "x"])).toBe("destructive");
    expect(classifyCommand(["sudo", "rm", "-rf", "/tmp/x"])).toBe("destructive");
    expect(classifyCommand(["sudo", "-u", "root", "rm", "x"])).toBe("destructive");
    // `sudo` alone, with nothing to run, is still a machine-level command.
    expect(classifyCommand(["sudo"])).toBe("system");
  });

  test("a chained line counts as the worst thing in it", () => {
    // The failure this prevents: reporting `ls && rm -rf /data` as a read.
    expect(classifyCommandLine("ls -la && rm -rf data")).toBe("destructive");
    expect(classifyCommandLine("cat a.txt | grep x")).toBe("read_only");
    expect(classifyCommandLine("mkdir out; curl http://x -o out/f")).toBe("network");
    expect(classifyCommand(["sh", "-c", "npm ci && rm -rf node_modules/.cache"]))
      .toBe("destructive");
  });

  test("absolute paths and Windows extensions resolve to the same command", () => {
    expect(classifyCommand(["C:\\Windows\\System32\\cmd.exe", "/c", "dir"])).toBe("read_only");
    expect(classifyCommand(["/usr/bin/rm", "x"])).toBe("destructive");
    expect(classifyCommand(["GIT.EXE"])).toBe("unknown");
  });

  test("what it does not know, it says it does not know", () => {
    // Silently calling an unknown binary "read-only" is how a permission mode
    // becomes decorative.
    expect(classifyCommand(["some-random-binary"])).toBe("unknown");
    expect(classifyCommand([])).toBe("unknown");
    expect(classifyCommand(["sh"])).toBe("unknown");
  });
});
