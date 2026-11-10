import { describe, it, expect } from "vitest";
import { paymentSummary } from "./paymentSummary.js";
import { PAYMENT_METHODS, type PaymentMethod } from "../types/intent.js";

const METHODS = Object.keys(PAYMENT_METHODS) as PaymentMethod[];
const GASLESS = METHODS.filter((m) => PAYMENT_METHODS[m].gasless);
const GAS = METHODS.filter((m) => !PAYMENT_METHODS[m].gasless);

describe("paymentSummary", () => {
  it("states the gas state the payment table carries, for every method", () => {
    for (const method of GASLESS) {
      expect(paymentSummary(method, false, "covered")).toMatch(/^No gas/);
      expect(paymentSummary(method, true, "none")).toMatch(/^No gas/);
    }
    for (const method of GAS) {
      expect(paymentSummary(method, false, "none")).toMatch(/^Gas needed/);
      expect(paymentSummary(method, true, "none")).toMatch(/^Gas needed/);
    }
  });

  it("claims no gas only when the allowance is known to cover the pull", () => {
    // A short Permit2 allowance costs one gasful approve first (#29).
    expect(paymentSummary("permit2", true, "required")).toMatch(/^Gas for a one-time approval/);
    // Unknown: a conditional that is true either way.
    expect(paymentSummary("permit2", true, "unknown")).toMatch(
      /^Gas only if an approval is needed/,
    );
  });

  it("names the second signature on a pull-bearing quote", () => {
    expect(paymentSummary("erc3009", true, "none")).toMatch(/sign twice/);
    expect(paymentSummary("permit2", true, "covered")).toMatch(/sign twice/);
    expect(paymentSummary("permit2", true, "required")).toMatch(/sign twice/);
    // Riddler labels stealth quotes "pimlico" and still serves a pull.
    expect(paymentSummary("pimlico", true, "none")).toMatch(/sign twice/);
  });

  it("promises no signature count when the quote carries no pull", () => {
    // A preview names erc3009/permit2 with the pull stripped.
    for (const method of GASLESS) {
      expect(paymentSummary(method, false, "unknown")).not.toMatch(/sign/);
    }
  });

  it("puts the approval before the signature on the approval route", () => {
    const line = paymentSummary("approval", false, "none");
    expect(line.indexOf("approve")).toBeGreaterThan(-1);
    expect(line.indexOf("approve")).toBeLessThan(line.indexOf("sign"));
  });

  it("asks a deposit route for no signature at all", () => {
    expect(paymentSummary("deposit", true, "none")).not.toMatch(/sign/);
  });
});
