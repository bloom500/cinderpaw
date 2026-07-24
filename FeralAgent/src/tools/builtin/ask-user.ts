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
import { AskUserTimeoutError } from "../../types.ts";
import { cfgBool } from "../../config.ts";
import { log } from "../../runtime-meta.ts";

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * Appended to every validation error so a model that got the shape wrong can
 * self-correct on retry. Observed failure: models call ask_user with
 * questions lacking the 'options' array, get a terse error, retry with the
 * same shape, and give up — a concrete example breaks that loop.
 */
const VALID_EXAMPLE =
  ' Valid example: {"questions": [{"question": "Which database?", ' +
  '"options": [{"label": "Postgres", "recommended": true}, {"label": "SQLite"}]}]}';

export function createAskUserTool(): Tool {
  return {
    manifest: {
      name: "ask_user",
      description:
        "Ask the user one or more multiple-choice questions when you need " +
        "clarification or a decision before continuing. Each question must " +
        "have 2-4 options (the UI implicitly adds an 'Other' choice). " +
        "Limit to 1-4 questions per call so the user is not overwhelmed. " +
        "Prefer asking over guessing whenever the answer materially changes " +
        "what you do next (ambiguous requests, destructive or costly actions, " +
        "competing approaches); skip it for trivia you can decide yourself. " +
        "Returns the user's selections as a structured summary.",
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
        // Full JSON Schema for native function calling. In native-tools mode
        // the text docs are stripped from the system prompt, so this is the
        // model's ONLY source for the nested shape — without it, models
        // guessed the structure and most calls failed validation.
        schema: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description:
            "1-4 multiple-choice questions to show the user. The UI adds an " +
            "'Other' free-text option automatically.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The full question text, ending with a question mark.",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                description: "2-4 mutually exclusive choices.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Short display text for this choice (1-5 words).",
                    },
                    description: {
                      type: "string",
                      description: "Optional 1-2 sentence explanation of the choice.",
                    },
                    recommended: {
                      type: "boolean",
                      description:
                        "Mark at most one option per question as the recommended default.",
                    },
                  },
                  required: ["label"],
                },
              },
              multiSelect: {
                type: "boolean",
                description: "Allow selecting multiple options (default false).",
              },
              force_escalate: {
                type: "boolean",
                description:
                  "Set true when being wrong is NOT recoverable by re-running: spending money, " +
                  "publishing something public, deleting data, sending on the user’s behalf. " +
                  "A question marked this way is never auto-answered, even in walk-away mode — " +
                  "a human decides. Use it sparingly and honestly; marking routine choices this " +
                  "way just stalls unattended work.",
              },
            },
            required: ["question", "options"],
          },
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const questions = args.questions;
      if (!Array.isArray(questions)) {
        return {
          ok: false,
          content: "ask_user: 'questions' must be an array." + VALID_EXAMPLE,
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

      // The tool schema is snake_case (force_escalate) like the rest of the
      // tool surface; the internal type is camelCase. Normalise once, here,
      // rather than reading both spellings at the use site — a safety flag
      // that silently does nothing because of a casing mismatch is the worst
      // possible failure for this particular field.
      for (const q of questions as Array<Record<string, unknown>>) {
        if (q && typeof q === "object" && q.force_escalate === true) {
          (q as { forceEscalate?: boolean }).forceEscalate = true;
        }
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
            content: `ask_user: question #${i + 1} is missing 'question' text.` + VALID_EXAMPLE,
            error: "bad_args",
          };
        }
        if (!Array.isArray(q.options)) {
          return {
            ok: false,
            content: `ask_user: question #${i + 1} has no 'options' array.` + VALID_EXAMPLE,
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
              content: `ask_user: question #${i + 1}, option #${j + 1} is missing 'label'.` + VALID_EXAMPLE,
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

      let answers: AskUserAnswer[];
      let autoResolved = false;
      let autoResolveReason: string | null = null;

      // Autonomous / walk-away mode: the user is not at the machine, so do NOT
      // block on a question. Take the recommended option (or the first) for
      // each, exactly as the timeout path does, but without the 5-minute wait —
      // and log the decision so the end-of-turn summary can report what was
      // chosen without a human present. Reuses the same picker as the timeout
      // branch below; the only difference is we never call the bridge.
      // An escalated question is exactly the one walk-away mode must NOT
      // answer for itself: "should I raise the daily budget to $500?" is not a
      // decision to take by picking option one because nobody is at the desk.
      // If any question in the batch demands a human, the whole batch does —
      // they are answered together and splitting them would half-decide.
      const mustEscalate = questions.some(
        (q) => (q as AskUserQuestion).forceEscalate === true,
      );
      if (cfgBool("FERAL_AUTONOMOUS") && mustEscalate && !ctx.askUser) {
        // Fail CLOSED, and say why in terms the agent can act on: this is not
        // a tool malfunction, it is the one class of decision it may not take
        // alone. Same discipline as the forge's consent gate.
        return {
          ok: false,
          content:
            "ask_user: this question needs a human and there is nobody to ask " +
            "(walk-away mode, no interactive transport). Consequential decisions — " +
            "spending money, publishing, deleting, sending on someone's behalf — are " +
            "not auto-answered. Do the parts of the task that do NOT need this " +
            "decision, then stop and report what is waiting on the user.",
          error: "escalation_required",
        };
      }
      if (cfgBool("FERAL_AUTONOMOUS") && !mustEscalate) {
        answers = questions.map((q) => {
          const rec = q.options.find((o: { label: string; recommended?: boolean }) => o.recommended);
          const picked = rec ?? q.options[0];
          return { question: q.question, selected: picked ? [picked.label] : [] };
        });
        autoResolved = true;
        autoResolveReason = "autonomous mode (FERAL_AUTONOMOUS) — auto-selected the recommended option without waiting for the user";
        for (let i = 0; i < questions.length; i++) {
          const picked = answers[i]?.selected?.[0] ?? "(none)";
          log(`autonomous: ask_user "${(questions[i] as AskUserQuestion).question}" → "${picked}"`);
        }
      } else if (!ctx.askUser) {
        return {
          ok: false,
          content:
            "ask_user: the current transport does not support interactive questions " +
            "(no askUser bridge in the tool context). Set FERAL_AUTONOMOUS=true to " +
            "auto-answer with the recommended option instead of blocking.",
          error: "no_ask_user_bridge",
        };
      } else {
      try {
        answers = await ctx.askUser.ask(questions as AskUserQuestion[], ctx.sessionId);
      } catch (err) {
        // Feral-WIP #5: on AskUserTimeoutError, auto-resolve with the first
        // recommended option (or first option) so the agent keeps moving.
        if (err instanceof AskUserTimeoutError) {
          answers = questions.map((q) => {
            const rec = q.options.find(
              (o: { label: string; recommended?: boolean }) => o.recommended,
            );
            const picked = rec ?? q.options[0];
            return { question: q.question, selected: picked ? [picked.label] : [] };
          });
          autoResolved = true;
          autoResolveReason = "timeout after " + err.timeoutMs + "ms -- auto-selected recommended option";
        } else {
          return {
            ok: false,
            content: "ask_user: " + (err instanceof Error ? err.message : String(err)),
            error: "ask_user_failed",
          };
        }
      }
      } // end interactive branch (non-autonomous)

      // Render the answers as a compact, scannable summary for the model.
      const lines: string[] = ["User answered:"];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] as AskUserQuestion;
        const a = answers[i];
        const selected = a?.selected?.length ? a.selected.join(", ") : "(no selection)";
        const custom = a?.customText ? ` — custom: "${a.customText}"` : "";
        lines.push(`  Q${i + 1}: "${q.question}" → ${selected}${custom}`);
      }
      if (autoResolved) {
        lines.push("", "WARN: " + autoResolveReason + ". Continue with this default unless you ask the user again.");
      }

      return {
        ok: true,
        content: lines.join("\n"),
        data: {
          questions,
          answers,
          autoResolved,
          autoResolveReason,
        },
      };
    },
  };
}
