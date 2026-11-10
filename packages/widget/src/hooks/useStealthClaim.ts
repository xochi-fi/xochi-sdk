/**
 * useStealthClaim Hook
 *
 * Orchestrates the keyless stealth claim flow:
 * 1. Scan ERC-5564 announcements for the user's viewing key
 * 2. Verify matched payments locally (ECDH + view tag check)
 * 3. Derive the per-payment stealth spending key for each payment
 * 4. Prepare: POST /api/stealth/claim/prepare -> unsigned UserOp hash
 * 5. Sign the raw userOpHash locally with the stealth key (never leaves the client)
 * 6. Submit: POST /api/stealth/claim/submit with the signature. A 503
 *    `claim_pending` means the op was accepted and not mined yet; the same
 *    signed op is resubmitted (which polls it) until it lands or its pending
 *    window, measured from the first pending answer, closes -- never
 *    re-prepared or re-signed. See claimSubmitPoll.
 */

import { useState, useCallback } from "react";
import {
  decodeAnnouncementMetadata,
  signUserOpHash,
  verifyClaimUserOp,
  type UserOperationV08,
} from "@xochi/signer";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { useStealth } from "./useStealth.js";
import { useStealthScanner, type ChainStealthPayment } from "./useStealthScanner.js";
import { apiPost } from "../lib/api.js";
import { CLAIM_PREPARE_WINDOW_MS, submitClaimUntilSettled } from "../lib/claimSubmitPoll.js";

export interface ClaimResult {
  success: boolean;
  txHash?: string;
  opHash?: string;
  error?: string;
  /**
   * The server's `error_category` when it named one (#469). `no_claimable_settlement`
   * means the record has to be restored and retrying will never work;
   * `claim_rate_limited` and `claim_service_unavailable` are the retryable pair.
   * `claim_pending` is set with `pending` and is not a failure (see below).
   *
   * One value is client-originated rather than served: `claim_op_unverified`,
   * when this hook refused to sign because the prepared operation did not check
   * out (#472). It is listed here because a caller branching on the reason wants
   * to tell "we refused" from "the server refused".
   */
  errorCategory?: string;
  /**
   * What the operation would actually have moved, on a claim that got as far as
   * being verified. Surfaced so the payout the user is signing for is readable
   * rather than implied: the amount is the one field `verifyClaimUserOp`
   * deliberately does not enforce, so a person has to be able to see it.
   */
  payout?: { token: string; amount: bigint; announcedAmount: bigint };
  /**
   * The op was accepted and was still unconfirmed when polling ended -- its
   * pending window closed, or the server stopped answering for it. Not a
   * failure: it may yet land, so the UI shows it as pending rather than as an
   * error. `error` is unset; `opHash` names it.
   */
  pending?: boolean;
}

export interface UseStealthClaimReturn {
  /** Matched stealth payments from scanning, each with its settlement chain */
  payments: ChainStealthPayment[];
  /** Whether scanner is actively scanning */
  isScanning: boolean;
  /** Whether a claim is in progress */
  isClaiming: boolean;
  /**
   * The in-progress claim was sent and is waiting to be mined; the hook is
   * resubmitting the same signed op to poll it. A subset of `isClaiming`.
   */
  isConfirming: boolean;
  /** Error from scanning or claiming */
  error: string | null;
  /** Last scanned block number */
  lastScannedBlock: bigint | null;
  /** A scan has completed at least once this session (see useStealthScanner) */
  hasScanned: boolean;
  // Stealth key controls, surfaced from the app-wide StealthProvider, so Setup,
  // Register, Scan AND the swap panel's send side all act on the same keys. This
  // hook does not own them: when it did, keys derived by the swap panel were
  // invisible here and the post-settle auto-scan could never run (#352).
  /** Whether stealth keys have been set up (meta-address cached) */
  isInitialized: boolean;
  /** Whether secret keys are in memory (scan-ready); false after a reload */
  keysReady: boolean;
  /** Whether the meta-address is registered on-chain */
  isRegistered: boolean;
  /** Whether a key derivation or registration is in progress */
  isLoading: boolean;
  /** Derive stealth keys from a wallet signature (Setup or re-sign) */
  initializeKeys: () => Promise<boolean>;
  /** Register the meta-address on ERC-6538 */
  registerMetaAddress: () => Promise<string | null>;
  /** Scan for incoming stealth payments */
  scan: () => Promise<void>;
  /** Claim a specific stealth payment on the chain it settled on */
  claim: (payment: ChainStealthPayment, recipientAddress: string) => Promise<ClaimResult>;
  /** Claim all matched payments */
  claimAll: (
    recipientAddress: string,
  ) => Promise<{ claimed: number; failed: number; pending: number }>;
  /** Clear found payments */
  clearPayments: () => void;
}

