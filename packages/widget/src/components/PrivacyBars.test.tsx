// @vitest-environment jsdom

/**
 * The first render test in this repo.
 *
 * `vitest.config.ts` ran `environment: "node"` with `include` globbing only
 * `*.test.ts`, so no React component could be rendered at all -- across 142
 * frontend source files there was not one render test, and the two
 * highest-complexity units in the codebase (`useIntent` and `SwapPanel`) were
 * never executed by anything. About ten files compensated by `readFileSync`-ing
 * a `.tsx` and asserting literal JSX substrings, which breaks on a rename or a
 * Prettier setting and passes even when the control under test is wired to
 * nothing.
 *
 * This file exists partly as the pattern to copy: a `// @vitest-environment
 * jsdom` pragma at the top (the `node` default is kept for the ~2600 pure tests,
 * which do not need a DOM and should not pay for one), then render and assert on
 * what a user or the accessibility tree can actually observe.
 *
 * It is not a placeholder. `PrivacyBars` encodes a real contract -- "more filled
 * bars = more private" -- as three `opacity` thresholds, and an off-by-one in any
 * of them would misreport a settlement's privacy depth in the trade panel while
 * looking perfectly fine in code review.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PrivacyBars } from "./PrivacyBars.js";

afterEach(cleanup);

/** Opacity of each bar, left to right. Filled is 1, ghosted is 0.2. */
const barOpacities = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("rect")].map((r) => r.getAttribute("opacity") ?? "");

describe("PrivacyBars", () => {
  it("fills exactly as many bars as the count, cumulatively", () => {
    // The thresholds are `count >= 1 | 2 | 3`, so each step must light one MORE
    // bar without unlighting an earlier one. An off-by-one here understates or
    // overstates privacy depth.
    expect(barOpacities(render(<PrivacyBars count={0} active />).container)).toEqual([
      "0.2",
      "0.2",
      "0.2",
    ]);
    cleanup();
    expect(barOpacities(render(<PrivacyBars count={1} active />).container)).toEqual([
      "1",
      "0.2",
      "0.2",
    ]);
    cleanup();
    expect(barOpacities(render(<PrivacyBars count={2} active />).container)).toEqual([
      "1",
      "1",
      "0.2",
    ]);
    cleanup();
    expect(barOpacities(render(<PrivacyBars count={3} active />).container)).toEqual([
      "1",
      "1",
      "1",
    ]);
  });

  it("inks the bars with the accent when active and ghosts them when not", () => {
    // `active` must change only the colour, never which bars are filled: an
    // inactive option still has to communicate its depth (the shape reads even
    // when the row is not selected).
    const inactive = render(<PrivacyBars count={2} active={false} />).container;
    expect([...inactive.querySelectorAll("rect")].map((r) => r.getAttribute("fill"))).toEqual([
      "var(--text-ghost)",
      "var(--text-ghost)",
      "var(--text-ghost)",
    ]);
    expect(barOpacities(inactive)).toEqual(["1", "1", "0.2"]);

    cleanup();
    const active = render(<PrivacyBars count={2} active />).container;
    expect([...active.querySelectorAll("rect")].map((r) => r.getAttribute("fill"))).toEqual([
      "currentColor",
      "currentColor",
      "currentColor",
    ]);
    // Same fill pattern -- only the colour moved.
    expect(barOpacities(active)).toEqual(["1", "1", "0.2"]);
  });

  it("is hidden from assistive tech, since the depth is labelled in text beside it", () => {
    const { container } = render(<PrivacyBars count={2} active />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
