/**
 * calculator — safe arithmetic evaluator, NO eval().
 *
 * Implements a tiny recursive-descent parser for the surface the agent
 * actually needs:
 *   - numbers (int and float, including exponent notation)
 *   - the four basic operators + - * / with correct precedence
 *   - parentheses
 *   - unary minus
 *   - the caret `^` for right-associative exponentiation
 *   - a small set of one-arg math functions: sin cos tan asin acos atan
 *     log log2 log10 sqrt exp abs floor ceil round
 *   - two constants: `pi` and `e`
 *
 * Anything else (variables, assignment, method calls, semicolons) is
 * rejected with `bad_args`. The result is rounded to a configurable
 * precision (default 6 decimals) to keep transcript size bounded.
 *
 * Security note: the parser operates on a string of characters only.
 * There is no `eval`, no `Function()`, no `vm`. A malicious expression
 * like `process.exit(1)` simply fails to parse.
 */

import type { Tool, ToolManifest } from "../../types.ts";

const MAX_INPUT = 1_024;
const MAX_DEPTH = 32;

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: (x) => Math.sin(x),
  cos: (x) => Math.cos(x),
  tan: (x) => Math.tan(x),
  asin: (x) => Math.asin(x),
  acos: (x) => Math.acos(x),
  atan: (x) => Math.atan(x),
  sinh: (x) => Math.sinh(x),
  cosh: (x) => Math.cosh(x),
  tanh: (x) => Math.tanh(x),
  log: (x) => Math.log(x),
  log2: (x) => Math.log2(x),
  log10: (x) => Math.log10(x),
  sqrt: (x) => Math.sqrt(x),
  cbrt: (x) => Math.cbrt(x),
  exp: (x) => Math.exp(x),
  abs: (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x) => Math.round(x),
  sign: (x) => Math.sign(x),
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

/**
 * Recursive-descent parser. `parse()` returns a thunk that evaluates
 * the expression on demand. Throws on any parse error.
 */
class ExprParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): () => number {
    if (this.src.length > MAX_INPUT) {
      throw new Error(`expression exceeds ${MAX_INPUT}-char limit`);
    }
    const expr = this.parseExpr(0);
    this.skipWs();
    if (this.pos < this.src.length) {
      throw new Error(`unexpected character at position ${this.pos}: "${this.src[this.pos]}"`);
    }
    return expr;
  }

  private parseExpr(depth: number): () => number {
    if (depth > MAX_DEPTH) throw new Error(`expression nested too deeply (>${MAX_DEPTH})`);
    return this.parseAddSub(depth);
  }

  private parseAddSub(depth: number): () => number {
    let left = this.parseMulDiv(depth);
    for (;;) {
      this.skipWs();
      const c = this.src[this.pos];
      if (c !== "+" && c !== "-") return left;
      this.pos++;
      const right = this.parseMulDiv(depth);
      const op = c;
      const prev = left;
      left = () => (op === "+" ? prev() + right() : prev() - right());
    }
  }

  private parseMulDiv(depth: number): () => number {
    let left = this.parsePow(depth);
    for (;;) {
      this.skipWs();
      const c = this.src[this.pos];
      if (c !== "*" && c !== "/" && c !== "%") return left;
      this.pos++;
      const right = this.parsePow(depth);
      const op = c;
      const prev = left;
      left = () => {
        const r = right();
        if (op === "%" && r === 0) throw new Error("modulo by zero");
        return op === "*" ? prev() * r : op === "/" ? prev() / r : prev() % r;
      };
    }
  }

  private parsePow(depth: number): () => number {
    const base = this.parseUnary(depth);
    this.skipWs();
    if (this.src[this.pos] !== "^") return base;
    this.pos++;
    // Right-associative: a^b^c = a^(b^c).
    const exp = this.parsePow(depth);
    const prev = base;
    return () => Math.pow(prev(), exp());
  }

  private parseUnary(depth: number): () => number {
    this.skipWs();
    const c = this.src[this.pos];
    if (c === "+" || c === "-") {
      this.pos++;
      const inner = this.parseUnary(depth);
      const sign = c === "-" ? -1 : 1;
      return () => sign * inner();
    }
    return this.parseAtom(depth);
  }

  private parseAtom(depth: number): () => number {
    this.skipWs();
    const c = this.src[this.pos];
    if (c === "(") {
      this.pos++;
      const inner = this.parseExpr(depth + 1);
      this.skipWs();
      if (this.src[this.pos] !== ")") throw new Error(`expected ')' at position ${this.pos}`);
      this.pos++;
      return inner;
    }
    // Number
    if (c !== undefined && (c >= "0" && c <= "9") || c === ".") {
      return this.parseNumber();
    }
    // Identifier (function or constant)
    if (c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_")) {
      return this.parseIdent(0);
    }
    throw new Error(`unexpected character "${c ?? "<eof>"}" at position ${this.pos}`);
  }

  private parseNumber(): () => number {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c !== undefined && ((c >= "0" && c <= "9") || c === "." || c === "e" || c === "E" || c === "+" || c === "-")) {
        // Disallow sign chars outside of exponent: they only make sense
        // immediately after e/E.
        if ((c === "+" || c === "-") && this.pos > start) {
          const prev = this.src[this.pos - 1];
          if (prev !== "e" && prev !== "E") break;
        }
        this.pos++;
      } else break;
    }
    const text = this.src.slice(start, this.pos);
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`invalid number "${text}"`);
    return () => n;
  }

  private parseIdent(depth: number): () => number {
    void depth;
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_")) {
        this.pos++;
      } else break;
    }
    const name = this.src.slice(start, this.pos);
    if (name in CONSTANTS) {
      const v = CONSTANTS[name] as number;
      return () => v;
    }
    if (name in FUNCTIONS) {
      this.skipWs();
      if (this.src[this.pos] !== "(") {
        throw new Error(`expected '(' after function "${name}" at position ${this.pos}`);
      }
      this.pos++;
      const arg: () => number = this.parseExpr(depth + 1) as () => number;
      this.skipWs();
      if (this.src[this.pos] !== ")") {
        throw new Error(`expected ')' after function "${name}" at position ${this.pos}`);
      }
      this.pos++;
      const fn = FUNCTIONS[name] as (x: number) => number;
      return () => fn(arg());
    }
    throw new Error(`unknown identifier "${name}" at position ${start}`);
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else break;
    }
  }
}

export function createCalculatorTool(): Tool {
  const manifest: ToolManifest = {
    name: "calculator",
    description:
      "Safe arithmetic evaluator. Supports + - * / % ^ parentheses, " +
      "unary minus, constants `pi` and `e`, and functions " +
      "sin cos tan asin acos atan sinh cosh tanh log log2 log10 " +
      "sqrt cbrt exp abs floor ceil round sign. No `eval` — the " +
      "expression is hand-parsed. Anything outside the grammar " +
      "(variables, statements, semicolons) is rejected.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      expression: {
        type: "string",
        description: "The arithmetic expression to evaluate.",
        required: true,
      },
      precision: {
        type: "number",
        description: "Number of decimal places to keep in the result (default 6, max 15).",
        required: false,
      },
    },
    async execute(args) {
      const expr = args.expression;
      if (typeof expr !== "string" || !expr.trim()) {
        return { ok: false, content: "calculator requires a non-empty 'expression' string.", error: "bad_args" };
      }
      const precision = Math.min(Math.max(
        typeof args.precision === "number" ? Math.floor(args.precision) : 6,
        0,
      ), 15);
      try {
        const parser = new ExprParser(expr);
        const fn = parser.parse();
        const raw = fn();
        if (!Number.isFinite(raw)) {
          return { ok: false, content: `calculator: result is not finite (${raw})`, error: "math_error" };
        }
        const factor = Math.pow(10, precision);
        const rounded = Math.round(raw * factor) / factor;
        return {
          ok: true,
          content: precision === 0 ? `${rounded}` : `${rounded.toFixed(precision)}`,
          data: { expression: expr, value: rounded, raw },
        };
      } catch (err) {
        return { ok: false, content: `calculator: ${String((err as Error).message ?? err)}`, error: "parse_error" };
      }
    },
  };
}
