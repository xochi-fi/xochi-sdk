/**
 * The neutral text scale must stay readable, in every theme.
 *
 * WHY THIS EXISTS. The scale had drifted to nine names carrying six values, and
 * four of them failed WCAG AA. Nothing caught it because nothing was looking:
 * contrast is invisible to the type checker, invisible to eslint, and invisible
 * in review unless someone happens to composite the alpha by hand. The light
 * theme had `--text-muted` -- the most-used text token in the app -- sitting at
 * 3.17:1 for as long as the theme has existed.
 *
 * So this reads the SHIPPED stylesheets rather than a copy of their values. A
 * test holding its own table of alphas would pass forever while base.css drifted
 * underneath it, which is the same defect in a new place.
 *
 * WHAT IT CHECKS, and the two things it deliberately does not:
 *
 *  - Every token that paints TEXT clears 4.5:1 against its own theme's card
 *    surface. Not against --obsidian bare: the card is what text sits on, and it
 *    is lighter, so measuring against the page would flatter every number.
 *  - The text and line scales never borrow each other's tokens. An AA-audited
 *    text scale proves nothing if half its tokens paint borders, and an exempt
 *    line scale is only safely exempt while it paints no words.
 *  - It does not check the accent colours (tiers, status, gold). Those were
 *    measured at 5.3-11.3:1 and are not part of this scale.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const read = (f: string): string => readFileSync(new URL(f, import.meta.url), "utf8");
const BASE = read("./base.css");
const THEMES = read("./themes.css");

// ============================================================
// Colour maths (sRGB -> relative luminance -> WCAG contrast)
// ============================================================

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

type RGB = [number, number, number];

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `fg` at `alpha` over an opaque `bg`. */
function composite(fg: RGB, bg: RGB, alpha: number): RGB {
  return fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i])) as RGB;
}

const hexToRgb = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// ============================================================
// Reading the shipped values
// ============================================================

/** The body of a `:root { ... }` / `[data-theme="x"] { ... }` block. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  const end = css.indexOf("\n}", open);
  expect(end, `${selector} block not closed`).toBeGreaterThan(open);
  return css.slice(open, end);
}

const declaration = (body: string, name: string): string | null =>
  new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;

const parseRgba = (value: string): { rgb: RGB; alpha: number } | null => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(value);
  if (!m) return null;
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    alpha: m[4] === undefined ? 1 : Number(m[4]),
  };
};

/**
 * Resolve a token for a theme: the theme's own declaration if it has one, else
 * the `:root` value, following a one-level `var(--other)` alias.
 *
 * The alias hop is the point of the scale's shape, so it is exercised rather
 * than sidestepped: `--text-faint` has no value of its own anywhere and must
 * still land on a real colour in all three themes.
 */
function resolve(theme: string, token: string): { rgb: RGB; alpha: number } {
  const root = block(BASE, ":root");
  const themed = theme === "dim" ? null : block(THEMES, `[data-theme="${theme}"]`);

  const lookup = (name: string, depth = 0): string => {
    expect(depth, `alias loop resolving --${name}`).toBeLessThan(4);
    const raw = (themed && declaration(themed, name)) ?? declaration(root, name);
    expect(raw, `--${name} is declared nowhere for theme "${theme}"`).not.toBeNull();
    const alias = /^var\(\s*--([\w-]+)\s*\)$/.exec(raw!);
    return alias ? lookup(alias[1], depth + 1) : raw!;
  };

  const parsed = parseRgba(lookup(token));
  expect(parsed, `--${token} is not an rgba() value in theme "${theme}"`).not.toBeNull();
  return parsed!;
}

/** An opaque colour token (hex) for a theme. */
function surfaceHex(theme: string, token: string): RGB {
  const root = block(BASE, ":root");
  const themed = theme === "dim" ? null : block(THEMES, `[data-theme="${theme}"]`);
  const raw = (themed && declaration(themed, token)) ?? declaration(root, token);
  expect(raw, `--${token} missing for "${theme}"`).not.toBeNull();
  return hexToRgb(raw!.trim());
}

/**
 * The surface text is actually painted on: `--panel-bg` over `--obsidian`.
 *
 * Measuring against `--obsidian` alone would flatter every number, because the
 * card is lighter than the page behind it.
 */
function cardSurface(theme: string): RGB {
  const root = block(BASE, ":root");
  const themed = theme === "dim" ? null : block(THEMES, `[data-theme="${theme}"]`);
  const panel = parseRgba(
    ((themed && declaration(themed, "panel-bg")) ?? declaration(root, "panel-bg"))!,
  );
  expect(panel, `--panel-bg missing for "${theme}"`).not.toBeNull();
  return composite(panel!.rgb, surfaceHex(theme, "obsidian"), panel!.alpha);
}

