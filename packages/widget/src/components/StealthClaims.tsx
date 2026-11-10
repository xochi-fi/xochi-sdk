/**
 * StealthClaims
 *
 * Displays claimable stealth payments found by scanning ERC-5564 announcements.
 * Users can scan for payments, view details, and claim (gasless via Pimlico).
 */

import { useRef, useState } from "react";
import { decodeAnnouncementMetadata } from "@xochi/signer";
import { getTokenInfoForChain } from "@xochi/client";
import { formatTokenAmount } from "../utils/format.js";
import type { ClaimResult } from "../hooks/useStealthClaim.js";
import type { ChainStealthPayment } from "../hooks/useStealthScanner.js";

/** Render `amount` in `token`, or null when it cannot be shown honestly. */
function formatAmount(chainId: number, token: string, amount: bigint): string | null {
  const info = getTokenInfoForChain(token, chainId);
  if (!info) return null;
  return `${formatTokenAmount(amount, info.decimals, info.decimals)} ${info.symbol}`;
}

/**
 * Render the payout this announcement describes.
 *
 * Reads the ERC-5564 metadata rather than `payment.amount`/`payment.tokenAddress`,
 * which are optional on StealthPayment and which nothing populates: the scanner
 * sets neither, so this rendered nothing for every payment it was written for.
 * The announcement carries both on chain, which is also the figure the claim's
 * verification checks the operation against.
 */
function formatPaymentAmount(payment: ChainStealthPayment): string | null {
  const announced = decodeAnnouncementMetadata(payment.announcement.metadata);
  if (announced) return formatAmount(payment.chainId, announced.token, announced.amount);
  if (!payment.amount || !payment.tokenAddress) return null;
  return formatAmount(payment.chainId, payment.tokenAddress, BigInt(payment.amount));
}

interface StealthClaimsProps {
  payments: ChainStealthPayment[];
  isScanning: boolean;
  isClaiming: boolean;
  /**
   * The in-progress claim was sent and is waiting to be mined; it is being
   * checked on, not failed. Shown as a pending state, never as an error.
   */
  isConfirming?: boolean;
  /** True only when secret keys are in memory (keysReady), not merely cached */
  isStealthReady: boolean;
  /** Re-derive keys from a wallet signature (used post-reload before scanning) */
  onResign: () => void;
  /** Whether a re-sign (key derivation) is in progress */
  isResigning: boolean;
  walletAddress: string | undefined;
  error: string | null;
  lastScannedBlock: bigint | null;
  /** A scan has completed this session (drives the honest empty state) */
  hasScanned: boolean;
  /**
   * The announcements index is wallet-session gated, so scanning is impossible
   * without signing in. True when that is the only thing in the way.
   */
  needsSignIn: boolean;
  isSigningIn: boolean;
  onSignIn: () => void;
  /**
   * Settlements the server already holds as claimable for this wallet. Lets the
   * panel say "you have something waiting" BEFORE a scan has run -- the scan
   * needs keys in memory, which a returning user does not have.
   */
  claimableCount?: number;
  onScan: () => Promise<void>;
  onClaim: (payment: ChainStealthPayment, recipient: string) => Promise<ClaimResult>;
  onClaimAll: (recipient: string) => Promise<{ claimed: number; failed: number; pending: number }>;
}

