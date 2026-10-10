/**
 * Recipient-echo guard for non-EVM (Tron) destination routes.
 *
 * These routes settle to a user-typed destination address rather than the
 * connected wallet, and a deposit route carries no wallet signature to bind it.
 * Recipient integrity therefore rides on the authenticated quote channel
 * (client <-> Xochi worker): when the client asked for a specific recipient, the
 * solvable quote MUST echo exactly that address. A mismatch (or a missing echo
 * on a solvable quote) means the recipient the quote would bind is not the one
 * the user chose, so the quote is rejected rather than signed/executed. See #113.
 *
 * Base58 (Tron) is case-sensitive, so the comparison is verbatim -- no
 * normalization. EVM routes send no recipient (they settle to the connected
 * wallet), so there is nothing to check and this returns null.
 */
export function recipientEchoError(
  requested: string | undefined,
  quoted: string | undefined,
): "recipient_unconfirmed" | "recipient_mismatch" | null {
  // No recipient requested: EVM route settling to the connected wallet.
  if (!requested) return null;
  // Requested a recipient but the solvable quote did not echo one back.
  if (!quoted) return "recipient_unconfirmed";
  return requested === quoted ? null : "recipient_mismatch";
}
