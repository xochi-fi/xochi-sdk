/**
 * usePermit Hook
 *
 * Origin-pull approval helper. Under the origin-pull contract the user signs
 * the solver-served `pull_authorization` (handled in useIntent), so this hook
 * no longer builds permit typed data itself. Its job now:
 *
 * - Report the pull method. When a served `pull_authorization` is available it
 *   is authoritative (the solver decides how it pulls); before a quote lands the
 *   hook falls back to a per-token guess (erc3009 for USDC, permit2 otherwise)
 *   for display only.
 * - For permit2, ensure the one-time on-chain ERC-20 allowance to the canonical
 *   Permit2 contract that PermitWitnessTransferFrom requires. erc3009 (USDC)
 *   pulls via ReceiveWithAuthorization and needs no approval transaction.
 * - Report whether that approval is still outstanding (`approval`), read off
 *   the wallet's real on-chain allowance. The payment copy claims "no gas" only
 *   from this, and `ensureApproval` decides from a refetch of the same read, so
 *   the copy and the approval prompt cannot disagree.
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import { useAccount, usePublicClient, useWriteContract, useBytecode, useReadContract } from "wagmi";
import { erc20Abi, isAddress, maxUint256 } from "viem";
import type {
  PermitType,
  PaymentMethod,
  ChainId,
  Eip712TypedData,
  OriginApproval,
} from "../types/intent.js";
import { isUserRejection } from "../lib/eip712.js";
import { pullMethodFromAuthorization, permit2SpenderFromAuthorization } from "../lib/permits.js";
import { SUPPORTED_CHAIN_IDS } from "@xochi/client";
import { PERMIT2_ADDRESS } from "@xochi/signer";
import { USDC_ADDRESSES } from "@xochi/client";

// ============================================================
// Constants
// ============================================================

// Tokens that support ERC-3009 (ReceiveWithAuthorization): USDC per chain, derived
// from the shared USDC map. Chains without USDC (e.g. Robinhood, whose stablecoin
// USDG pulls via Permit2) map to an empty list and fall through to permit2.
const ERC3009_TOKENS: Record<ChainId, string[]> = Object.fromEntries(
  SUPPORTED_CHAIN_IDS.map((chainId) => {
    const usdc = USDC_ADDRESSES[chainId];
    return [chainId, usdc ? [usdc] : []];
  }),
) as Record<ChainId, string[]>;

// ============================================================
// Types
// ============================================================

export interface UsePermitParams {
  token: string;
  chainId: ChainId;
  /**
   * The solver-served origin-pull authorization for the current quote, when one
   * exists. Its `primaryType` is the authoritative pull method: the approval
   * gate keys on it so an ERC-3009 pull (ReceiveWithAuthorization) never prompts
   * an approval and a Permit2 pull always approves the canonical Permit2
   * contract. Undefined before a quote lands (falls back to the token guess).
   */
  pullAuthorization?: Eip712TypedData;
  /**
   * The quote's served `payment_method`. When it names a pull method it beats
   * the token guess on a quote that carries no pull (an anonymous preview), so
   * a preview the solver labels Permit2 is never read as an allowance-free
   * ERC-3009 pull just because the token is USDC. The pull itself still wins.
   */
  servedMethod?: PaymentMethod;
  /**
   * The base-units amount the approval must cover, the figure the machine later
   * passes to `ensureApproval`. Null before anything is quoted, which leaves a
   * Permit2 approval `unknown`.
   */
  amount: string | null;
  /**
   * Whether the origin leg uses an EVM gasless pull. False for a non-EVM (Tron)
   * deposit-route origin, which has no permit/approval at all -- the hook goes
   * inert (`permitType:"none"`, no reads, `ensureApproval` no-ops) so a Tron
   * origin never touches wagmi. `chainId` is then a harmless EVM placeholder.
   */
  enabled?: boolean;
}

export interface UsePermitReturn {
  permitType: PermitType;
  /** Whether the pull needs an approval transaction first, from the on-chain allowance. */
  approval: OriginApproval;
  /** An approval transaction is in flight. */
  isApproving: boolean;
  /**
   * Ensure the origin token has a sufficient Permit2 allowance. No-op (returns
   * true) for erc3009 tokens. For permit2, refetches the allowance read that
   * `approval` comes from and sends a max approval if it is short, waiting for
   * the receipt and re-reading the allowance after it. Returns false on
   * rejection, revert, a non-canonical Permit2 domain or failure so the caller
   * can abort before signing.
   */
  ensureApproval: (amount: bigint) => Promise<boolean>;
  /** Clear the in-flight flag and re-read the allowance (a swap may have spent it). */
  reset: () => void;
}

// ============================================================
// Permit Type Detection
// ============================================================

/**
 * Guess the pre-quote pull method for a token. USDC pulls via ERC-3009
 * (ReceiveWithAuthorization); everything else via Permit2.
 *
 * `isSmartAccount` steers a Base Account / Coinbase Smart Wallet (ERC-4337)
 * signer away from ERC-3009: USDC's `receiveWithAuthorization` validates the
 * signature with `ecrecover` and has no ERC-1271 fallback, so a smart account
 * physically cannot produce a valid ERC-3009 signature. Permit2 does support
 * ERC-1271 on-chain, so it is the only viable guess for a smart account
 * (xochi#291). This only steers the pre-quote guess; the solver-served
 * `pull_authorization` remains authoritative once a quote lands.
 */
export function detectPermitType(
  token: string,
  chainId: ChainId,
  isSmartAccount = false,
): PermitType {
  if (isSmartAccount) return "permit2";

  const erc3009Tokens = ERC3009_TOKENS[chainId];
  const isErc3009 = erc3009Tokens.some((t) => t.toLowerCase() === token.toLowerCase());

  if (isErc3009) return "erc3009";

  // Default to Permit2 for other tokens.
  return "permit2";
}

