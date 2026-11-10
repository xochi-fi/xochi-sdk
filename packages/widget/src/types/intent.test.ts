/**
 * Payment-method display tests: which method a quote resolves to, and the gas
 * claim shown next to it.
 */

import { describe, it, expect } from "vitest";
import { resolvePaymentMethod, paysNoGas, PAYMENT_METHODS } from "./intent.js";
import type { PaymentMethod } from "./intent.js";

// #301: the badge must reflect the solver's real settlement path. When Riddler
// serves a method the permit type can't infer (x402/mpp/approval carry no
// pull_authorization), the old permit-only guess mislabeled both the method and
// its gasless promise. The resolver now prefers quote.paymentMethod, keying into
// PAYMENT_METHODS for the honest label + gasless flag.
describe("resolvePaymentMethod", () => {
  const serverMethods: PaymentMethod[] = [
    "erc3009",
    "permit2",
    "pimlico",
    "x402",
    "mpp",
    "approval",
  ];

  it.each(serverMethods)("prefers the server method %s over local inference", (method) => {
    // Pass a permit type + gasless that would otherwise infer a DIFFERENT method,
    // proving the server value wins.
    const resolved = resolvePaymentMethod(method, "erc3009", true, undefined);
    expect(resolved).toBe(method);
  });

  it("labels x402 as pay-per-call and NOT gasless from the server value", () => {
    const method = resolvePaymentMethod("x402", "none", true, undefined);
    expect(method).toBe("x402");
    expect(PAYMENT_METHODS[method].label).toBe("Pay-per-call");
    expect(PAYMENT_METHODS[method].gasless).toBe(false);
  });

  it("labels approval as NOT gasless even when quote.gasless is true", () => {
    const method = resolvePaymentMethod("approval", "none", true, undefined);
    expect(method).toBe("approval");
    expect(PAYMENT_METHODS[method].gasless).toBe(false);
  });

  it("keeps mpp as a gasless agent relay", () => {
    const method = resolvePaymentMethod("mpp", "none", false, undefined);
    expect(method).toBe("mpp");
    expect(PAYMENT_METHODS[method].label).toBe("Agent Relay");
    expect(PAYMENT_METHODS[method].gasless).toBe(true);
  });

  it("keeps pimlico as sponsored/gasless", () => {
    const method = resolvePaymentMethod("pimlico", "none", true, undefined);
    expect(method).toBe("pimlico");
    expect(PAYMENT_METHODS[method].gasless).toBe(true);
  });

  // Fallback path: older/edge quotes omit payment_method entirely.
  describe("fallback to permit inference when the server value is absent", () => {
    it("maps erc3009 permit to erc3009", () => {
      expect(resolvePaymentMethod(undefined, "erc3009", true, undefined)).toBe("erc3009");
    });

    it("maps permit2 and eip2612 permits to permit2", () => {
      expect(resolvePaymentMethod(undefined, "permit2", true, undefined)).toBe("permit2");
      expect(resolvePaymentMethod(undefined, "eip2612", true, undefined)).toBe("permit2");
    });

    it("infers pimlico for a gasless quote with no permit", () => {
      expect(resolvePaymentMethod(undefined, "none", true, undefined)).toBe("pimlico");
      expect(resolvePaymentMethod(undefined, undefined, true, undefined)).toBe("pimlico");
    });

    it("infers approval for a non-gasless quote with no permit", () => {
      expect(resolvePaymentMethod(undefined, "none", false, undefined)).toBe("approval");
    });
  });

  // Defensive: a malformed/unknown server value must not key into PAYMENT_METHODS
  // as undefined; it falls through to inference instead.
  it("ignores an unknown server method and falls back to inference", () => {
    expect(resolvePaymentMethod("venmo" as PaymentMethod, "erc3009", false, undefined)).toBe(
      "erc3009",
    );
    expect(resolvePaymentMethod("venmo" as PaymentMethod, "none", false, undefined)).toBe(
      "approval",
    );
  });

  // A deposit route is the ONE case where the server's own value is wrong rather
  // than merely unknowable locally, so it is the one case that overrides it.
  //
  // These arguments are not invented. They are the live staging response to a
  // Tron-origin quote (USDT 728126428 -> USDC 8453), which returns
  // `payment_method: "permit2"` next to `gasless: false` and a deposit address.
  // Preferring the server value rendered "Permit2 (gasless)" on a route with no
  // permit, no pull and no signature -- and contradicted the same response's own
  // gasless flag, because PAYMENT_METHODS holds the honest per-method value and
  // permit2 is gasless.
  describe("deposit route (Tron origin)", () => {
    const DEPOSIT_ADDR = "TUt3WQW49zuXPwZyf5SLKj8tf5Kt1wgJhp";

    it("overrides the solver's permit2 claim when a deposit address is present", () => {
      expect(resolvePaymentMethod("permit2", "none", false, DEPOSIT_ADDR)).toBe("deposit");
    });

    it("never promises gasless on a deposit route", () => {
      const method = resolvePaymentMethod("permit2", "none", false, DEPOSIT_ADDR);
      expect(PAYMENT_METHODS[method].gasless).toBe(false);
      expect(PAYMENT_METHODS[method].label).toBe("Deposit");
    });

    // The override keys on the deposit address alone, so it must not fire on any
    // pull route regardless of what else the response says.
    it.each(serverMethods)("leaves %s alone when there is no deposit address", (method) => {
      expect(resolvePaymentMethod(method, "none", true, undefined)).toBe(method);
    });

    it("wins even over a gasless-looking permit inference", () => {
      expect(resolvePaymentMethod(undefined, "erc3009", true, DEPOSIT_ADDR)).toBe("deposit");
    });
  });
});

// A Permit2 pull with a short allowance sends one gasful approve(Permit2) before
// the first swap, so "no gas" is claimed only once the allowance is known to
// cover the amount.
// The gas wording itself (paymentSummary) is pinned in lib/paymentSummary.test.ts.
describe("paysNoGas", () => {
  it("claims no gas only when no approval is outstanding", () => {
    expect(paysNoGas("permit2", "covered")).toBe(true);
    expect(paysNoGas("erc3009", "none")).toBe(true);
  });

  it("never claims no gas while an approval is due or unknown", () => {
    expect(paysNoGas("permit2", "required")).toBe(false);
    expect(paysNoGas("permit2", "unknown")).toBe(false);
  });

  it("never claims no gas for a method that is not gasless", () => {
    for (const method of ["approval", "deposit", "x402"] as const) {
      expect(paysNoGas(method, "none")).toBe(false);
    }
  });
});
