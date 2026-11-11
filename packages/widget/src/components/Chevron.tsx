/**
 * Chevron -- the one disclosure/dropdown affordance.
 *
 * A single glyph that ROTATES 180deg on open (via CSS), rather than swapping a
 * character (the old "^" / "v" pattern) or re-inlining the same <path> per
 * component. Purely decorative: aria-hidden, since the control it sits inside
 * carries the accessible name and aria-expanded state.
 */

interface ChevronProps {
  /** Rotates the chevron up when true (disclosure open / dropdown expanded). */
  open?: boolean;
  /** Extra class for size/color overrides at the call site. */
  className?: string;
}

export function Chevron({ open = false, className = "" }: ChevronProps) {
  const classes = ["glyph-chevron", open ? "glyph-chevron--open" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={classes}
      viewBox="0 0 10 6"
      width="8"
      height="5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M1 1L5 5L9 1" />
    </svg>
  );
}
