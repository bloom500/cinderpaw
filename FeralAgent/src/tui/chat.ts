/**
 * Interactive terminal chat loop — Feral headless slice 5.1.
 */

import * as readline from "node:readline";
import { TuiTransport } from "../transports/tui.ts";
import {
  shouldUseColor,
  primary,
  muted,
  error,
  dim,
  secondary,
  renderStatusBar,
  renderHelpLine,
  renderYouPrompt,
  renderFeralPrompt,
  terminalWidth,
} from "./render.ts";
import type { OutboundEvent } from "../types.ts";

export async function runChat(): Promise<void> {
  const useColor = shouldUseColor();
  const transport = new TuiTransport();
  const width = terminalWidth();

  let currentResponse = "";
  let currentToolName = "";
  let aiResponding = false;

  transport.onEvent((event: OutboundEvent) => {
    switch (event.type) {
      case "chunk":
        if (!aiResponding) {
          process.stdout.write(renderFeralPrompt(useColor));
          aiResponding = true;
        }
        process.stdout.write(event.content);
        currentResponse += event.content;
        break;

      case "done":
        process.stdout.write("\n\n");
        currentResponse = "";
        currentToolName = "";
        aiResponding = false;
        promptLoop(rl);
        break;

      case "tool_start":
        if (!aiResponding) aiResponding = true;
        if (currentResponse) {
          process.stdout.write("\n");
          currentResponse = "";
        }
        currentToolName = event.tool ?? "tool";
        process.stdout.write(dim(`  ⚡ ${currentToolName}...\n`, useColor));
        break;

      case "tool_done": {
        const r = event.result as { ok?: boolean; error?: string } | null;
        const mark = r?.ok === false ? "✗" : "✓";
        const col = r?.ok === false ? error : dim;
        process.stdout.write(col(`  ${mark} ${currentToolName || "tool"}\n`, useColor));
        currentToolName = "";
        break;
      }

      case "error":
        process.stdout.write(error(`\n⚠  ${event.message}\n\n`, useColor));
        aiResponding = false;
        promptLoop(rl);
        break;

      case "model_set":
        process.stdout.write(
          secondary(`\nModel: ${event.provider}/${event.model}\n\n`, useColor),
        );
        break;

      case "model_error":
        process.stdout.write(error(`\n⚠  Model: ${event.message}\n\n`, useColor));
        break;

      default:
        break;
    }
  });

  const { main } = await import("../index.ts");
  await main(transport);

  const model = process.env.FERAL_MODEL ?? "qwen2.5:7b";
  console.log();
  console.log(renderStatusBar(model, width, useColor));
  console.log();
  console.log(renderFeralPrompt(useColor) + muted("Ready. Type a message, or a slash command.", useColor));
  console.log(renderHelpLine(["/help", "/clear", "/model", "/exit", "Ctrl+C"], width, useColor));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("close", () => {
    console.log();
    process.exit(0);
  });

  promptLoop(rl);

  function promptLoop(reader: readline.Interface): void {
    reader.question(renderYouPrompt(useColor), (raw: string) => {
      const line = raw.trim();
      if (!line) { promptLoop(reader); return; }

      if (line.startsWith("/")) {
        handleSlashCommand(line, reader, useColor, width);
        return;
      }

      transport.sendInboundAsMessage(line);
    });
  }

  function handleSlashCommand(
    line: string,
    reader: readline.Interface,
    clr: boolean,
    w: number,
  ): void {
    const cmd = line.toLowerCase().split(/\s+/)[0] ?? "";

    switch (cmd) {
      case "/help":
        console.log();
        console.log(primary("  Chat commands", clr));
        console.log(muted("  ─────────────", clr));
        console.log(dim("  /help     Show this help", clr));
        console.log(dim("  /clear    Clear the terminal", clr));
        console.log(dim("  /exit     Exit (also Ctrl+C / Ctrl+D)", clr));
        console.log(dim("  /model    Show the active model", clr));
        console.log();
        break;

      case "/clear":
        console.clear();
        console.log(renderStatusBar("Chat ready", w, clr));
        console.log();
        break;

      case "/exit":
      case "/quit":
        reader.close();
        process.exit(0);
        return;

      case "/model": {
        const cfg = process.env.FERAL_MODEL ?? "qwen2.5:7b";
        const prov = process.env.FERAL_PROVIDER ?? "openai_compatible";
        console.log(secondary(`  ${prov}/${cfg}`, clr));
        console.log();
        break;
      }

      default:
        console.log(error(`  Unknown command: ${cmd}`, clr));
        console.log(dim("  Type /help for available commands.", clr));
        console.log();
        break;
    }

    promptLoop(reader);
  }
}