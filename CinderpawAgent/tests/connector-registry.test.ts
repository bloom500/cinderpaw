import { describe, expect, it } from "bun:test";
import {
  registerTransport,
  registeredTransports,
  transportFor,
  type LiveConnector,
} from "../src/transports/registry.ts";

const stub = (): LiveConnector => ({
  async start() {},
  async stop() {},
  health: () => ({ live: true }),
  async send() {},
});

describe("transport registry", () => {
  it("hands back the factory it was given", () => {
    const made: string[] = [];
    registerTransport("fake", () => {
      made.push("built");
      return stub();
    });
    const factory = transportFor("fake");
    expect(factory).toBeDefined();
    factory!();
    expect(made).toEqual(["built"]);
    expect(registeredTransports()).toContain("fake");
  });

  it("returns undefined for a transport nobody registered", () => {
    // The manager must be able to tell "this connector has no transport in
    // this build" from "it failed to start" — a stranger with a catalog entry
    // nobody implemented gets a reason, not silence.
    expect(transportFor("nope")).toBeUndefined();
  });

  it("does not build the connector until someone asks for one", () => {
    let built = 0;
    registerTransport("lazy", () => {
      built += 1;
      return stub();
    });
    expect(built).toBe(0);
    transportFor("lazy")!();
    expect(built).toBe(1);
  });
});
