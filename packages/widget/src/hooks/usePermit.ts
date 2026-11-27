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
 * - For permit2, ensure an on-chain ERC-20 allowance to the canonical
 *   Permit2 contract that PermitWitnessTransferFrom requires. erc3009 (USDC)
 *   pulls via ReceiveWithAuthorization and needs no approval transaction.
 * - Report whether that approval is still outstanding (`approval`), read off
 *   the wallet's real on-chain allowance. The payment copy claims "no gas" only
 *   from this, and `ensureApproval` decides from a refetch of the same read, so
 *   the copy and the approval prompt cannot disagree.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  useAccount,
  useConfig,
  usePublicClient,
  useWriteContract,
  useBytecode,
  useReadContract,
} from "wagmi";
import { erc20Abi, isAddress, isHash, maxUint256 } from "viem";
import type {
  PermitType,
  PaymentMethod,
  ChainId,
  Eip712TypedData,
  OriginApproval,
} from "../types/intent.js";
import { resolveOriginSponsorship } from "../lib/originSponsorship.js";
import { withSendAttemptLock } from "../lib/localSends.js";
import { isUserRejection } from "../lib/eip712.js";
import { pullMethodFromAuthorization, permit2SpenderFromAuthorization } from "../lib/permits.js";
import { isOriginSponsorshipPilotChain, SUPPORTED_CHAIN_IDS } from "@xochi/client";
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
  /** Quote/trade identity. Changing it invalidates any unlimited consent. */
  approvalContext?: string | null;
  /** Riddler quote binding for sponsorship of an exact first allowance. */
  quoteId?: string | null;
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
  /** A zero-first token may need a separate gasful allowance reset. */
  approvalMayNeedReset: boolean;
  /** An approval transaction is in flight. */
  isApproving: boolean;
  unlimitedApproval: boolean;
  setUnlimitedApproval: (enabled: boolean) => void;
  /**
   * Ensure the origin token has a sufficient Permit2 allowance. No-op (returns
   * true) for erc3009 tokens. For permit2, refetches the allowance read that
   * `approval` comes from and sends the exact amount if it is short (unlimited
   * only with explicit, single-use consent), waiting for the receipt and
   * re-reading allowance after it. Returns false on rejection, revert,
   * a non-canonical Permit2 domain or failure so the caller aborts before signing.
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
  approvalContext = null,
  quoteId,
  enabled = true,
}: UsePermitParams): UsePermitReturn {
  const { address, connector } = useAccount();
  const config = useConfig();
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
  // served pull naming any other contract is refused, never approved: even an
  // exact allowance to a server-chosen spender could be taken without a
  // signature. @xochi/client already refuses such a quote at
  // ingest; this keeps the approval itself pinned rather than trusting that.
  const servedSpender = permit2SpenderFromAuthorization(pullAuthorization);
  const foreignSpender =
    servedSpender !== null && servedSpender.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase();
  // Mainnet USDT rejects approve(nonzero) while any allowance remains.
  const zeroFirstApproval =
    chainId === 1 && token.toLowerCase() === "0xdac17f958d2ee523a2206206994597c13d831ec7";

  // erc3009 pulls gaslessly via ReceiveWithAuthorization (no allowance). permit2
  // needs sufficient token allowance to the Permit2 contract. This is
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

  // Consent belongs to this quote, owner, token, chain and raw amount only.
  // Invalidate synchronously during render so an old choice cannot flash back
  // on a context change or survive an async allowance read.
  const consentScope = JSON.stringify([
    enabled,
    address,
    token,
    chainId,
    amount,
    permitType,
    approvalContext,
    quoteId,
    connector?.uid,
    servedSpender,
  ]);
  const scopeRef = useRef(consentScope);
  const consentRef = useRef<string | null>(null);
  const consentRevision = useRef(0);
  const lifetime = useRef({ mounted: false, generation: 0 });
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  if (scopeRef.current !== consentScope) {
    scopeRef.current = consentScope;
    consentRevision.current += 1;
    consentRef.current = null;
    if (selectedScope !== null) setSelectedScope(null);
  }
  const unlimitedApproval = selectedScope === consentScope;
  const setUnlimitedApproval = useCallback((enabled: boolean) => {
    consentRevision.current += 1;
    const selected = enabled ? scopeRef.current : null;
    consentRef.current = selected;
    setSelectedScope(selected);
  }, []);

  useEffect(() => {
    const active = lifetime.current;
    active.mounted = true;
    active.generation += 1;
    return () => {
      active.mounted = false;
      active.generation += 1;
      consentRef.current = null;
      consentRevision.current += 1;
    };
  }, []);

  const ensureApproval = useCallback(
    async (amount: bigint): Promise<boolean> => {
      if (!lifetime.current.mounted) return false;
      const generation = lifetime.current.generation;
      if (!enabled) return true;
      if (permitType !== "permit2") return true;
      if (foreignSpender) {
        console.error(
          `[usePermit] Refusing to approve ${servedSpender}: the served Permit2 domain does not name the canonical Permit2 contract`,
        );
        return false;
      }
      if (!address || !publicClient) return false;
      const unlimited = consentRef.current === consentScope && required === amount;
      // A choice is consumed even if the wallet refuses, the read fails, or an
      // existing allowance covers this swap. Retrying requires fresh consent.
      setUnlimitedApproval(false);
      const revision = consentRevision.current;
      const isCurrent = (): boolean =>
        lifetime.current.mounted &&
        lifetime.current.generation === generation &&
        scopeRef.current === consentScope &&
        consentRevision.current === revision;

      try {
        setIsApproving(true);

        const { data: current } = await refetchAllowance({ throwOnError: true });
        if (current === undefined) throw new Error("Permit2 allowance read returned nothing");
        if (!isCurrent()) return false;
        const key = `xochi_origin_approval:${chainId}:${address.toLowerCase()}:${token.toLowerCase()}`;
        const pending = localStorage.getItem(key);
        const approvalWallet =
          connector &&
          resolveOriginSponsorship(
            config,
            { action: "approve_permit2", connector, sender: address, chainId },
            isCurrent,
          );
        const originWallet =
          approvalWallet ||
          (connector &&
            resolveOriginSponsorship(
              config,
              { action: "send", connector, sender: address, chainId },
              isCurrent,
            ));
        // A factory SimpleAccount cannot produce the ERC-1271 signature Permit2
        // needs. Refuse even the ordinary approval path for this known profile.
        if (originWallet && !originWallet.supportsApproval) return false;
        const sponsored =
          approvalWallet && (pending !== null || (quoteId && !unlimited && current === 0n))
            ? approvalWallet
            : null;
        if (pending !== null || sponsored) {
          if (!sponsored) return false;
          let approved = false;
          await withSendAttemptLock(address, async () => {
            if (!isCurrent()) return;
            let hash = localStorage.getItem(key);
            const recovering = hash !== null;
            if (hash === null) {
              // Another tab may have confirmed an approval while we acquired the lock.
              const { data: allowanceNow } = await refetchAllowance({ throwOnError: true });
              if (!isCurrent() || allowanceNow === undefined) return;
              if (allowanceNow >= amount) {
                approved = true;
                return;
              }
              if (!quoteId || allowanceNow !== 0n || required !== amount) return;
              hash = await sponsored.submit(
                { action: "approve_permit2", token: token as `0x${string}`, amount, quoteId },
                (hash) => {
                  if (localStorage.getItem(key) !== null)
                    throw new Error("Approval already pending");
                  localStorage.setItem(key, hash);
                },
              );
            }
            if (!isHash(hash)) return;
            const receipt = await (recovering ? sponsored.status(hash) : sponsored.wait(hash));
            if (!receipt || localStorage.getItem(key) !== hash) return;
            localStorage.removeItem(key);
            if (!receipt.success || !isCurrent()) return;
            const { data } = await refetchAllowance({ throwOnError: true });
            approved = isCurrent() && data !== undefined && data >= amount;
          });
          return approved;
        }
        if (current >= amount) return true;
        if (isOriginSponsorshipPilotChain(chainId)) return false;

        if (zeroFirstApproval && current > 0n) {
          const resetHash = await writeContractAsync({
            chainId,
            address: token as `0x${string}`,
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2_ADDRESS, 0n],
          });
          const resetReceipt = await publicClient.waitForTransactionReceipt({ hash: resetHash });
          if (resetReceipt.status !== "success") {
            throw new Error(`Permit2 allowance reset ${resetHash} reverted`);
          }
          // A successful reset receipt proves USDT accepted approve(0). A
          // load-balanced latest read may still report its previous allowance.
          if (!isCurrent()) return false;
        }

        const hash = await writeContractAsync({
          chainId,
          address: token as `0x${string}`,
          abi: erc20Abi,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, unlimited ? maxUint256 : amount],
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // Re-read now the approval has mined, so the copy flips to "no gas" (or
        // stays "gas for an approval" on a revert) from chain state.
        await refetchAllowance();
        if (receipt.status !== "success") {
          throw new Error(`Permit2 approval ${hash} reverted`);
        }
        return isCurrent();
      } catch (err) {
        if (!isUserRejection(err)) {
          console.error("[usePermit] Permit2 approval failed:", err);
        }
        return false;
      } finally {
        if (lifetime.current.mounted && lifetime.current.generation === generation) {
          setIsApproving(false);
        }
      }
    },
    [
      enabled,
      permitType,
      address,
      publicClient,
      config,
      connector,
      quoteId,
      token,
      chainId,
      foreignSpender,
      servedSpender,
      refetchAllowance,
      writeContractAsync,
      consentScope,
      required,
      setUnlimitedApproval,
      zeroFirstApproval,
    ],
  );

  const reset = useCallback(() => {
    setUnlimitedApproval(false);
    setIsApproving(false);
    if (readsAllowance) void refetchAllowance();
  }, [readsAllowance, refetchAllowance, setUnlimitedApproval]);

  return {
    permitType,
    approval,
    approvalMayNeedReset:
      zeroFirstApproval && approval === "required" && allowance !== undefined && allowance > 0n,
    isApproving,
    unlimitedApproval,
    setUnlimitedApproval,
    ensureApproval,
    reset,
  };
}
