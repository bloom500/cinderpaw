export interface SpendTarget {
  provider: string;
  model: string;
  baseUrl: string;
}

/** Route-specific billing rates. Dollar values are per one million tokens. */
export interface InferencePrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
}

export interface BillableInferenceUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  freshPromptTokens?: number;
}

export type AutonomousSpendDeniedReason = "cloud_not_allowed" | "unknown_price" | "budget" | "stopped";

export class AutonomousSpendDeniedError extends Error {
  constructor(
    readonly reason: AutonomousSpendDeniedReason,
    message: string,
  ) {
    super(message);
    this.name = "AutonomousSpendDeniedError";
  }
}

export interface SpendReservation {
  settle(actual: { target: SpendTarget; usage: BillableInferenceUsage }): void;
  /** Conservatively charge the full hold when provider-side work may be billable. */
  commitMaximum(): void;
  release(): void;
}

export class InferenceSpendAuthority {
  readonly #maxCostUsd: number;
  readonly #allowCloud: boolean;
  readonly #price: (target: SpendTarget) => InferencePrice | null;
  readonly #abort = new AbortController();
  #spentUsd = 0;
  #reservedUsd = 0;

  constructor(options: {
    maxCostUsd: number;
    allowCloud: boolean;
    price: (target: SpendTarget) => InferencePrice | null;
  }) {
    this.#maxCostUsd = options.maxCostUsd;
    this.#allowCloud = options.allowCloud;
    this.#price = options.price;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get reservedUsd(): number {
    return this.#reservedUsd;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  stop(reason: unknown): void {
    if (!this.#abort.signal.aborted) this.#abort.abort(reason);
  }

  reserve(request: {
    targets: readonly SpendTarget[];
    maxPromptTokens: number;
    maxCompletionTokens: number;
  }): SpendReservation {
    if (this.signal.aborted) {
      throw new AutonomousSpendDeniedError("stopped", "autonomous inference scope is stopped");
    }

    let reserved = 0;
    for (const target of request.targets) {
      if (!isLoopback(target.baseUrl) && !this.#allowCloud) {
        throw new AutonomousSpendDeniedError(
          "cloud_not_allowed",
          `autonomous cloud inference is not authorized for ${target.provider}/${target.model}`,
        );
      }
      const price = this.#priceFor(target);
      if (price === null) {
        throw new AutonomousSpendDeniedError(
          "unknown_price",
          `autonomous inference price is unknown for ${target.provider}/${target.model}`,
        );
      }
      // Prompt caching cannot be predicted before the request. Reserve every
      // prompt token at the most expensive possible input/cache rate and every
      // generated token at the output rate. This is intentionally an upper
      // bound, not a blended estimate.
      const promptRate = Math.max(
        price.inputPerMillionUsd,
        price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd,
        price.cacheWritePerMillionUsd ?? price.inputPerMillionUsd,
      );
      reserved = Math.max(
        reserved,
        usd(request.maxPromptTokens, promptRate) +
          usd(request.maxCompletionTokens, price.outputPerMillionUsd),
      );
    }

    if (this.#spentUsd + this.#reservedUsd + reserved > this.#maxCostUsd) {
      throw new AutonomousSpendDeniedError(
        "budget",
        `autonomous inference would exceed the $${this.#maxCostUsd} scope`,
      );
    }

    this.#reservedUsd += reserved;
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      this.#reservedUsd = Math.max(0, this.#reservedUsd - reserved);
    };

    return {
      release,
      commitMaximum: () => {
        if (!open) return;
        release();
        this.#spentUsd += reserved;
        if (reserved > 0 && this.#spentUsd >= this.#maxCostUsd) {
          this.stop("autonomous inference cost cap exhausted");
        }
      },
      settle: ({ target, usage }) => {
        if (!open) return;
        const actualPrice = this.#priceFor(target);
        release();
        if (actualPrice === null) {
          this.stop(`autonomous inference settled against unknown price for ${target.model}`);
          return;
        }
        this.#spentUsd += costOfUsage(usage, actualPrice);
        if (this.#spentUsd > this.#maxCostUsd) {
          this.stop("autonomous inference cost cap exhausted");
        }
      },
    };
  }

  #priceFor(target: SpendTarget): InferencePrice | null {
    if (isLoopback(target.baseUrl)) {
      return { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };
    }
    const price = this.#price(target);
    return price !== null && validPrice(price) ? price : null;
  }
}

function usd(tokens: number, perMillionUsd: number): number {
  return (Math.max(0, tokens) / 1_000_000) * perMillionUsd;
}

function validPrice(price: InferencePrice): boolean {
  return [
    price.inputPerMillionUsd,
    price.outputPerMillionUsd,
    price.cacheReadPerMillionUsd,
    price.cacheWritePerMillionUsd,
  ].every((rate) => rate === undefined || (Number.isFinite(rate) && rate >= 0));
}

function costOfUsage(usage: BillableInferenceUsage, price: InferencePrice): number {
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const freshPrompt = Math.max(
    0,
    usage.freshPromptTokens ?? usage.promptTokens,
  );
  return (
    usd(freshPrompt, price.inputPerMillionUsd) +
    usd(cacheRead, price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd) +
    usd(cacheWrite, price.cacheWritePerMillionUsd ?? price.inputPerMillionUsd) +
    usd(usage.completionTokens, price.outputPerMillionUsd)
  );
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
