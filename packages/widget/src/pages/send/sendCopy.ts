export const SHIELDED_DESCRIPTION = "Amounts and participants hidden inside zk.money.";

export interface SendRecipientDisplay {
  mode: "Stealth" | "Shielded";
  label: string;
}

export function sentToRecipient({ mode, label }: SendRecipientDisplay): string {
  return `Sent with ${mode} to ${label}`;
}

export function confirmSend({ mode }: SendRecipientDisplay): string {
  return `Confirm ${mode} send`;
}
