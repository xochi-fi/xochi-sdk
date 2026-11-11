/**
 * QrCode
 *
 * Renders a value as an inline SVG QR code. Self-contained (draws its own light
 * quiet-zone background + dark modules) so it scans without relying on the
 * surrounding element, and resolution-independent via a module-unit viewBox.
 * Colors come from CSS custom properties (`--qr-bg` / `--qr-fg`) so the frame
 * can theme them while keeping dark-on-light contrast for scanners.
 */

import { buildQrSvg } from "../../lib/qr.js";

interface QrCodeProps {
  /** Encoded verbatim (e.g. a base58 deposit address). */
  value: string;
  /** Accessible label; the raw value is not announced (it is shown as text). */
  label: string;
  className?: string;
}

export function QrCode({ value, label, className }: QrCodeProps) {
  const { size, path } = buildQrSvg(value);

  return (
    <svg
      className={className}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="var(--qr-bg)" />
      <path d={path} fill="var(--qr-fg)" />
    </svg>
  );
}