// ============================================================
// The contract
// ============================================================

const THEMES_UNDER_TEST = ["dim", "dark", "light"] as const;

/** Tokens that paint glyphs. Every one is read by a user. */
const TEXT_TOKENS = [
  "text-emphasis",
  "text-strong",
  "text-secondary",
  "text-muted",
  "text-dim",
  // No value of their own: aliases that must still resolve to a readable colour.
  "text-faint",
  "text-hint",
  "text-ghost",
] as const;

const AA_NORMAL = 4.5;

/** The five rungs that carry a value of their own, brightest first. */
const RUNGS = ["text-emphasis", "text-strong", "text-secondary", "text-muted", "text-dim"] as const;

/**
 * Smallest contrast step a person can actually see, as a percentage.
 *
 * Roughly 7% in lightness. It is the number base.css cites to justify four
 * rungs instead of nine, which makes it a rule rather than a remark.
 */
const JND_PERCENT = 7;

/** Contrast of a token against its own theme's card surface. */
function rungContrast(theme: string, token: string): number {
  const surface = cardSurface(theme);
  const { rgb, alpha } = resolve(theme, token);
  return contrast(composite(rgb, surface, alpha), surface);
}

/**
 * The `N.NN:1` a token's own declaration claims in its trailing comment.
 *
 * Reads the declaration line, so it sees what a human reading that line sees.
 * Returns null when there is no annotation at all, which the caller treats as
 * a failure: an unannotated rung is one nobody can check by eye either.
 */
function quotedRatio(theme: string, token: string): number | null {
  const body = theme === "dim" ? block(BASE, ":root") : block(THEMES, `[data-theme="${theme}"]`);
  const line = body.split("\n").find((l) => new RegExp(`--${token}\\s*:`).test(l));
  if (!line) return null;
  const annotation = /\/\*.*?([\d.]+)\s*:\s*1/.exec(line);
  return annotation ? Number(annotation[1]) : null;
}

