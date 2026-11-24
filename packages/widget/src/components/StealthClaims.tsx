/**
 * StealthClaims
 *
 * Displays claimable stealth payments found by scanning ERC-5564 announcements.
 * Users can scan for payments, view details, and claim (gasless via Pimlico).
 */

import { useRef, useState } from "react";
import type { ClaimResult } from "../hooks/useStealthClaim.js";
import type { ChainStealthPayment } from "../hooks/useStealthScanner.js";
import { formatPaymentAmount } from "../lib/stealthPaymentAmount.js";
import { describeWaiting, type WaitingPayout } from "../lib/waitingPayouts.js";

/**
 * What stands between the user and a scan. Every action is one click: signing
 * in (the announcements index is session-gated) and deriving the keys (first
 * setup on this device, or unlocking keys that live only in memory) both run
 * before the scan they lead to.
 */
export type ClaimsAction =
  | "scan"
  | "set-up"
  | "unlock"
  | "sign-in"
  | "sign-in-and-set-up"
  | "sign-in-and-unlock";

/** What the action is waiting on, if anything. */
export type ClaimsBusy = "signing" | "scanning" | null;

const ACTION_COPY: Record<
  ClaimsAction,
  { label: string; title: string; toClaim: string; idle: string | null }
> = {
  scan: {
    label: "Scan",
    title: "Scan for incoming payments",
    toClaim: "Scan to claim.",
    idle: null,
  },
  "set-up": {
    label: "Set up and scan",
    title: "Sign with the wallet to set up the stealth keys, then scan",
    toClaim: "Sign to set up Stealth and claim.",
    idle: "Sign once to set up Stealth and look for payments sent to you.",
  },
  unlock: {
    label: "Unlock and scan",
    title: "Sign with the wallet to unlock the stealth keys, then scan",
    toClaim: "Sign to unlock and claim.",
    idle: "Keys locked. Sign to unlock and look for payments sent to you.",
  },
  "sign-in": {
    label: "Sign in to scan",
    title: "Sign in with the wallet to look for incoming payments",
    toClaim: "Sign in to claim.",
    idle: null,
  },
  "sign-in-and-set-up": {
    label: "Sign in and set up",
    title: "Sign in, then sign to set up the stealth keys, then scan",
    toClaim: "Sign in and set up Stealth to claim.",
    idle: "Sign in and set up Stealth to look for payments sent to you.",
  },
  "sign-in-and-unlock": {
    label: "Sign in and unlock",
    title: "Sign in, then sign to unlock the stealth keys, then scan",
    toClaim: "Sign in and unlock to claim.",
    idle: "Keys locked. Sign in and unlock them to look for payments sent to you.",
  },
};

interface StealthClaimsProps {
  payments: ChainStealthPayment[];
  isClaiming: boolean;
  /**
   * The in-progress claim was sent and is waiting to be mined; it is being
   * checked on, not failed. Shown as a pending state, never as an error.
   */
  isConfirming?: boolean;
  action: ClaimsAction;
  busy: ClaimsBusy;
  onAction: () => void;
  walletAddress: string | undefined;
  error: string | null;
  lastScannedBlock: bigint | null;
  /** A scan has completed this session (drives the honest empty state) */
  hasScanned: boolean;
  /**
   * Payouts the server already holds as claimable for this wallet, shown
   * before any key is unlocked or any scan has run.
   */
  waiting: readonly WaitingPayout[];
  onClaim: (payment: ChainStealthPayment, recipient: string) => Promise<ClaimResult>;
  onClaimAll: (recipient: string) => Promise<{ claimed: number; failed: number; pending: number }>;
}

export function StealthClaims({
  payments,
  isClaiming,
  isConfirming = false,
  action,
  busy,
  onAction,
  walletAddress,
  error,
  lastScannedBlock,
  hasScanned,
  waiting,
  onClaim,
  onClaimAll,
}: StealthClaimsProps) {
  const scope = `${walletAddress?.toLowerCase() ?? ""}:${action}`;
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
  // the server already holds a claimable settlement for this wallet, which a
  // returning user with locked keys sees before signing anything.
  const waitingCount = payments.length > 0 ? payments.length : waiting.length;
  const hasWaiting = waitingCount > 0;
  const copy = ACTION_COPY[action];
  const waitingLine = payments.length === 0 && !hasScanned ? describeWaiting(waiting) : null;
  const isScanning = busy === "scanning";

  return (
    <div className={`stealth-claims${hasWaiting ? " stealth-claims--waiting" : ""}`}>
      <div className="section-header">
        <div className="section-title">
          {hasWaiting && (
            <span className="stealth-claims-badge" aria-label={`${waitingCount} waiting to claim`}>
              {waitingCount} claimable
            </span>
          )}
        </div>
        <button
          className="btn btn--secondary btn--sm"
          onClick={onAction}
          disabled={busy !== null}
          title={copy.title}
        >
          {isScanning ? "Scanning..." : busy !== null ? "..." : copy.label}
        </button>
      </div>

      {waitingLine !== null ? (
        <p className="stealth-claims-waiting" role="status">
          {waitingLine}. {copy.toClaim}
        </p>
      ) : (
        copy.idle !== null &&
        !hasScanned && (
          <p className="stealth-claims-waiting" role="status">
            {copy.idle}
          </p>
        )
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
