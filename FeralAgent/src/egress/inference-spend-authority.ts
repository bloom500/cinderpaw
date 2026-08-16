export interface SpendTarget {
  provider: string;
  model: string;
  baseUrl: string;
}

export type AutonomousSpendDeniedReason = "unknown_price" | "budget" | "stopped";

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
  settle(actual: { target: SpendTarget; actualBillableTokens: number }): void;
  release(): void;
}

export class InferenceSpendAuthority {
  readonly #maxCostUsd: number;
  readonly #pricePer1kUsd: (target: SpendTarget) => number | null;
  readonly #abort = new AbortController();
  #spentUsd = 0;
  #reservedUsd = 0;

  constructor(options: {
    maxCostUsd: number;
    pricePer1kUsd: (target: SpendTarget) => number | null;
  }) {
    this.#maxCostUsd = options.maxCostUsd;
    this.#pricePer1kUsd = options.pricePer1kUsd;
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
    maxBillableTokens: number;
  }): SpendReservation {
    if (this.signal.aborted) {
      throw new AutonomousSpendDeniedError("stopped", "autonomous inference scope is stopped");
    }

    let worstPrice = 0;
    for (const target of request.targets) {
      const price = this.#priceFor(target);
      if (price === null) {
        throw new AutonomousSpendDeniedError(
          "unknown_price",
          `autonomous inference price is unknown for ${target.provider}/${target.model}`,
        );
      }
      worstPrice = Math.max(worstPrice, price);
    }

    const reserved = (Math.max(0, request.maxBillableTokens) / 1_000) * worstPrice;
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
      settle: ({ target, actualBillableTokens }) => {
        if (!open) return;
        const actualPrice = this.#priceFor(target);
        release();
        if (actualPrice === null) {
          this.stop(`autonomous inference settled against unknown price for ${target.model}`);
          return;
        }
        this.#spentUsd += (Math.max(0, actualBillableTokens) / 1_000) * actualPrice;
        if (this.#spentUsd > this.#maxCostUsd) {
          this.stop("autonomous inference cost cap exhausted");
        }
      },
    };
  }

  #priceFor(target: SpendTarget): number | null {
    if (isLoopback(target.baseUrl)) return 0;
    const price = this.#pricePer1kUsd(target);
    return price !== null && Number.isFinite(price) && price >= 0 ? price : null;
  }
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
