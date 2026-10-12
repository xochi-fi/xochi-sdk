import { describe, it, expect } from "vitest";
import { recipientEchoError } from "./recipientEcho.js";

// On a non-EVM destination route the solvable quote must echo exactly the
// recipient the client asked for. This pins the fail-closed vs pass-through
// boundary the quote gate relies on.
describe("recipientEchoError", () => {
  it("passes an EVM route (no recipient requested), regardless of echo", () => {
    expect(recipientEchoError(undefined, undefined)).toBeNull();
    expect(recipientEchoError(undefined, "TByz...ignored")).toBeNull();
  });

  it("passes when the echo matches the requested recipient verbatim", () => {
    const addr = "TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ";
    expect(recipientEchoError(addr, addr)).toBeNull();
  });

  it("fails closed when the quote omits the recipient echo", () => {
    expect(recipientEchoError("TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ", undefined)).toBe(
      "recipient_unconfirmed",
    );
    expect(recipientEchoError("TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ", "")).toBe(
      "recipient_unconfirmed",
    );
  });

  it("fails closed on any mismatch, including case (base58 is case-sensitive)", () => {
    expect(
      recipientEchoError("TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ", "TZZZQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ"),
    ).toBe("recipient_mismatch");
    // Same characters, different case -> a different Tron address -> mismatch.
    expect(
      recipientEchoError("TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ", "tbYZqXr5n4Jj9Wd8M6yB3S2kF1h7Cv0Aq"),
    ).toBe("recipient_mismatch");
  });
});
