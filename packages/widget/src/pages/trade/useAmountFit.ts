/**
 * Shrink-to-fit with a floor, for the Send / Receive amounts.
 *
 * The type shrinks with the character count (`--amount-chars`, read by
 * `.amount-fit` in trade-layout.css) down to a 13px floor. Past the floor the
 * value is truncated with an ellipsis rather than shrunk into illegibility, and
 * the user can reveal it: `expanded` gives the amount the row's full width on
 * its own line, above the token selector.
 *
 * Truncation is measured, not predicted: glyph widths, the selector's width and
 * the container all vary, so the only honest test is whether the input's text
 * is wider than its box.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export interface AmountFit<T extends HTMLElement = HTMLInputElement> {
  /** The element holding the value: the amount field, or a read-only value. */
  ref: RefObject<T | null>;
  /** The value is wider than its box at the floor size, so it shows an ellipsis. */
  truncated: boolean;
  /** The user asked to see the whole value. */
  expanded: boolean;
  toggle: () => void;
  style: CSSProperties;
}

export function useAmountFit<T extends HTMLElement = HTMLInputElement>(
  value: string,
): AmountFit<T> {
  const ref = useRef<T>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    // Webfonts change glyph widths after first paint; the box does not resize,
    // so the observer alone would miss it.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) measure();
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [value, expanded]);

  // A cleared field has nothing to reveal; do not leave the row expanded.
  useEffect(() => {
    if (!value) setExpanded(false);
  }, [value]);

  const toggle = useCallback((): void => setExpanded((open) => !open), []);

  // Floored so short amounts keep the full size; the CSS caps the result at the
  // breakpoint's default size either way.
  const style = { "--amount-chars": Math.max(value.length, 7) } as CSSProperties;

  return { ref, truncated, expanded, toggle, style };
}
