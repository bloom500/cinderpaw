import { describe, expect, test } from "bun:test";
import {
  AutonomousSpendDeniedError,
  InferenceSpendAuthority,
  type SpendTarget,
} from "../src/egress/inference-spend-authority.ts";

const known: SpendTarget = {
  provider: "known",
  model: "priced-model",
  baseUrl: "https://api.example.test/v1",
};

const unknown: SpendTarget = {
  provider: "unknown",
  model: "mystery-model",
  baseUrl: "https://unknown.example.test/v1",
};

describe("InferenceSpendAuthority", () => {
  test("refuses an autonomous request before reserving when any possible cloud route has unknown pricing", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      pricePer1kUsd: (target) => target.provider === "known" ? 0.01 : null,
    });

    expect(() => authority.reserve({
      targets: [known, unknown],
      maxBillableTokens: 1_000,
    })).toThrow(AutonomousSpendDeniedError);
    expect(authority.reservedUsd).toBe(0);
    expect(authority.spentUsd).toBe(0);
  });

  test("counts in-flight reservations so concurrent requests cannot oversubscribe the USD cap", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 0.015,
      pricePer1kUsd: () => 0.01,
    });

    const first = authority.reserve({ targets: [known], maxBillableTokens: 1_000 });
    expect(authority.reservedUsd).toBeCloseTo(0.01);
    expect(() => authority.reserve({
      targets: [known],
      maxBillableTokens: 1_000,
    })).toThrow(AutonomousSpendDeniedError);

    first.settle({ target: known, actualBillableTokens: 500 });
    expect(authority.reservedUsd).toBe(0);
    expect(authority.spentUsd).toBeCloseTo(0.005);

    expect(() => authority.reserve({
      targets: [known],
      maxBillableTokens: 1_000,
    })).not.toThrow();
  });

  test("charges local loopback targets at zero without requiring a cloud price", () => {
    const local = { ...known, baseUrl: "http://127.0.0.1:11435" };
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 0,
      pricePer1kUsd: () => null,
    });

    const reservation = authority.reserve({
      targets: [local],
      maxBillableTokens: 100_000,
    });
    reservation.settle({ target: local, actualBillableTokens: 100_000 });

    expect(authority.reservedUsd).toBe(0);
    expect(authority.spentUsd).toBe(0);
  });

  test("stop aborts the shared signal and rejects every later reservation", () => {
    const authority = new InferenceSpendAuthority({
      maxCostUsd: 1,
      pricePer1kUsd: () => 0.01,
    });

    authority.stop("user stopped");

    expect(authority.signal.aborted).toBe(true);
    expect(authority.signal.reason).toBe("user stopped");
    expect(() => authority.reserve({
      targets: [known],
      maxBillableTokens: 1,
    })).toThrow(AutonomousSpendDeniedError);
  });
});
