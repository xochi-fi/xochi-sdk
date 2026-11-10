/**
 * DepositInstructions
 *
 * The "deposit" phase of the swap flow (Tron-origin routes). There is no wallet
 * signature: the user sends TRC-20 from an external Tron wallet to a per-intent
 * address, and the solver settles on detection. Shows the exact amount, the
 * deposit address (copyable, verbatim base58), a network warning, an immutable
 * payout line, and a waiting indicator while the poll runs.
 *
 * The deposit address was already attestation-verified at quote-ingest
 * (useIntent), so reaching this view means it recovered to the pinned signer.
 */

import { useState, useEffect } from "react";
import { formatTokenAmount } from "../../utils/format.js";
import { EXTENDED_CHAIN_NAMES } from "@xochi/client";
import type { SelectableChainId } from "../../types/intent.js";
import { QrCode } from "./QrCode.js";

interface DepositInstructionsProps {
  /** Per-intent deposit address (base58, verbatim -- never transformed). */
  depositAddress: string;
  /** Origin amount in base units. */
  fromAmount: string;
  fromSymbol: string;
  fromDecimals: number;
  fromChainId: SelectableChainId;
  /** Destination token + chain for the payout line. */
  toSymbol: string;
  toChainId: SelectableChainId;
  /** Formatted payout estimate, if known. */
  receivedAmount?: string;
  /**
   * EVM payout address the attestation was VERIFIED against, not the connected
   * wallet. Those are the same value at quote time and diverge afterwards: an
   * account switch is deliberately not interrupted at this phase, so the live
   * wallet moves while the signed recipient cannot. On a resumed swap it is the
   * value `verifyStoredDeposit` re-proved out of storage.
   *
   * Same rule as `refundAddress` below. Absent renders no address at all rather
   * than falling back to a live one.
   */
  payoutAddress?: string;
  /**
   * Origin-chain refund address the user named, if any (xochi#358). Absent means
   * Riddler's refund-to-sender fallback, which IS echoed and carries an extra
   * warning: "back where it came from" is an address the user does not control
   * when they withdrew from an exchange.
   *
   * Must be the value the attestation was verified against, not live panel
   * state. Both come off the verified binding (`attestedDeposit` in
   * types/intent.ts, or the re-proven stored one on a resume).
   */
  refundAddress?: string;
  /** Deposit-acceptance deadline (unix seconds); drives the countdown. */
  depositDeadline?: number;
  /**
   * Whether the status poll is still running. A spinner reading "checking" is a
   * claim about the client, not the solver, and it must not outlive the poll: a
   * stopped poll and a poll that has found nothing yet otherwise render exactly
   * the same, which is the failure mode where absent input looks like a negative
   * result. Defaults true so an omitted prop cannot silently mute the indicator.
   */
  checkActive?: boolean;
  /**
   * Clear this swap and return the panel to a usable state, so the closed-window
   * view can offer a fresh address.
   *
   * Needed because closing the modal does NOT do this at the deposit phase: the
   * panel deliberately holds the intent, which leaves it in `awaiting_deposit`,
   * a state that suppresses re-quoting. "Close this and start again" was
   * therefore an instruction the state machine refused to honour. Absent, the
   * button is not rendered rather than rendered dead.
   */
  onStartOver?: () => void;
}

function shortenAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