// ============================================================
// Hook Implementation
// ============================================================

export function usePermit({
  token,
  chainId,
  pullAuthorization,
  servedMethod,
  amount,
  enabled = true,
}: UsePermitParams): UsePermitReturn {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { writeContractAsync } = useWriteContract();

  const [isApproving, setIsApproving] = useState(false);

  // Detect a DEPLOYED ERC-4337 smart account (Base Account / Coinbase Smart
  // Wallet): deployed smart accounts have bytecode at their address, EOAs do not.
  // Used to steer the pre-quote pull-method guess away from ecrecover-only
  // ERC-3009 (xochi#291). Only queried for an EVM origin with a connected wallet.
  //
  // Limitation: a counterfactual (not-yet-deployed) smart account has no bytecode
  // yet, so it reads as an EOA here and USDC still guesses ERC-3009 pre-quote.
  // That guess is not authoritative -- the solver-served `pull_authorization`
  // corrects it once the quote lands (a smart account can never sign ERC-3009, so
  // the solver returns Permit2), and execute-time signature verification accepts
  // the ERC-1271/6492 signature regardless. The steer is a best-effort UX hint,
  // not a correctness gate.
  const { data: bytecode } = useBytecode({
    address,
    chainId,
    query: { enabled: enabled && !!address },
  });
  const isSmartAccount = !!bytecode && bytecode !== "0x";

  // Inert on a non-EVM (deposit-route) origin: no permit type, no chain reads.
  // When the solver has served a pull_authorization, its method is authoritative
  // (the approval gate must match what the solver actually pulls, not a guess).
  // A quote without one still names its pull method; before any quote lands,
  // fall back to the per-token heuristic for display.
  const permitType = useMemo(
    () =>
      enabled
        ? (pullMethodFromAuthorization(pullAuthorization) ??
          (servedMethod === "permit2" || servedMethod === "erc3009" ? servedMethod : null) ??
          detectPermitType(token, chainId, isSmartAccount))
        : "none",
    [enabled, pullAuthorization, servedMethod, token, chainId, isSmartAccount],
  );

  // SPEC §2.3 pins the Permit2 domain's verifyingContract to the universal
  // contract, so the allowance is read and approved for that contract only. A
  // served pull naming any other contract is refused, never approved: the
  // approval is unlimited, so a server-chosen spender could pull the token
  // without any signature. @xochi/client already refuses such a quote at
  // ingest; this keeps the approval itself pinned rather than trusting that.
  const servedSpender = permit2SpenderFromAuthorization(pullAuthorization);
  const foreignSpender =
    servedSpender !== null && servedSpender.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase();

  // erc3009 pulls gaslessly via ReceiveWithAuthorization (no allowance). permit2
  // needs the token approved to the Permit2 contract once per token. This is
  // the ONE allowance read: the copy derives from it and ensureApproval
  // refetches it, so the value the panel shows is the value the prompt decides on.
  const readsAllowance =
    enabled && permitType === "permit2" && !foreignSpender && !!address && isAddress(token);
  const {
    data: allowance,
    error: allowanceError,
    refetch: refetchAllowance,
  } = useReadContract({
    chainId,
    address: token as `0x${string}`,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, PERMIT2_ADDRESS] : undefined,
    query: { enabled: readsAllowance },
  });

  useEffect(() => {
    if (allowanceError) {
      console.error("[usePermit] Permit2 allowance read failed:", allowanceError);
    }
  }, [allowanceError]);

  // A non-decimal amount reads as unknown here; the machine reports it as a
  // signing error when the flow asks for the approval.
  const required = amount && /^\d+$/.test(amount) ? BigInt(amount) : null;
  const approval: OriginApproval =
    !enabled || permitType !== "permit2"
      ? "none"
      : foreignSpender || allowance === undefined || allowanceError || required === null
        ? "unknown"
        : allowance >= required
          ? "covered"
          : "required";

  const ensureApproval = useCallback(
    async (amount: bigint): Promise<boolean> => {
      if (!enabled) return true;
      if (permitType !== "permit2") return true;
      if (foreignSpender) {
        console.error(
          `[usePermit] Refusing to approve ${servedSpender}: the served Permit2 domain does not name the canonical Permit2 contract`,
        );
        return false;
      }
      if (!address || !publicClient) return false;

      try {
        setIsApproving(true);

        const { data: current } = await refetchAllowance({ throwOnError: true });
        if (current === undefined) throw new Error("Permit2 allowance read returned nothing");
        if (current >= amount) return true;

        const hash = await writeContractAsync({
          chainId,
          address: token as `0x${string}`,
          abi: erc20Abi,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, maxUint256],
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // Re-read now the approval has mined, so the copy flips to "no gas" (or
        // stays "gas for a one-time approval" on a revert) from chain state.
        await refetchAllowance();
        if (receipt.status !== "success") {
          throw new Error(`Permit2 approval ${hash} reverted`);
        }
        return true;
      } catch (err) {
        if (!isUserRejection(err)) {
          console.error("[usePermit] Permit2 approval failed:", err);
        }
        return false;
      } finally {
        setIsApproving(false);
      }
    },
    [
      enabled,
      permitType,
      address,
      publicClient,
      token,
      chainId,
      foreignSpender,
      servedSpender,
      refetchAllowance,
      writeContractAsync,
    ],
  );

  const reset = useCallback(() => {
    setIsApproving(false);
    if (readsAllowance) void refetchAllowance();
  }, [readsAllowance, refetchAllowance]);

  return {
    permitType,
    approval,
    isApproving,
    ensureApproval,
    reset,
  };
}
