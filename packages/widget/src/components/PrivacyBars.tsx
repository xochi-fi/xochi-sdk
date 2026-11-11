/**
 * PrivacyBars
 *
 * Three ascending bars that signal a settlement's privacy depth at a glance:
 * more filled bars = more private. Public fills 1, Stealth fills 2. `active`
 * inks the filled bars in the current accent; inactive renders them ghosted so
 * the shape still reads.
 */

export function PrivacyBars({ count, active }: { count: number; active: boolean }) {
  return (
    <svg viewBox="0 0 20 14" width="18" height="13" className="privacy-bars" aria-hidden="true">
      <rect
        x="1"
        y="9"
        width="4"
        height="5"
        rx="1"
        fill={active ? "currentColor" : "var(--text-ghost)"}
        opacity={count >= 1 ? 1 : 0.2}
      />
      <rect
        x="8"
        y="5"
        width="4"
        height="9"
        rx="1"
        fill={active ? "currentColor" : "var(--text-ghost)"}
        opacity={count >= 2 ? 1 : 0.2}
      />
      <rect
        x="15"
        y="1"
        width="4"
        height="13"
        rx="1"
        fill={active ? "currentColor" : "var(--text-ghost)"}
        opacity={count >= 3 ? 1 : 0.2}
      />
    </svg>
  );
}
