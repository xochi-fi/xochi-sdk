import { describe, it, expect } from "vitest";
import { buildQrSvg } from "./qr.js";

// A representative Tron (base58) deposit address.
const TRON_ADDR = "TByzQxR5N4jJ9wD8m6Yb3s2Kf1H7cV0aQ";

describe("buildQrSvg", () => {
  it("produces a structurally valid QR geometry", () => {
    const { size, path } = buildQrSvg(TRON_ADDR);
    // Smallest QR is version 1 = 21 modules; size includes 2x the quiet zone.
    expect(size).toBeGreaterThanOrEqual(21 + 8);
    expect(path.startsWith("M")).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same input", () => {
    expect(buildQrSvg(TRON_ADDR)).toEqual(buildQrSvg(TRON_ADDR));
  });

  it("encodes the value (distinct inputs -> distinct geometry)", () => {
    const a = buildQrSvg(TRON_ADDR);
    const b = buildQrSvg(TRON_ADDR.slice(0, -1) + "Z");
    expect(a.path).not.toBe(b.path);
  });

  it("honors the quiet-zone margin", () => {
    const noMargin = buildQrSvg(TRON_ADDR, 0);
    const withMargin = buildQrSvg(TRON_ADDR, 4);
    expect(withMargin.size).toBe(noMargin.size + 8);
  });
});
