/**
 * Faza 1 — runEval real: the embedded Tier 1/2 default eval suite.
 *
 * Tier 0 (Rust-frozen) is the sanity bar. Tier 1 raises it to in-context
 * competence — harder verifiable facts, simple computation, structured
 * output, and answer consistency. Tier 2 is held-out multi-step
 * reasoning: word problems, geometry, logic, and planning. Every spec
 * uses one of the four deterministic validator kinds so a run is exactly
 * reproducible — a hard requirement for Population-Based Training, which
 * ranks genomes by replaying this suite.
 *
 * These ship embedded (a TS array) rather than as loose JSON because bun
 * `--compile` does not bundle data files. Users/operators can still
 * extend the suite at runtime by dropping JSON specs in
 * `~/.cinderpaw/eval/tier1` / `~/.cinderpaw/eval/tier2` (see `loadTierSpecs`);
 * the production `getSpecs` concatenates embedded defaults with whatever
 * is found on disk.
 *
 * Authoring rule: keep answers unambiguous and case/whitespace-robust,
 * because `fact_lookup` is a normalised substring match. Prefer asking
 * the model to "answer with just the X" so a verbose response still
 * contains the canonical token.
 */

import type { EvalSpec } from "./eval-spec.ts";

/** Tier 1 — in-context competence. */
export const TIER1_SPECS: EvalSpec[] = [
  {
    id: "tier1/speed_of_light",
    tier: 1,
    name: "Speed of light",
    description: "Agent recalls the speed of light in m/s.",
    prompt:
      "What is the speed of light in a vacuum, in meters per second? Answer with just the integer.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "299792458" },
  },
  {
    id: "tier1/multiply_17_23",
    tier: 1,
    name: "Two-digit multiplication",
    description: "Agent computes 17 × 23.",
    prompt: "What is 17 multiplied by 23? Answer with just the number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "391" },
  },
  {
    id: "tier1/compare_decimals",
    tier: 1,
    name: "Decimal comparison",
    description: "Agent knows 0.9 > 0.85.",
    prompt:
      "Which number is larger, 0.9 or 0.85? Answer with just the larger number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "0.9" },
  },
  {
    id: "tier1/json_city_country",
    tier: 1,
    name: "Structured capital",
    description: "Agent returns JSON with city and country keys.",
    prompt:
      'Give the capital of Japan. Reply with ONLY a JSON object with keys "city" and "country". No prose, no code fences.',
    kind: "json_format",
    expected: { type: "json_format", required_keys: ["city", "country"] },
  },
  {
    id: "tier1/time_arithmetic",
    tier: 1,
    name: "Clock arithmetic",
    description: "Agent adds 3 hours to 2pm.",
    prompt:
      "A train leaves at 2pm and the trip takes 3 hours. At what time does it arrive? Answer with just the time, like 5pm.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "5pm" },
  },
  {
    id: "tier1/concise_primary_colors",
    tier: 1,
    name: "Concise answer budget",
    description: "Agent answers a trivial question without rambling.",
    prompt:
      "Name the three additive primary colors of light. Keep it to one short sentence.",
    kind: "token_budget",
    expected: { type: "token_budget", max_tokens: 60 },
  },
];

/** Tier 2 — held-out multi-step reasoning. */
export const TIER2_SPECS: EvalSpec[] = [
  {
    id: "tier2/word_problem_pens",
    tier: 2,
    name: "Cost word problem",
    description: "Agent multiplies unit price by quantity.",
    prompt:
      "A shop sells pens at $3 each. How much do 7 pens cost? Answer with just the dollar amount, like $21.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "$21" },
  },
  {
    id: "tier2/rectangle_area",
    tier: 2,
    name: "Rectangle area",
    description: "Agent computes area of a 4×6 rectangle.",
    prompt:
      "A rectangle is 4 units wide and 6 units tall. What is its area? Answer with just the number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "24" },
  },
  {
    id: "tier2/syllogism",
    tier: 2,
    name: "Simple syllogism",
    description: "Agent applies a categorical premise.",
    prompt:
      "All cats are mammals. A tabby is a cat. Is a tabby a mammal? Answer yes or no.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "yes" },
  },
  {
    id: "tier2/plan_make_tea",
    tier: 2,
    name: "Structured plan",
    description: "Agent emits a goal + steps plan as JSON.",
    prompt:
      'Plan how to make a cup of tea. Reply with ONLY a JSON object with keys "goal" and "steps", where "steps" is an array of strings. No prose, no code fences.',
    kind: "json_format",
    expected: { type: "json_format", required_keys: ["goal", "steps"] },
  },
  {
    id: "tier2/percentage",
    tier: 2,
    name: "Percentage",
    description: "Agent computes 20% of 150.",
    prompt: "What is 20% of 150? Answer with just the number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "30" },
  },
  {
    id: "tier2/sequence_next",
    tier: 2,
    name: "Number sequence",
    description: "Agent continues an arithmetic sequence.",
    prompt:
      "What is the next number in the sequence 2, 4, 6, 8? Answer with just the number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "10" },
  },
  // ── Headroom block: multi-step reasoning a saturated model can still
  // miss under a bad config (truncation, rambling, weak style). ────────
  {
    id: "tier2/two_leg_distance",
    tier: 2,
    name: "Two-leg distance",
    description: "Agent chains two rate×time products and sums.",
    prompt:
      "A car travels at 60 km/h for 2.5 hours, then at 80 km/h for 1.5 hours. How many km did it travel in total? Answer with just the number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "270" },
  },
  {
    id: "tier2/transitive_shortest",
    tier: 2,
    name: "Transitive ordering",
    description: "Agent applies two transitive comparisons.",
    prompt:
      "Anna is taller than Ben. Ben is taller than Carl. Who is the shortest? Answer with just the name.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "carl" },
  },
  {
    id: "tier2/seconds_in_hours",
    tier: 2,
    name: "Unit conversion",
    description: "Agent converts fractional hours to seconds.",
    prompt: "How many seconds are in 2.5 hours? Answer with just the number.",
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "9000" },
  },
];

