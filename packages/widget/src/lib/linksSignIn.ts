export type LinksRecoveryKind = "none" | "sign_in" | "switch_wallet";

/**
 * The owner recovery a withheld row offers. A read token never makes the legs
 * readable (SPEC §5.1, 0.11.0: before shielded is offered, a read not
 * authenticated as the intent wallet's session gets the status-only view,
 * token or not), so only an owner wallet session lifts `legsWithheld`.
 */
export function linksRecoveryKind(facts: {
  legsWithheld: boolean;
  ownerWallet: string | undefined;
  connectedWallet: string | undefined;
  sessionWallet: string | undefined;
}): LinksRecoveryKind {
  if (!facts.legsWithheld || !facts.ownerWallet) return "none";
  const owner = facts.ownerWallet.toLowerCase();
  if (facts.sessionWallet?.toLowerCase() === owner) return "none";
  return facts.connectedWallet?.toLowerCase() === owner ? "sign_in" : "switch_wallet";
}
