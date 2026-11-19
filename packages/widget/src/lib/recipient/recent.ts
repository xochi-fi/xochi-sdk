import { isAddress } from "viem";
import { classifyRecipientInput, type ResolvedRecipient } from "./index.js";

const KEY = "xochi.swap.recentRecipients";
const LIMIT = 5;

function parseRecent(value: unknown): ResolvedRecipient | undefined {
  const input =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "input" in value
        ? value.input
        : undefined;
  if (typeof input !== "string" || input.length > 255) return;
  const kind = classifyRecipientInput(input);
  if (kind === "unknown") return;

  const details = value && typeof value === "object" ? value : undefined;
  const name =
    details && "name" in details && typeof details.name === "string" && details.name.length <= 255
      ? details.name
      : kind !== "address" && kind !== "stealth_meta"
        ? input
        : undefined;
  const address =
    details &&
    "address" in details &&
    typeof details.address === "string" &&
    isAddress(details.address)
      ? details.address
      : undefined;
  return { kind, input, name, address };
}

export function readRecentRecipientEntries(): ResolvedRecipient[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(values)) return [];
    const recent = new Map<string, ResolvedRecipient>();
    for (const value of values) {
      const recipient = parseRecent(value);
      if (!recipient) continue;
      const key = recipient.input.toLowerCase();
      if (!recent.has(key)) recent.set(key, recipient);
      if (recent.size === LIMIT) break;
    }
    return [...recent.values()];
  } catch {
    return [];
  }
}

export function readRecentRecipients(): string[] {
  return readRecentRecipientEntries().map(({ input }) => input);
}

/** Record a recipient after dispatch. A later selection must resolve the input again. */
export function rememberRecipient(recipient: ResolvedRecipient): void {
  const input = recipient.shieldedAlias ? `${recipient.shieldedAlias}.zk.money` : recipient.input;
  const entry = parseRecent({ input, name: recipient.name, address: recipient.address });
  if (!entry) return;
  const recent = readRecentRecipientEntries().filter(
    (value) => value.input.toLowerCase() !== input.toLowerCase(),
  );
  try {
    localStorage.setItem(KEY, JSON.stringify([entry, ...recent].slice(0, LIMIT)));
  } catch {
    // Recipient selection is still available when browser storage is disabled.
  }
}
