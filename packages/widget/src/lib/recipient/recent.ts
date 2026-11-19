import { classifyRecipientInput, type ResolvedRecipient } from "./index.js";

const KEY = "xochi.swap.recentRecipients";
const LIMIT = 5;

export function readRecentRecipients(): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(values)) return [];
    return [
      ...new Set(
        values.filter(
          (value): value is string =>
            typeof value === "string" &&
            value.length <= 255 &&
            classifyRecipientInput(value) !== "unknown",
        ),
      ),
    ].slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecipient(recipient: ResolvedRecipient): void {
  const input = recipient.shieldedAlias ? `${recipient.shieldedAlias}.zk.money` : recipient.input;
  if (!input || input.length > 255) return;
  const recent = readRecentRecipients().filter(
    (value) => value.toLowerCase() !== input.toLowerCase(),
  );
  try {
    localStorage.setItem(KEY, JSON.stringify([input, ...recent].slice(0, LIMIT)));
  } catch {
    // The sheet still works when browser storage is disabled.
  }
}