/** Format seconds remaining as "Nm Ss" / "Ss". */
function formatCountdown(secs: number): string {
  if (secs <= 0) return "0s";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function DepositInstructions({
  depositAddress,
  fromAmount,
  fromSymbol,
  fromDecimals,
  fromChainId,
  toSymbol,
  toChainId,
  receivedAmount,
  payoutAddress,
  refundAddress,
  depositDeadline,
  checkActive = true,
  onStartOver,
}: DepositInstructionsProps) {
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Tick once a second only while a future deadline is set, for the countdown.
  // Stops itself at the deadline: past it the countdown has nothing left to
  // count, and a modal left open would otherwise re-render every second forever.
  useEffect(() => {
    if (!depositDeadline) return;
    const id = setInterval(() => {
      const t = Math.floor(Date.now() / 1000);
      setNow(t);
      if (t >= depositDeadline) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [depositDeadline]);

  const secondsLeft = depositDeadline ? Math.max(0, depositDeadline - now) : null;

  // Past the deadline the address must stop being an invitation.
  //
  // The window was enforced at quote-ingest -- verifyDepositAttestation refuses
  // a route with under DEPOSIT_MIN_WINDOW_SECONDS left -- but that check runs
  // once, before this view exists, and the window then runs out while the user
  // is looking at it. Leaving a scannable QR and a live Copy button under the
  // words "this window has closed" makes the warning the weakest thing on the
  // screen. A deposit that lands late is refunded rather than filled, so acting
  // on a closed window costs the user two Tron network fees and the round trip,
  // and returns them nothing.
  //
  // An absent deadline leaves the view exactly as it was. Riddler always sets
  // one on an attested deposit route, and the attestation gate now rejects a
  // quote without it, so this is the shape of an unattested/legacy response
  // rather than a window that never closes.
  const expired = secondsLeft !== null && secondsLeft <= 0;

  const amount = (() => {
    try {
      return formatTokenAmount(BigInt(fromAmount), fromDecimals, 6);
    } catch {
      return "";
    }
  })();
  const originName = EXTENDED_CHAIN_NAMES[fromChainId];
  const destName = EXTENDED_CHAIN_NAMES[toChainId];

  // Where a refund actually goes, said the same way before and after the window
  // closes.
  //
  // With no address named, Riddler refunds to SENDER. That is right for a
  // self-custody wallet and wrong for a CEX withdrawal, where the sender is the
  // exchange's hot wallet and an unexpected inbound is usually not credited to
  // the user's account. The old line said "Nothing is lost" unconditionally,
  // which is true only in the first case, and said it only after the window had
  // closed -- by which point the money is already gone. So it is stated up front
  // now, and the reassurance is not offered where it would not hold.
  const refundTarget = refundAddress ? shortenAddress(refundAddress) : "the sending address";
  const exchangeCaveat = refundAddress
    ? ""
    : " If that was an exchange account, the refund may be lost.";

  // One indicator, two honest states. While the poll runs this says what it is
  // doing; once it has stopped it says that instead, rather than leaving a
  // spinner asserting a check that no longer exists.
  const waiting = checkActive ? (
    <div className="deposit-instructions__waiting" aria-live="polite">
      <span className="spinner spinner--small" />
      {expired ? "Checking for a deposit already on its way..." : "Waiting for the deposit..."}
    </div>
  ) : (
    <p className="deposit-instructions__stopped" aria-live="polite">
      Deposit check stopped. Anything that already arrived is still handled on our side.
    </p>
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(depositAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("[deposit] clipboard copy failed:", err);
    }
  };

  if (expired) {
    return (
      <div className="deposit-instructions deposit-instructions--expired">
        <p className="deposit-instructions__lead" role="alert">
          This window has closed. Do not send anything to that address.
        </p>

        <p className="deposit-instructions__closed-note">
          If {fromSymbol} was already sent, it goes back to {refundTarget}.{exchangeCaveat}
        </p>

        {waiting}

        {/* The panel holds the intent at this phase, so closing the modal does
            NOT free it to quote again. This is the affordance that does, wired
            to the reset the state machine actually permits. */}
        {onStartOver && (
          <button type="button" className="deposit-instructions__start-over" onClick={onStartOver}>
            Get a fresh address
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="deposit-instructions">
      <p className="deposit-instructions__lead">
        Send exactly{" "}
        <strong>
          {amount} {fromSymbol}
        </strong>{" "}
        on {originName} to this address:
      </p>

      <div className="deposit-instructions__qr">
        <QrCode
          value={depositAddress}
          label={`QR code of the ${fromSymbol} deposit address`}
          className="deposit-instructions__qr-svg"
        />
      </div>

      <div className="deposit-instructions__address-row">
        <code className="deposit-instructions__address">{depositAddress}</code>
        <button
          type="button"
          className="deposit-instructions__copy"
          onClick={() => void copy()}
          aria-label="Copy deposit address"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="deposit-instructions__warn" role="alert">
        Send {fromSymbol} on {originName} only. A different token or network cannot be recovered.
      </p>

      {receivedAmount && (
        <p className="deposit-instructions__payout">
          Receive about {receivedAmount} {toSymbol} on {destName}
          {payoutAddress ? ` at ${shortenAddress(payoutAddress)}` : ""}.
        </p>
      )}

      {/* The refund address is collected in the panel and signed into the
          attestation, so it is already binding by the time this renders. Echoed
          here because this is the last screen before the user sends: a typo that
          passes VM validation is a real address on the right chain, and without
          an echo it is only discoverable after a fill fails.

          Rendered even when the user named none, which is the case that most
          needs saying out loud: the fallback sends the money back to whatever
          address it came from, and a user withdrawing from an exchange has no
          reason to expect that is a problem until it is. */}
      <p className="deposit-instructions__refund">
        If it cannot go through, we send it back to {refundTarget}.{exchangeCaveat}
      </p>

      {waiting}

      {secondsLeft !== null && (
        <p className="deposit-instructions__deadline">
          Send within {formatCountdown(secondsLeft)}. After that, any deposit is refunded.
        </p>
      )}
    </div>
  );
}
