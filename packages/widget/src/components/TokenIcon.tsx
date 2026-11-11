import { TOKEN_ICONS } from "../assets/tokens/index.js";

interface TokenIconProps {
  symbol: string;
  /** Sizing/positioning class, e.g. "inline-token-icon" or "token-icon-img". */
  className?: string;
  title?: string;
}

/**
 * Renders a token's logo, falling back to a letter chip when no icon asset is
 * registered for the symbol. The fallback carries the same sizing class as the
 * image so the box matches at every call site (see `.token-fallback` in
 * components.css for the per-size letter styling).
 *
 * Icons are decorative: every call site renders the symbol as adjacent text, so
 * an `alt`/announcement here would double up for screen readers.
 */
export function TokenIcon({ symbol, className, title }: TokenIconProps) {
  const src = TOKEN_ICONS[symbol];

  if (src) {
    return <img src={src} alt="" aria-hidden="true" className={className} title={title} />;
  }

  const letter = symbol ? symbol.charAt(0).toUpperCase() : "?";
  return (
    <span
      className={className ? `token-fallback ${className}` : "token-fallback"}
      title={title ?? symbol}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