export function StealthClaims({
  payments,
  isScanning,
  isClaiming,
  isConfirming = false,
  isStealthReady,
  onResign,
  isResigning,
  walletAddress,
  error,
  lastScannedBlock,
  hasScanned,
  needsSignIn,
  isSigningIn,
  onSignIn,
  claimableCount = 0,
  onScan,
  onClaim,
  onClaimAll,
}: StealthClaimsProps) {
  const scope = `${walletAddress?.toLowerCase() ?? ""}:${isStealthReady}:${needsSignIn}`;
  const scopeRef = useRef({ scope });
  const paymentsRef = useRef(payments);
  paymentsRef.current = payments;
  if (scopeRef.current.scope !== scope) scopeRef.current = { scope };
  const authority = scopeRef.current;
  const [claimingPayment, setClaimingPayment] = useState<ChainStealthPayment | null>(null);
  const [claimResults, setClaimResults] = useState(new Map<ChainStealthPayment, ClaimResult>());
  const [resultAuthority, setResultAuthority] = useState(authority);
  if (resultAuthority !== authority) {
    setResultAuthority(authority);
    setClaimingPayment(null);
    setClaimResults(new Map());
  }
  const operationRef = useRef<object | null>(null);

  const handleClaim = async (payment: ChainStealthPayment) => {
    if (!walletAddress || scopeRef.current !== authority || !paymentsRef.current.includes(payment))
      return;
    const operation = {};
    operationRef.current = operation;
    setClaimingPayment(payment);
    const result = await onClaim(payment, walletAddress);
    if (
      scopeRef.current !== authority ||
      operationRef.current !== operation ||
      !paymentsRef.current.includes(payment)
    )
      return;
    setClaimResults((prev) => new Map(prev).set(payment, result));
    setClaimingPayment(null);
  };

  const handleClaimAll = async () => {
    if (!walletAddress) return;
    await onClaimAll(walletAddress);
  };

  const truncate = (s: string) => s.slice(0, 8) + "..." + s.slice(-6);

  // Something is known to be waiting: either this session's scan found it, or
  // the server already holds a claimable settlement for this wallet. The second
  // half matters most for a returning user, whose keys are locked so no scan has
  // run and `payments` is empty even though money is sitting there (#352).
  const waitingCount = payments.length > 0 ? payments.length : claimableCount;
  const hasWaiting = waitingCount > 0;

  return (
    <div className={`stealth-claims${hasWaiting ? " stealth-claims--waiting" : ""}`}>
      <div className="section-header">
        <h3 className="section-title">
          Stealth Payments
          {hasWaiting && (
            <span className="stealth-claims-badge" aria-label={`${waitingCount} waiting to claim`}>
              {waitingCount}
            </span>
          )}
        </h3>
        {needsSignIn ? (
          <button
            className="btn btn--secondary btn--sm"
            onClick={onSignIn}
            disabled={isSigningIn}
            title="Sign in with the wallet to look for incoming payments"
          >
            {isSigningIn ? "..." : "Sign in to scan"}
          </button>
        ) : isStealthReady ? (
          <button
            className="btn btn--secondary btn--sm"
            onClick={onScan}
            disabled={isScanning}
            title="Scan for incoming payments"
          >
            {isScanning ? "Scanning..." : "Scan"}
          </button>
        ) : (
          <button
            className="btn btn--secondary btn--sm"
            onClick={onResign}
            disabled={isResigning}
            title="Re-sign to unlock the keys, then scan"
          >
            {isResigning ? "..." : "Re-sign to scan"}
          </button>
        )}
      </div>

      {/* The strongest thing we can say to a returning user, and the one the app
          could never say before: money is here, this is the button. */}
      {claimableCount > 0 && payments.length === 0 && (
        <div className="stealth-claims-waiting">
          {claimableCount === 1 ? "A private payment is" : `${claimableCount} private payments are`}{" "}
          waiting. {needsSignIn ? "Sign in" : isStealthReady ? "Scan" : "Re-sign"} to move{" "}
          {claimableCount === 1 ? "it" : "them"} into the connected wallet.
        </div>
      )}

      {needsSignIn && (
        <div className="stealth-claims-empty">
          Incoming payments are private, so looking for them needs a one-time wallet signature.
        </div>
      )}

      {!needsSignIn && !isStealthReady && (
        <div className="stealth-claims-empty">
          Keys are locked on this device. Re-sign to unlock them, then scan for payments.
        </div>
      )}

      {error && <div className="stealth-claims-error">{error}</div>}

      {/* Keyed off hasScanned, not lastScannedBlock: an index that returns zero
          rows leaves the block null, and the user would otherwise watch the
          button flick back to "Scan" with nothing else on screen changing. */}
      {hasScanned && payments.length === 0 && !isScanning && (
        <div className="stealth-claims-empty">
          No stealth payments found
          {lastScannedBlock !== null ? ` (scanned to block ${lastScannedBlock.toString()})` : ""}
        </div>
      )}

      {payments.length > 0 && (
        <>
          <div className="stealth-claims-list">
            {payments.map((payment) => {
              const id = `${payment.chainId}-${payment.announcement.txHash}-${String(payment.announcement.logIndex)}`;
              const result = claimResults.get(payment);
              const claiming = claimingPayment === payment;
              const amount = formatPaymentAmount(payment);

              return (
                <div key={id} className="stealth-claim-item">
                  <div className="stealth-claim-details">
                    <span
                      className="stealth-claim-addr"
                      title={payment.announcement.stealthAddress}
                    >
                      {truncate(payment.announcement.stealthAddress)}
                    </span>
                    {Number(payment.announcement.blockNumber) > 0 ? (
                      <span className="stealth-claim-block">
                        block {payment.announcement.blockNumber}
                      </span>
                    ) : (
                      <span className="stealth-claim-block">ready to claim</span>
                    )}
                    {amount && <span className="stealth-claim-amount">{amount}</span>}
                  </div>
                  <div className="stealth-claim-action">
                    {result?.success ? (
                      <span className="stealth-claim-done" title={result.txHash}>
                        Claimed
                      </span>
                    ) : (
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => handleClaim(payment)}
                        disabled={isClaiming || claiming}
                      >
                        {claiming ? (isConfirming ? "Confirming..." : "...") : "Claim"}
                      </button>
                    )}
                    {/* Sent and not mined yet is a wait, not a failure: the
                        hook is re-checking the same signed claim, so nothing
                        here invites a second one. */}
                    {claiming && isConfirming && (
                      <span className="stealth-claim-pending" role="status">
                        Sent. Waiting for the network to confirm it.
                      </span>
                    )}
                    {!claiming && result?.pending && (
                      <span
                        className="stealth-claim-pending"
                        role="status"
                        title={result.opHash ? `Operation ${result.opHash}` : undefined}
                      >
                        Sent, not confirmed. It may still land; scan again before claiming again.
                      </span>
                    )}
                    {result?.error && (
                      <span className="stealth-claim-err" title={result.error}>
                        !
                      </span>
                    )}
                    {/* The payout amount is the one field the claim's
                        verification reads but deliberately does not refuse on,
                        so a disagreement has to be visible instead of silent.
                        Normally never rendered: the two figures come from the
                        same solver value. */}
                    {result?.payout && result.payout.amount !== result.payout.announcedAmount && (
                      <span
                        className="stealth-claim-err"
                        title={`This payment was announced as ${String(result.payout.announcedAmount)} but the transfer moved ${String(result.payout.amount)}. Check the transaction.`}
                      >
                        amount differs
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {payments.length > 1 && (
            <button
              className="btn btn--primary btn--sm stealth-claim-all"
              onClick={handleClaimAll}
              disabled={isClaiming}
            >
              {isClaiming
                ? isConfirming
                  ? "Confirming..."
                  : "Claiming..."
                : `Claim All (${payments.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
