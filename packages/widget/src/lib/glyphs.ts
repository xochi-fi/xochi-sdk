/**
 * Glyph vocabulary -- the single source of truth for UI symbols.
 *
 * Like the color tokens in base.css, every symbol gets ONE semantic name here
 * instead of being typed inline at the call site. All glyphs are terminal-native
 * monochrome Unicode (the same class as the theme toggle's circles), never emoji.
 *
 * Block disclosure toggles are NOT here: they use the <Chevron> SVG component,
 * which rotates on open rather than swapping a character. The one inline
 * exception is GLYPH.more, which trails a line of text that is itself the
 * toggle (the quote's rate line) and is rotated by CSS on open.
 */

/** Directional / relational glyphs. */
export const GLYPH = {
  /** A relates to / becomes B: "USDC -> WETH", "Swap X -> Y". */
  flow: "→", // ->
  /** Opens elsewhere (new tab, block explorer). */
  external: "↗", // north-east arrow
  /** Separates facts on one compact line: "Base -> Robinhood . Public". */
  sep: "·", // middle dot
  /** The quote reprices on its own: "(refresh) 23s". */
  refresh: "↻", // clockwise open circle arrow
  /** Trails a line of text that opens more detail (rotated by CSS on open). */
  more: "›", // single right-pointing angle quotation mark
} as const;

/**
 * Graded cost marks. ASCII on purpose: U+26A0 has emoji presentation on some
 * platforms. A mark never travels without a word for screen readers, and the
 * severe one also carries a visible word.
 */
export const SEVERITY_GLYPH = {
  warning: "!",
  severe: "!!",
} as const;

/**
 * Row markers for the three pair-availability states (the token sheet's
 * chevron / lock / slash). Redundant non-color cues beside the badge and hint
 * text, aria-hidden everywhere (the state text is already part of the row's
 * accessible name). `[/]` deliberately matches STATUS_GLYPH.forbidden: both
 * mean "blocked, and no user action changes it".
 */
export const PAIR_GLYPH = {
  available: ">",
  locked: "[*]",
  unsupported: "[/]",
} as const;

/**
 * Status markers for error/status blocks. The bracket frame is the terminal
 * signature; the inner glyph is the non-color redundant cue (color alone is not
 * an accessible signal). Keyed by error category. Consumed by ERROR_ART.
 */
export const STATUS_GLYPH: Record<string, string> = {
  rejected: "[x]", // canceled / refused
  funds: "[0]", // insufficient balance
  network: "[≈]", // approx wave -- connectivity
  expired: "[○]", // empty circle -- timed out
  liquidity: "[≡]", // stacked lines -- no depth
  slippage: "[±]", // plus/minus -- price moved
  rate: "[#]", // rate limited
  forbidden: "[/]", // blocked
  notfound: "[?]", // not found
  unavail: "[·]", // offline dot
  auth: "[=]", // locked
  generic: "[!]", // fallback
};
