import qrcode from "qrcode-generator";

export interface QrSvg {
  /** Total viewBox side length, in modules, including the quiet-zone margin. */
  size: number;
  /**
   * SVG path data covering every dark module as a 1x1 unit square, offset by
   * the quiet-zone `margin`. Render as a single <path> with
   * shape-rendering="crispEdges" for seam-free, resolution-independent output.
   */
  path: string;
}

/**
 * Build the inline-SVG geometry for a QR code encoding `value`.
 *
 * Error-correction level M (~15% recoverable) with auto-selected version (the
 * smallest that fits). The value is encoded verbatim -- for a Tron deposit this
 * is the base58 address, which wallets read directly on scan. Pure and
 * synchronous so it is trivially unit-testable and needs no effect/canvas.
 */
export function buildQrSvg(value: string, margin = 4): QrSvg {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + margin * 2;

  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
  }

  return { size, path };
}