describe("neutral text scale", () => {
  for (const theme of THEMES_UNDER_TEST) {
    describe(theme, () => {
      it.each(TEXT_TOKENS)("--%s clears WCAG AA on the card surface", (token) => {
        const surface = cardSurface(theme);
        const { rgb, alpha } = resolve(theme, token);
        const ratio = contrast(composite(rgb, surface, alpha), surface);
        // Reported to 2dp so a failure names the number to fix, not just "false".
        expect(
          Number(ratio.toFixed(2)),
          `--${token} in "${theme}" is ${ratio.toFixed(2)}:1, needs ${AA_NORMAL}:1`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });

      it("keeps its rungs in order, brightest first", () => {
        const alphas = RUNGS.map((t) => resolve(theme, t).alpha);
        for (let i = 1; i < alphas.length; i++) {
          expect(
            alphas[i],
            `--${RUNGS[i]} (${alphas[i]}) must not be brighter than --${RUNGS[i - 1]} (${alphas[i - 1]})`,
          ).toBeLessThanOrEqual(alphas[i - 1]);
        }
      });

      // The scale is a ladder, not a pile. Two rungs closer than the ~7%
      // just-noticeable difference are one rung wearing two names, which is the
      // state this whole change came out of.
      //
      // This used to be prose in base.css and nothing else. Ordering alone
      // cannot fail on the actual defect: --text-hint and --text-ghost were
      // byte-identical and ordered just fine. Measured in CONTRAST rather than
      // alpha, because alpha is not perceptually linear and the light theme
      // packs its rungs into a much narrower alpha range than the dark ones.
      it("keeps its rungs at least one JND apart", () => {
        const ratios = RUNGS.map((t) => rungContrast(theme, t));
        for (let i = 1; i < ratios.length; i++) {
          const step = ratios[i - 1] / ratios[i] - 1;
          expect(
            Number((step * 100).toFixed(1)),
            `--${RUNGS[i - 1]} (${ratios[i - 1].toFixed(2)}:1) and --${RUNGS[i]} ` +
              `(${ratios[i].toFixed(2)}:1) are ${(step * 100).toFixed(1)}% apart in "${theme}", ` +
              `under the ~${JND_PERCENT}% just-noticeable difference. That is one rung ` +
              `wearing two names.`,
          ).toBeGreaterThanOrEqual(JND_PERCENT);
        }
      });

      // The ratio quoted in the trailing comment on each declaration must be
      // the ratio that declaration actually produces.
      //
      // Those annotations are how anyone reads this scale without compositing
      // alpha by hand, so a wrong one is worse than none: it is a confident
      // wrong answer. They were wrong. The light theme's block claimed a card
      // surface of rgb(236,233,227) (a figure from an earlier, different
      // surface model) and understated all five of its ratios by up to 1.0,
      // while this file computed the real surface and passed. Recomputing the
      // truth next to an unchecked claim is how the two drift.
      it("quotes the ratio each declaration actually produces", () => {
        for (const token of RUNGS) {
          const quoted = quotedRatio(theme, token);
          expect(quoted, `--${token} in "${theme}" has no /* N.NN:1 */ annotation`).not.toBeNull();
          expect(
            quoted,
            `--${token} in "${theme}" is annotated ${quoted}:1 but measures ` +
              `${rungContrast(theme, token).toFixed(2)}:1`,
          ).toBe(Number(rungContrast(theme, token).toFixed(2)));
        }
      });
    });
  }

  // The ordering used to INVERT between themes: --text-faint sat above
  // --text-muted in dim and below it in dark and light, so a component using
  // both to express hierarchy got it backwards in whichever theme it was not
  // designed against. Aliasing removed the ordering entirely; this pins that it
  // stays removed.
  it("resolves --text-faint to --text-muted in every theme", () => {
    for (const theme of THEMES_UNDER_TEST) {
      expect(resolve(theme, "text-faint")).toEqual(resolve(theme, "text-muted"));
    }
  });

  it("resolves --text-hint and --text-ghost to --text-dim in every theme", () => {
    for (const theme of THEMES_UNDER_TEST) {
      expect(resolve(theme, "text-hint")).toEqual(resolve(theme, "text-dim"));
      expect(resolve(theme, "text-ghost")).toEqual(resolve(theme, "text-dim"));
    }
  });
});

/**
 * The aliases only follow the active theme because of a load order, and a load
 * order is one line in a file this test was not otherwise reading.
 *
 * `:root` and `[data-theme="light"]` are both specificity (0,1,0) and both match
 * <html>, so neither wins on specificity: the later declaration wins, full stop.
 * Swap the two @import lines in index.css and every theme silently renders the
 * dim scale, in an app whose light theme would then be near-white text on
 * near-white card.
 *
 * Everything above would still pass, because everything above reads base.css and
 * themes.css as separate files and simply assumes the themed declaration wins.
 * That assumption is the mechanism, so it gets asserted rather than assumed.
 */
describe("theme cascade", () => {
  const INDEX = readFileSync(new URL("../index.css", import.meta.url), "utf8");

  it("imports themes.css after base.css, so themed values win the cascade", () => {
    const base = INDEX.indexOf("styles/base.css");
    const themes = INDEX.indexOf("styles/themes.css");
    expect(base, "base.css is not imported by src/index.css").toBeGreaterThan(-1);
    expect(themes, "themes.css is not imported by src/index.css").toBeGreaterThan(-1);
    expect(
      themes,
      "themes.css must be imported AFTER base.css: they have equal specificity on <html>, " +
        "so source order is the only thing making a theme's values win over the :root defaults",
    ).toBeGreaterThan(base);
  });

  it("declares the aliases only in base.css, so no theme can fork them", () => {
    // An alias that grows a per-theme value stops being an alias, and the
    // ordering-inversion bug this scale came out of comes straight back.
    for (const alias of ["text-faint", "text-hint", "text-ghost"]) {
      expect(
        new RegExp(`--${alias}\\s*:`).test(THEMES),
        `--${alias} is declared in themes.css; it must stay an alias in base.css only`,
      ).toBe(false);
    }
  });
});

/**
 * The two scales must not borrow each other's tokens.
 *
 * This is what makes the AA contract above MEAN anything. A text scale audited
 * to 4.5:1 proves nothing if half its tokens are painting borders, and a line
 * scale exempt from AA is only safely exempt while it paints no words. The names
 * have to be load-bearing or they are decoration.
 *
 * `--line-subtle` was `--text-barely` and sits at 1.45:1. That is a correct
 * hairline and an unreadable word, and under a `--text-*` name nothing in the
 * codebase could tell those two readings apart.
 */
describe("text and line scales stay separate", () => {
  /** Every stylesheet, read from disk at test time. */
  const stylesheets = (): Array<[string, string]> => {
    // readdirSync, NOT import.meta.glob. The glob is resolved by the bundler at
    // transform time and did not observe an edit made to a stylesheet on disk,
    // so this check silently passed over a real violation. It exists precisely
    // to stop a control covering nothing, and it had that defect itself.
    const dir = new URL(".", import.meta.url);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]);
  };

  /**
   * Every `prop: value` declaration, with the file and line it sits on.
   *
   * Parsed as DECLARATIONS rather than matched against lines. Two rounds of this
   * check have now been defeated by the text-shape of the CSS rather than by its
   * meaning: first by anchoring on line start (missed anything written inline),
   * then by scanning line-at-a-time (misses a declaration whose `var()` wraps to
   * the next line, which prettier will do the moment a value gets long enough).
   * Neither is a rule about borders. Splitting on declaration boundaries removes
   * the whole category.
   *
   * Comments are stripped first, so a violation quoted in a docblock is not an
   * offender and a real one commented out is not a pass.
   */
  const declarations = (): Array<{ file: string; line: number; prop: string; value: string }> => {
    const out: Array<{ file: string; line: number; prop: string; value: string }> = [];
    for (const [file, raw] of stylesheets()) {
      // Replace comments with equal-length whitespace so line numbers survive.
      const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
      const DECL = /(?:^|[;{}])\s*(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;{}]*)/g;
      let m: RegExpExecArray | null;
      while ((m = DECL.exec(css)) !== null) {
        out.push({
          file,
          line: css.slice(0, m.index).split("\n").length,
          prop: m[1],
          value: m[2].trim(),
        });
      }
    }
    return out;
  };

  const offenders = (matches: (d: { prop: string; value: string }) => boolean): string[] =>
    declarations()
      .filter(matches)
      .map((d) => `${d.file}:${d.line}  ${d.prop}: ${d.value}`);

  const readsFrom = (value: string, scale: "text" | "line"): boolean =>
    new RegExp(`var\\(\\s*--${scale}-[\\w-]+`).test(value);

  /**
   * Properties that paint an edge or a fill rather than a glyph.
   *
   * `fill` and `stroke` are here because this app draws inline SVG, where they
   * are the paint properties and `color` is not.
   */
  const EDGE_PROP = /^(?:border|background|outline|box-shadow|fill|stroke)/;

  /**
   * Custom properties whose NAME says they feed an edge.
   *
   * The design system is custom properties end to end, so `--panel-border: var(--text-dim)`
   * is the natural way to smuggle a text token into a border and the direct-property
   * checks below cannot see it: by the time it reaches `border:` it reads `var(--panel-border)`.
   * Resolving the indirection properly would mean evaluating the cascade, so this
   * matches on the name, which is the same convention the rest of the file relies on.
   * It is a heuristic and only as good as the naming, which is exactly why
   * `--line-*` was split out of `--text-*` in the first place.
   */
  const EDGE_NAMED =
    /^--(?:[\w-]*-)?(?:border|line|divider|outline|shadow|rule|stroke)(?:-[\w-]*)?$/;

  it("never paints text with a --line-* token", () => {
    expect(
      offenders((d) => d.prop === "color" && readsFrom(d.value, "line")),
      "the line scale is exempt from AA, so it must not carry words",
    ).toEqual([]);
  });

  it("never draws a border or fill with a --text-* token", () => {
    expect(
      offenders((d) => EDGE_PROP.test(d.prop) && readsFrom(d.value, "text")),
      "use --line-subtle / --line-strong for edges and fills",
    ).toEqual([]);
  });

  it("never defines an edge-named custom property from the text scale", () => {
    expect(
      offenders((d) => EDGE_NAMED.test(d.prop) && readsFrom(d.value, "text")),
      "an edge token built out of --text-* reintroduces the borrowing one level down",
    ).toEqual([]);
  });

  it("never defines a --text-* token from the line scale", () => {
    // The mirror of the rule above. `--text-hint: var(--line-strong)` would put
    // an AA-exempt value back on the audited scale, and the AA suite would then
    // measure the line scale while believing it was measuring text.
    expect(
      offenders((d) => /^--text-/.test(d.prop) && readsFrom(d.value, "line")),
      "the text scale is AA-audited, so it must not be fed from the exempt one",
    ).toEqual([]);
  });

  it("retired --text-barely entirely rather than leaving it to be reached for", () => {
    const declared = stylesheets().some(([, css]) => /--text-barely\s*:/.test(css));
    const used = stylesheets().some(([, css]) => /var\(\s*--text-barely\s*\)/.test(css));
    expect(declared || used, "--text-barely is --line-subtle now").toBe(false);
  });
});
