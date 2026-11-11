import { describe, it, expect } from "vitest";
import { reportError } from "./errorReport.js";
import { ApiError } from "@xochi/client";

describe("reportError", () => {
  it("maps an ApiError to a StructuredError carrying code + retryAfter", () => {
    expect(reportError(new ApiError("slow down", 429, 30)).value).toEqual({
      message: "slow down",
      code: 429,
      retryAfter: 30,
    });
  });

  it("keeps the machine category when an HTTP failure has no quote", () => {
    const error = new ApiError(
      "Lookup unavailable",
      503,
      undefined,
      false,
      false,
      "tag_resolution_unavailable",
    );
    expect(reportError(error).value).toEqual({
      message: "Lookup unavailable",
      code: 503,
      retryAfter: undefined,
      errorCategory: "tag_resolution_unavailable",
    });
  });

  it("maps a plain Error to its message", () => {
    expect(reportError(new Error("boom")).value).toBe("boom");
  });

  it("carries no value for a non-Error throw, so the machine's fallback applies", () => {
    expect(reportError("nope").value).toBeNull();
  });

  it("flags a wallet rejection", () => {
    expect(reportError(new Error("User rejected the request.")).rejected).toBe(true);
    expect(reportError(new Error("boom")).rejected).toBe(false);
  });

  it("flags notAccepted only from the ApiError's own flag", () => {
    expect(reportError(new ApiError("HTTP 503", 503, 30, true)).notAccepted).toBe(true);
    expect(reportError(new ApiError("HTTP 503", 503, 30)).notAccepted).toBeUndefined();
    const lookalike = Object.assign(new Error("HTTP 503"), { notAccepted: true });
    expect(reportError(lookalike).notAccepted).toBeUndefined();
  });
});
