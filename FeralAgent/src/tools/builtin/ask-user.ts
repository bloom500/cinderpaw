/**
 * ask_user — interactive questions for the user.
 *
 * Claude.ai-style: the agent emits 1-4 questions, each with 2-4 options.
 * The UI (React) renders them as a card, the user picks, and the answer
 * is returned to the agent as a single tool result.
 *
 * Why a tool (not a special LLM message format):
 *   - The agent loop already handles async tool calls and tool results.
 *     ask_user fits the same shape — emit event, wait for response,
 *     continue reasoning.
 *   - The model only needs to know "call ask_user with these questions"
 *     — no special XML/JSON format in the prompt.
 *
 * Security:
 *   - No permissions, no I/O, no network. Pure event emission through
 *     the AskUserBridge in the tool context.
 *   - Validates the question shape before asking (1-4 questions,
 *     2-4 options each). Rejects bad inputs with a clear error so the
 *     model can retry.
 *
 * Output format (what the model sees):
 *   ```
 *   User answered:
 *     Q1: "Pick a database" → Postgres
 *     Q2: "Include migrations?" → Yes, No
 *   ```
 */

import type { AskUserAnswer, AskUserQuestion, Tool, ToolResult } from "../../types.ts";

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

export function createAskUserTool(): Tool {
  return {
    manifest: {
      name: "ask_user",
      description:
        "Ask the user one or more multiple-choice questions when you need " +
        "clarification or a decision before continuing. Each question must " +
        "have 2-4 options (the UI implicitly adds an 'Other' choice). " +
        "Limit to 1-4 questions per call so the user is not overwhelmed. " +
        "Use this sparingly — only when the answer materially changes what " +
        "you do next. Returns the user's selections as a structured summary.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      questions: {
        type: "array",
        description:
          "1-4 questions, each with 2-4 options. Each option has a " +
          "'label' (short, 1-5 words) and optional 'description' " +
          "(1-2 sentences). Mark at most one option per question as " +
          "'recommended: true' to highlight the default.",
        required: true,
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const questions = args.questions;
      if (!Array.isArray(questions)) {
        return {
          ok: false,
          content: "ask_user: 'questions' must be an array.",
          error: "bad_args",
        };
      }
      if (questions.length === 0) {
        return {
          ok: false,
          content: "ask_user: at least one question is required.",
          error: "bad_args",
        };
      }
      if (questions.length > MAX_QUESTIONS) {
        return {
          ok: false,
          content: `ask_user: too many questions (${questions.length}). ` +
            `Limit to ${MAX_QUESTIONS} per call.`,
          error: "bad_args",
        };
      }

      // Validate each question's shape.
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] as Partial<AskUserQuestion> | undefined;
        if (!q || typeof q !== "object") {
          return {
            ok: false,
            content: `ask_user: question #${i + 1} is not an object.`,
            error: "bad_args",
          };
        }
        if (typeof q.question !== "string" || !q.question.trim()) {
          return {
            ok: false,
            content: `ask_user: question #${i + 1} is missing 'question' text.`,
            error: "bad_args",
          };
        }
        if (!Array.isArray(q.options)) {
          return {
            ok: false,
            content: `ask_user: question #${i + 1} has no 'options' array.`,
            error: "bad_args",
          };
        }
        if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
          return {
            ok: false,
            content: `ask_user: question #${i + 1} must have ${MIN_OPTIONS}-${MAX_OPTIONS} options ` +
              `(got ${q.options.length}). The UI adds an 'Other' option automatically.`,
            error: "bad_args",
          };
        }
        let recommendedCount = 0;
        for (let j = 0; j < q.options.length; j++) {
          const o = q.options[j] as { label?: unknown; recommended?: unknown };
          if (typeof o?.label !== "string" || !o.label.trim()) {
            return {
              ok: false,
              content: `ask_user: question #${i + 1}, option #${j + 1} is missing 'label'.`,
              error: "bad_args",
            };
          }
          if (o.recommended === true) recommendedCount++;
        }
        if (recommendedCount > 1) {
          return {
            ok: false,
            content: `ask_user: question #${i + 1} has ${recommendedCount} options marked ` +
              `'recommended'. At most one option per question can be recommended.`,
            error: "bad_args",
          };
        }
      }

      if (!ctx.askUser) {
        return {
          ok: false,
          content:
            "ask_user: the current transport does not support interactive questions " +
            "(no askUser bridge in the tool context).",
          error: "no_ask_user_bridge",
        };
      }

      let answers: AskUserAnswer[];
      try {
        answers = await ctx.askUser.ask(questions as AskUserQuestion[], ctx.sessionId);
      } catch (err) {
        return {
          ok: false,
          content: `ask_user: ${err instanceof Error ? err.message : String(err)}`,
          error: "ask_user_failed",
        };
      }

      // Render the answers as a compact, scannable summary for the model.
      const lines: string[] = ["User answered:"];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] as AskUserQuestion;
        const a = answers[i];
        const selected = a?.selected?.length ? a.selected.join(", ") : "(no selection)";
        const custom = a?.customText ? ` — custom: "${a.customText}"` : "";
        lines.push(`  Q${i + 1}: "${q.question}" → ${selected}${custom}`);
      }

      return {
        ok: true,
        content: lines.join("\n"),
        data: {
          questions,
          answers,
        },
      };
    },
  };
}