/** Fixed catalog for the tool_call specs. Self-contained in the prompt so
 *  the task is deterministic and independent of the live registry. */
const TOOL_CATALOG =
  "You can call exactly one of these tools:\n" +
  '- web_search(query: string) — search the web for current information\n' +
  '- read_file(path: string) — read a file from disk\n' +
  '- calculator(expression: string) — evaluate an arithmetic expression\n' +
  '- http_request(url: string, method: string) — call an HTTP API\n' +
  '- remember(fact: string) — save a fact to long-term memory\n' +
  'Reply with ONLY a JSON object: {"tool": "<name>", "args": {...}}. No prose, no code fences.\n\nTask: ';

/** Tier 2 — tool selection + call shaping (kind `tool_call`). This is
 *  the slice of the suite that grades the agent AS AN AGENT: given a
 *  task and a catalog, pick the right tool and emit a well-formed call.
 *  Feeds the fitness vector's `toolSuccess` component (contract-leaves). */
export const TIER2_TOOL_SPECS: EvalSpec[] = [
  {
    id: "tier2/tool_calculator",
    tier: 2,
    name: "Tool: arithmetic → calculator",
    description: "Agent routes arithmetic to the calculator with the expression.",
    prompt: TOOL_CATALOG + "What is 847 multiplied by 312?",
    kind: "tool_call",
    expected: { type: "tool_call", tool: "calculator", required_args: ["expression"] },
    domain: "tools",
  },
  {
    id: "tier2/tool_web_current",
    tier: 2,
    name: "Tool: current info → web_search",
    description: "Agent recognises 'current' information needs the web, not the calculator.",
    prompt: TOOL_CATALOG + "What is the current USD to EUR exchange rate?",
    kind: "tool_call",
    expected: { type: "tool_call", tool: "web_search", required_args: ["query"] },
    domain: "tools",
  },
  {
    id: "tier2/tool_read_file",
    tier: 2,
    name: "Tool: file read with exact path",
    description: "Agent passes the exact requested path through.",
    prompt: TOOL_CATALOG + "Show me the contents of the file config/settings.json.",
    kind: "tool_call",
    expected: {
      type: "tool_call",
      tool: "read_file",
      required_args: ["path"],
      arg_equals: { path: "config/settings.json" },
    },
    domain: "tools",
  },
  {
    id: "tier2/tool_remember",
    tier: 2,
    name: "Tool: persistence → remember",
    description: "Agent routes a 'save this' request to memory, not search.",
    prompt: TOOL_CATALOG + "Please remember that my favorite color is green.",
    kind: "tool_call",
    expected: { type: "tool_call", tool: "remember", required_args: ["fact"] },
    domain: "tools",
  },
  {
    id: "tier2/tool_http_get",
    tier: 2,
    name: "Tool: API call with method",
    description: "Agent shapes an http_request with pinned url and method.",
    prompt: TOOL_CATALOG + "Check the status endpoint at https://api.example.com/status using a GET request.",
    kind: "tool_call",
    expected: {
      type: "tool_call",
      tool: "http_request",
      required_args: ["url", "method"],
      arg_equals: { url: "https://api.example.com/status", method: "get" },
    },
    domain: "tools",
  },
];
