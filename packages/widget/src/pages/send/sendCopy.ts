export const SHIELDED_DESCRIPTION = "Amounts and participants hidden inside zk.money.";

export interface SendRecipientDisplay {
  mode: "Stealth" | "Shielded";
  label: string;
  /** Only a resolved name or an explicit zk.money alias may be persisted for retry. */
  retryInput?: string;
}

export function sentToRecipient({ mode, label }: SendRecipientDisplay): string {
  return `Sent with ${mode} to ${label}`;
}

export function confirmSend({ mode }: SendRecipientDisplay): string {
  return `Confirm ${mode} send`;
}
