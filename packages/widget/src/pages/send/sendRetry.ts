import type { ResolvedRecipient } from "../../lib/recipient/index.js";
import type { SwapPrefill } from "../trade/SwapPanel.js";
import type { SendRecipientDisplay } from "./sendCopy.js";

export interface SendRetryDraft extends SwapPrefill {
  mode: SendRecipientDisplay["mode"];
  input?: string;
}

const recipients = new WeakMap<SendRecipientDisplay, ResolvedRecipient>();
const submitted = new Map<string, ResolvedRecipient>();

export function rememberSendRecipient(display: SendRecipientDisplay, recipient: ResolvedRecipient) {
  if (recipient.kind === "address" || recipient.kind === "stealth_meta") {
    recipients.set(display, recipient);
  }
}

export function rememberSendIntent(intentId: string, display: SendRecipientDisplay) {
  const recipient = recipients.get(display);
  if (!recipient || submitted.has(intentId)) return;
  submitted.set(intentId, recipient);
  if (submitted.size > 50) {
    const oldest = submitted.keys().next();
    if (!oldest.done) submitted.delete(oldest.value);
  }
}

export function recallSendRecipient(intentId: string): ResolvedRecipient | undefined {
  return submitted.get(intentId);
}
