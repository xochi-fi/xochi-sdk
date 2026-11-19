import type { ResolvedRecipient } from "../../lib/recipient/index.js";
import { abbreviateMetaAddress } from "./stealthRecipient.js";

export function RecipientChip({ recipient }: { recipient: ResolvedRecipient }) {
  const value =
    recipient.address ?? recipient.stealthMetaAddress ?? recipient.shieldedAlias ?? recipient.input;
  const short = value.startsWith("0x")
    ? `${value.slice(0, 6)}…${value.slice(-4)}`
    : value.startsWith("st:eth:")
      ? abbreviateMetaAddress(value)
      : value;
  const hue = [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 0);
  return (
    <span className="send-recipient">
      <span
        className="send-identicon"
        aria-hidden="true"
        style={{
          background: `conic-gradient(from ${hue}deg, hsl(${hue} 60% 45%) 25%, hsl(${(hue + 100) % 360} 65% 68%) 0 50%, hsl(${hue} 60% 45%) 0 75%, hsl(${(hue + 100) % 360} 65% 68%) 0)`,
        }}
      />
      <span>
        {recipient.name && <strong>{recipient.name}</strong>}
        <small title={value}>{short}</small>
      </span>
    </span>
  );
}