export function useStealthClaim(): UseStealthClaimReturn {
  const stealth = useStealth();
  const scanner = useStealthScanner({
    keys: stealth.getKeys(),
    autoScan: false,
  });

  const [isClaiming, setIsClaiming] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setClaimError(null);
    // The scanner surfaces a visible reason when keys are missing (prompting a
    // re-sign) instead of silently no-opping.
    await scanner.scan();
  }, [scanner]);

  const claim = useCallback(
    async (payment: ChainStealthPayment, recipientAddress: string): Promise<ClaimResult> => {
      if (!payment.stealthPrivKey || payment.stealthPrivKey.length === 0) {
        return { success: false, error: "Stealth spending key not derived" };
      }
      const stealthPrivHex = bytesToHex(payment.stealthPrivKey);

      setIsClaiming(true);
      setClaimError(null);

      // Taken before prepare, so the poll deadline below falls inside the
      // server's window (which starts when it serves the prepare) rather than
      // after it.
      const preparedAt = Date.now();

      try {
        // Phase 1 -- prepare: Riddler builds the sponsored UserOp and returns its
        // hash. Keyed on the counterfactual SimpleAccount address AND chain:
        // the same address can exist on Ethereum and Base, so omitting the chain
        // could resolve a different settlement. No private material is sent.
        const prepared = await apiPost<{
          userOpHash: Hex;
          chainId: number;
          stealthAddress: string;
          counterfactualAddress: string;
          userOperation?: UserOperationV08;
          entryPoint?: string;
        }>("/api/stealth/claim/prepare", {
          counterfactualAddress: payment.announcement.stealthAddress,
          recipientAddress,
          chainId: payment.chainId,
        });

        if (!prepared.success) {
          const errorMsg = prepared.error || "Claim prepare failed";
          setClaimError(errorMsg);
          return { success: false, error: errorMsg, errorCategory: prepared.errorCategory };
        }

        const { userOpHash } = prepared.data;

        // Read the operation before signing it. The hash alone is valid over any
        // preimage that hashes to it, so signing it unverified authorises
        // whatever the server chose to build -- including a payout to somebody
        // else's address. Recompute the hash from the served op and confirm the
        // op pays THIS counterfactual out to THIS recipient (#472).
        //
        // Both sides of every comparison are things the server did not supply:
        // the announcement's metadata was read off chain during the scan, and
        // the owner is the address of the key three lines below that signs.
        const announced = decodeAnnouncementMetadata(payment.announcement.metadata);
        const verified = verifyClaimUserOp({
          userOperation: prepared.data.userOperation,
          entryPoint: prepared.data.entryPoint,
          servedUserOpHash: userOpHash,
          servedChainId: prepared.data.chainId,
          expectedChainId: payment.chainId,
          counterfactualAddress: payment.announcement.stealthAddress,
          recipientAddress,
          expectedOwner: privateKeyToAddress(stealthPrivHex),
          announced,
        });
        if (!verified.ok) {
          // Refuse, never warn. The signature is the entire authorisation and
          // there is no later gate that could catch this.
          setClaimError(verified.reason);
          return { success: false, error: verified.reason, errorCategory: "claim_op_unverified" };
        }

        // From the verifier rather than re-derived here, so what the user is
        // shown is exactly what was checked.
        const payout = {
          token: verified.decoded.token,
          amount: verified.decoded.amount,
          announcedAmount: verified.announced.amount,
        };

        // Sign the raw 32-byte userOpHash locally with the per-payment stealth
        // spending key. The key never leaves the client.
        const signature = signUserOpHash(userOpHash, stealthPrivHex);

        // Phase 2 -- submit: send only the echoed hash + signature. The prepared
        // op is keyed by userOpHash alone; no intent id crosses the wire. While
        // the op is pending, the same body is resubmitted to poll it.
        const outcome = await submitClaimUntilSettled(
          { userOpHash, signature },
          {
            post: apiPost,
            deadline: preparedAt + CLAIM_PREPARE_WINDOW_MS,
            now: Date.now,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            onPending: () => setIsConfirming(true),
          },
        );

        if (outcome.kind === "submitted") {
          return {
            success: true,
            txHash: outcome.data.txHash,
            opHash: outcome.data.opHash,
            payout,
          };
        }
        if (outcome.kind === "unconfirmed") {
          return {
            success: false,
            pending: true,
            opHash: outcome.opHash,
            errorCategory: "claim_pending",
            payout,
          };
        }
        const errorMsg = outcome.error || "Claim failed";
        setClaimError(errorMsg);
        return { success: false, error: errorMsg, errorCategory: outcome.errorCategory, payout };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Claim failed";
        setClaimError(message);
        return { success: false, error: message };
      } finally {
        setIsConfirming(false);
        setIsClaiming(false);
      }
    },
    // Nothing from a hook or a provider is read here. The owner the verification
    // compares against is derived from the payment's own spending key, which
    // arrives as an argument, so this callback is stable across renders.
    [],
  );

  const claimAll = useCallback(
    async (
      recipientAddress: string,
    ): Promise<{ claimed: number; failed: number; pending: number }> => {
      let claimed = 0;
      let failed = 0;
      let pending = 0;

      for (const payment of scanner.payments) {
        const result = await claim(payment, recipientAddress);
        if (result.success) {
          claimed++;
          continue;
        }
        // Sent and unmined past its window: a property of that op, not of the
        // caller, so the rest of the list is still worth claiming.
        if (result.pending) {
          pending++;
          continue;
        }
        failed++;
        // Both of these are properties of the caller or the deployment rather
        // than of this payment, so every remaining iteration would fail the same
        // way. Stop rather than walk the rest of the list.
        //
        // `claim_rate_limited` is the obvious one: continuing burns budget the
        // user needs for the retry.
        //
        // `claim_op_unverified` costs more than budget. Its realistic causes are
        // systemic (a solver predating Riddler #847, a userOpHash or EntryPoint drift,
        // an announcement format change), and by the time it fires the prepare
        // has already succeeded, which consumed a `claim_prepare` token, a slot
        // in Riddler's per-counterfactual limiter, and a real Pimlico
        // sponsorship. Walking N payments spends all three N times over to
        // collect the same refusal. This is the harm shape of #468.
        if (
          result.errorCategory === "claim_rate_limited" ||
          result.errorCategory === "claim_op_unverified"
        ) {
          break;
        }
      }

      return { claimed, failed, pending };
    },
    [scanner.payments, claim],
  );

  return {
    payments: scanner.payments,
    isScanning: scanner.isScanning,
    isClaiming,
    isConfirming,
    error: claimError || scanner.error || stealth.error,
    lastScannedBlock: scanner.lastScannedBlock,
    hasScanned: scanner.hasScanned,
    isInitialized: stealth.isInitialized,
    keysReady: stealth.keysReady,
    isRegistered: stealth.isRegistered,
    isLoading: stealth.isLoading,
    initializeKeys: stealth.initializeKeys,
    registerMetaAddress: stealth.registerMetaAddress,
    scan,
    claim,
    claimAll,
    clearPayments: scanner.clearPayments,
  };
}
