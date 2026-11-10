/**
 * `readTronAddress` takes the provider as an argument precisely so these tests
 * can hand it real objects rather than patch `window` and stand up a fake
 * extension. Every provider below is an ordinary object satisfying the
 * `TronLinkProvider` interface, so what is exercised is the real decision logic
 * against the real shapes TronLink actually produces.
 */
import { describe, it, expect } from "vitest";
import {
  readTronAddress,
  describeTronOutcome,
  type TronLinkProvider,
  type TronAddressOutcome,
} from "./tronlink.js";

// A real Tron mainnet address (34 chars, leading T, base58 alphabet).
const TRON_ADDRESS = "TS4MAKFRQaTkjZ7dWK7yxfvVmLtV2qck5o";

/**
 * Build a provider that answers `tron_requestAccounts` with `response` and
 * exposes `base58` afterwards. `base58: false` is not a stand-in for "no
 * address": it is literally what TronWeb sets while the wallet is locked.
 */
function provider(opts: {
  response?: unknown;
  throws?: Error;
  base58?: unknown;
}): TronLinkProvider {
  const { throws } = opts;
  return {
    request: () => (throws ? Promise.reject(throws) : Promise.resolve(opts.response)),
    tronWeb: { defaultAddress: { base58: opts.base58 } },
  };
}

describe("readTronAddress", () => {
  it("reports unavailable when the extension is not installed", async () => {
    expect(await readTronAddress(undefined)).toEqual({ kind: "unavailable" });
  });

  it("returns the address once the user approves", async () => {
    const outcome = await readTronAddress(
      provider({ response: { code: 200 }, base58: TRON_ADDRESS }),
    );
    expect(outcome).toEqual({ kind: "ok", address: TRON_ADDRESS });
  });

  it("accepts an older build that resolves with no code envelope", async () => {
    // Some TronLink versions resolve undefined rather than {code}. The address
    // read is the real check, so a missing code must not be read as a refusal.
    const outcome = await readTronAddress(provider({ response: undefined, base58: TRON_ADDRESS }));
    expect(outcome).toEqual({ kind: "ok", address: TRON_ADDRESS });
  });

  it("distinguishes a refusal from a failure", async () => {
    expect(await readTronAddress(provider({ response: { code: 4001 } }))).toEqual({
      kind: "rejected",
    });
  });

  it("treats a thrown rejection the same as a rejection code", async () => {
    // The extension refuses by throwing in some versions and by returning a code
    // in others. Both are the user declining, and both must read that way.
    const outcome = await readTronAddress(
      provider({ throws: new Error("User rejected the request") }),
    );
    expect(outcome).toEqual({ kind: "rejected" });
  });

  it("reports an unexpected code as a failure, carrying the code", async () => {
    const outcome = await readTronAddress(provider({ response: { code: 4000 } }));
    expect(outcome).toEqual({ kind: "failed", cause: "TronLink returned code 4000" });
  });

  it("reports a thrown non-rejection as a failure", async () => {
    const outcome = await readTronAddress(provider({ throws: new Error("network is down") }));
    expect(outcome).toEqual({ kind: "failed", cause: "network is down" });
  });

  // `false` is the real locked value, not a placeholder. Reading it as a string
  // would produce "false" and hand that to an address validator.
  it("reports locked when TronWeb reports base58 false", async () => {
    const outcome = await readTronAddress(provider({ response: { code: 200 }, base58: false }));
    expect(outcome).toEqual({ kind: "locked" });
  });

  it("reports locked when there is no address at all", async () => {
    const outcome = await readTronAddress(provider({ response: { code: 200 } }));
    expect(outcome).toEqual({ kind: "locked" });
  });

  // The load-bearing case. Approval is not evidence that what came back is an
  // address, so an approved-but-wrong response must not reach the field. If
  // this ever returns ok, a bad value gets filled in as a payout destination.
  it("refuses an approved response that is not a Tron address", async () => {
    const evmAddress = "0x1111111111111111111111111111111111111111";
    const outcome = await readTronAddress(
      provider({ response: { code: 200 }, base58: evmAddress }),
    );
    expect(outcome).toEqual({ kind: "malformed", received: evmAddress });
  });

  it("refuses a base58 string that is the wrong length", async () => {
    const outcome = await readTronAddress(
      provider({ response: { code: 200 }, base58: TRON_ADDRESS.slice(0, 20) }),
    );
    expect(outcome.kind).toBe("malformed");
  });

  it("refuses a non-string address rather than coercing it", async () => {
    const outcome = await readTronAddress(provider({ response: { code: 200 }, base58: 42 }));
    expect(outcome).toEqual({ kind: "malformed", received: "42" });
  });

  // An unbounded echo of an externally-chosen string is how an error message
  // becomes someone else's payload once it is rendered or logged.
  it("clips an oversized value rather than echoing it whole", async () => {
    const huge = "T".repeat(5000);
    const outcome = await readTronAddress(provider({ response: { code: 200 }, base58: huge }));
    expect(outcome.kind).toBe("malformed");
    if (outcome.kind === "malformed") {
      expect(outcome.received.length).toBeLessThan(100);
      expect(outcome.received.endsWith("[clipped]")).toBe(true);
    }
  });

  it("clips an oversized failure cause too", async () => {
    const outcome = await readTronAddress(provider({ throws: new Error("x".repeat(5000)) }));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.cause.length).toBeLessThan(100);
    }
  });
});

describe("describeTronOutcome", () => {
  // Every non-ok outcome must have copy. The switch is exhaustive, so a new
  // kind fails the build rather than rendering an empty message.
  it("gives distinct plain-language copy for every failure kind", () => {
    const kinds: Exclude<TronAddressOutcome, { kind: "ok" }>[] = [
      { kind: "unavailable" },
      { kind: "rejected" },
      { kind: "locked" },
      { kind: "malformed", received: "0xdead" },
      { kind: "failed", cause: "boom" },
    ];
    const messages = kinds.map(describeTronOutcome);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      // App copy rule: no em-dashes, no jargon aimed at developers.
      expect(message).not.toContain("--");
    }
    expect(new Set(messages).size).toBe(messages.length);
  });

  // The cause and the received value are for logs and for us, not for the user.
  // Copy that pasted an extension-supplied string onto the screen would be the
  // unbounded echo again, one layer up.
  it("never puts the extension's own string in the user-facing copy", () => {
    expect(describeTronOutcome({ kind: "malformed", received: "0xdeadbeef" })).not.toContain(
      "0xdeadbeef",
    );
    expect(describeTronOutcome({ kind: "failed", cause: "socket hang up" })).not.toContain(
      "socket hang up",
    );
  });
});
