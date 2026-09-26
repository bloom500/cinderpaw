/**
 * Installing software asks the person, every time (25 Sep: asked to connect
 * WhatsApp, the agent went looking for the library through the shell on its
 * own, and the page had no Stop button). Nothing runs before the yes.
 */
import { afterEach, expect, test } from "bun:test";
import { createShellExecTool, askBeforeInstall } from "../src/tools/builtin/shell-exec.ts";
import { createCodeQualityTool } from "../src/tools/builtin/code-quality.ts";
import type { ToolContext } from "../src/types.ts";

const ROOTS = [process.cwd()];

afterEach(() => {
  delete process.env.CINDERPAW_PERMISSION_MODE;
});

function ctx(answer: string | null, ran: string[][], asked: string[] = []): ToolContext {
  return {
    sessionId: "chat",
    process: {
      exec: async (argv: string[]) => {
        ran.push(argv);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    },
    ...(answer === null
      ? {}
      : {
          askUser: {
            ask: async (qs: Array<{ question: string }>) => {
              asked.push(qs[0]!.question);
              return [{ question: qs[0]!.question, selected: [answer] }];
            },
            cancel: () => {},
          },
        }),
  } as unknown as ToolContext;
}

test("an install through the shell asks first, and 'No' runs nothing", async () => {
  const ran: string[][] = [];
  const asked: string[] = [];
  const res = await createShellExecTool(ROOTS).execute(
    { argv: ["powershell", "-Command", "npm install @whiskeysockets/baileys"] },
    ctx("No, don't install", ran, asked),
  );
  expect(asked[0]).toContain("Install software on this computer?");
  expect(res.ok).toBe(false);
  expect(res.error).toBe("install_declined");
  expect(ran).toEqual([]);
});

test("with nobody there to answer, an install is refused", async () => {
  const ran: string[][] = [];
  const res = await createShellExecTool(ROOTS).execute({ argv: ["npm", "install", "left-pad"] }, ctx(null, ran));
  expect(res.error).toBe("install_needs_approval");
  expect(ran).toEqual([]);
});

test("full access is the operator's yes when nobody is there, but a present person is still asked", async () => {
  process.env.CINDERPAW_PERMISSION_MODE = "full_access";
  expect(await askBeforeInstall(ctx(null, []), "npm install x")).toBeNull();
  const asked: string[] = [];
  expect(await askBeforeInstall(ctx("Yes, install it", [], asked), "npm install x")).toBeNull();
  expect(asked.length).toBe(1);
});

test("install_deps asks too", async () => {
  const ran: string[][] = [];
  const res = await createCodeQualityTool("install_deps", ROOTS).execute(
    { project_path: process.cwd() },
    ctx("No, don't install", ran),
  );
  expect(res.error).toBe("install_declined");
  expect(ran).toEqual([]);
});

test("everyday commands are not asked about", async () => {
  const asked: string[] = [];
  await createShellExecTool(ROOTS).execute({ argv: ["git", "--version"] }, ctx("No, don't install", [], asked));
  expect(asked).toEqual([]);
});
