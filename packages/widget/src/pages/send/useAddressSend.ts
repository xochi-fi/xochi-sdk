/**
 * useAddressSend
 *
 * The `address` send's lifecycle: edit -> review -> wallet approval -> sent.
 *
 * Nothing reaches the wallet before the user presses the review screen's
 * approval button, and what the wallet is asked for is exactly the reviewed
 * order (`AddressSendOrder`), bound to the wallet and chain that reviewed it.
 * A wallet, account or chain change while reviewing drops back to editing, so
 * an approval can never sign for a sender the review did not show.
 *
 * The transfer goes through wagmi's connector, so the widget's own wallets and
 * the host page's wallet (lent over `@xochi/widget-lib`'s bridge, which carries
 * `eth_sendTransaction` and `wallet_switchEthereumChain`) take the same path.
 * A network switch, when needed, is its own explicit step.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import {
  getBlock,
  getTransaction,
  getTransactionReceipt,
  switchChain,
  writeContract,
} from "wagmi/actions";
import { waitForTransactionReceipt } from "viem/actions";
import { encodeFunctionData, erc20Abi, isHash, type Hex } from "viem";
import { resolveOriginSponsorship } from "../../lib/originSponsorship.js";
import { isUserRejection } from "../../lib/eip712.js";
import {
  clearSendAttempt,
  listLocalSends,
  readSendAttempt,
  saveSendAttempt,
  upsertLocalSend,
  withSendAttemptLock,
  type SendAttempt,
  type SendActivityItem,
} from "../../lib/localSends.js";
import { sendTokens, type AddressSendOrder } from "./addressSend.js";

export type AddressSendPhase =
  | { step: "edit" }
  | { step: "in_doubt"; order: AddressSendOrder; attempt: SendAttempt; notice?: string }
  | { step: "blocked" }
  | { step: "review"; order: AddressSendOrder; notice?: string }
  | { step: "switching"; order: AddressSendOrder }
  | { step: "approving"; order: AddressSendOrder }
  | {
      step: "sent";
      order: AddressSendOrder;
      hash: Hex;
      outcome: "pending" | "confirmed" | "reverted";
    };

export interface UseAddressSendReturn {
  phase: AddressSendPhase;
  /** Hold a checked order for review. Never contacts the wallet. */
  review: (order: AddressSendOrder) => void;
  /** Back to the form, keeping what was typed. */
  edit: () => void;
  /** Ask the wallet to move to the order's chain (an explicit step). */
  switchNetwork: () => Promise<void>;
  /** Ask the wallet to approve exactly the reviewed transfer. */
  approve: () => Promise<void>;
  /** Start a new send once one has been sent. */
  reset: () => void;
  /** The wallet is on another chain than the reviewed order's. */
  needsSwitch: boolean;
  reconcile: (hash: string) => Promise<void>;
}

const DECLINED = "You declined in your wallet. Nothing was sent.";
const UNKNOWN_SUBMISSION =
  "Submission status is unknown. Do not send again. Attach the transaction hash to check this transfer.";
const SPONSORED_UNKNOWN = "Submission status is unknown. Do not send again.";
const NOT_SWITCHED = "The wallet did not switch networks.";

function restore(wallet: string): AddressSendPhase | null {
  try {
    const attempt = readSendAttempt(wallet);
    if (!attempt) return null;
    const { data } = attempt;
    const token = sendTokens(data.chainId).find(
      (token) => token.address.toLowerCase() === data.token.toLowerCase(),
    );
    if (!token || token.decimals !== data.decimals) return { step: "blocked" };
    return {
      step: "in_doubt",
      attempt,
      order: {
        chainId: data.chainId,
        token,
        amount: BigInt(data.amount),
        recipient: data.recipient as Hex,
      },
      notice: attempt.userOpHash ? SPONSORED_UNKNOWN : UNKNOWN_SUBMISSION,
    };
  } catch {
    return { step: "blocked" };
  }
}

export function useAddressSend(): UseAddressSendReturn {
  const config = useConfig();
  const { address, chainId, connector } = useAccount();
  const [phase, setPhase] = useState<AddressSendPhase>({ step: "edit" });
  const busy = useRef(false);
  useEffect(() => {
    if (address) {
      const saved = restore(address);
      if (saved) setPhase(saved);
    }
  }, [address]);
  const sender = useRef<{ address: string } | null>(null);

  // The review is bound to the wallet that opened it.
  const binding = address && connector ? `${address.toLowerCase()}:${connector.uid}` : null;
  const reviewedBinding = useRef<string | null>(null);
  useEffect(() => {
    if (reviewedBinding.current === null || reviewedBinding.current === binding) return;
    reviewedBinding.current = null;
    sender.current = null;
    setPhase((current) =>
      current.step === "review" || current.step === "switching" ? { step: "edit" } : current,
    );
  }, [binding]);

  const review = useCallback(
    (order: AddressSendOrder): void => {
      if (!address || !connector || binding === null) return;
      const saved = restore(address);
      if (saved) {
        setPhase(saved);
        return;
      }
      reviewedBinding.current = binding;
      sender.current = { address };
      setPhase({ step: "review", order });
    },
    [address, connector, binding],
  );

  const edit = useCallback((): void => {
    if (busy.current || (address && restore(address))) return;
    reviewedBinding.current = null;
    sender.current = null;
    setPhase({ step: "edit" });
  }, [address]);

  const reset = edit;

  const order = "order" in phase ? phase.order : null;
  const needsSwitch = order !== null && chainId !== order.chainId;

  const switchNetwork = useCallback(async (): Promise<void> => {
    if (phase.step !== "review") return;
    const reviewed = phase.order;
    setPhase({ step: "switching", order: reviewed });
    try {
      await switchChain(config, { chainId: reviewed.chainId });
      setPhase({ step: "review", order: reviewed });
    } catch (err) {
      setPhase({
        step: "review",
        order: reviewed,
        notice: isUserRejection(err) ? "You declined the network switch." : NOT_SWITCHED,
      });
    }
  }, [config, phase]);

  const approve = async (): Promise<void> => {
    if (phase.step !== "review" || needsSwitch || busy.current || !address || !connector) return;
    const order = phase.order;
    const from = sender.current;
    if (!from || reviewedBinding.current !== binding) {
      edit();
      return;
    }
    busy.current = true;
    try {
      await withSendAttemptLock(from.address, async () => {
        const saved = restore(from.address);
        if (saved) {
          setPhase(saved);
          return;
        }
        const attempt: SendAttempt = {
          wallet: from.address,
          timestamp: Date.now(),
          data: {
            chainId: order.chainId,
            token: order.token.address,
            symbol: order.token.symbol,
            decimals: order.token.decimals,
            amount: order.amount.toString(),
            recipient: order.recipient,
          },
        };
        const sponsored = resolveOriginSponsorship(
          config,
          { action: "send", connector, sender: address, chainId: order.chainId },
          () => reviewedBinding.current === binding,
        );
        if (!sponsored) saveSendAttempt(attempt);
        setPhase({ step: "approving", order });

        if (sponsored) {
          try {
            const opHash = await sponsored.submit(
              {
                action: "send",
                token: attempt.data.token as Hex,
                recipient: order.recipient,
                amount: order.amount,
              },
              (hash) => {
                if (readSendAttempt(attempt.wallet)) throw new Error("Transfer already pending");
                saveSendAttempt({ ...attempt, userOpHash: hash });
                attempt.userOpHash = hash;
              },
            );
            const receipt = await sponsored.wait(opHash);
            if (!receipt) throw new Error("Sponsored transfer pending");
            finish(attempt, order, receipt.hash, receipt.success);
          } catch (error) {
            if (!attempt.userOpHash) {
              const saved = restore(attempt.wallet);
              if (saved) {
                setPhase(saved);
                return;
              }
              setPhase({
                step: "review",
                order,
                notice: isUserRejection(error) ? DECLINED : undefined,
              });
              return;
            }
            setPhase({ step: "in_doubt", order, attempt, notice: SPONSORED_UNKNOWN });
          }
          return;
        }

        let hash: Hex;
        try {
          hash = await writeContract(config, {
            address: order.token.address as Hex,
            abi: erc20Abi,
            functionName: "transfer",
            args: [order.recipient, order.amount],
            chainId: order.chainId,
            account: from.address as Hex,
          });
        } catch (error) {
          if (explicitWalletRefusal(error)) {
            try {
              clearSendAttempt(from.address);
              setPhase({ step: "review", order, notice: DECLINED });
              return;
            } catch {
              // The reservation still has to be treated as unresolved.
            }
          }
          setPhase({ step: "in_doubt", order, attempt, notice: UNKNOWN_SUBMISSION });
          return;
        }

        try {
          if (!isHash(hash)) throw new Error("Invalid transaction hash");
          attempt.hash = hash;
          saveSendAttempt(attempt);
          recordSend(attempt, hash, "pending");
          setPhase({ step: "sent", order, hash, outcome: "pending" });
          const receipt = await waitForTransactionReceipt(
            config.getClient({ chainId: order.chainId }),
            {
              hash,
              checkReplacement: false,
              timeout: 60_000,
            },
          );
          finish(attempt, order, hash, receipt.status === "success");
        } catch {
          setPhase({ step: "in_doubt", order, attempt, notice: UNKNOWN_SUBMISSION });
        }
      });
    } catch {
      setPhase({ step: "blocked" });
    } finally {
      busy.current = false;
    }
  };

  function finish(attempt: SendAttempt, order: AddressSendOrder, hash: Hex, success: boolean) {
    if (!recordSend(attempt, hash, success ? "completed" : "failed"))
      throw new Error("Send activity unavailable");
    clearSendAttempt(attempt.wallet);
    reviewedBinding.current = null;
    sender.current = null;
    setPhase({ step: "sent", order, hash, outcome: success ? "confirmed" : "reverted" });
  }

  const reconcile = async (supplied: string): Promise<void> => {
    if (
      phase.step !== "in_doubt" ||
      busy.current ||
      address?.toLowerCase() !== phase.attempt.wallet.toLowerCase()
    )
      return;
    const { order } = phase;
    const hash = phase.attempt.hash ?? supplied.trim();
    if (!phase.attempt.userOpHash && !isHash(hash)) {
      setPhase({ ...phase, notice: "Enter a valid transaction hash. Do not send again." });
      return;
    }
    busy.current = true;
    let attempt = phase.attempt;
    try {
      await withSendAttemptLock(attempt.wallet, async () => {
        const saved = readSendAttempt(attempt.wallet);
        if (!saved || saved.timestamp !== attempt.timestamp) {
          setPhase(restore(attempt.wallet) ?? { step: "edit" });
          return;
        }
        if (saved.userOpHash) {
          const sponsored =
            connector &&
            address &&
            resolveOriginSponsorship(
              config,
              { action: "send", connector, sender: address, chainId: order.chainId },
              () => true,
            );
          const receipt = await sponsored?.status(saved.userOpHash);
          if (receipt) finish(saved, order, receipt.hash, receipt.success);
          return;
        }
        if (saved.hash && saved.hash.toLowerCase() !== hash.toLowerCase()) {
          setPhase(restore(attempt.wallet) ?? { step: "blocked" });
          return;
        }
        if (!isHash(hash)) throw new Error("Invalid transaction hash");
        const chainId = order.chainId;
        const tx = await getTransaction(config, { hash, chainId });
        const expected = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [order.recipient, order.amount],
        });
        if (
          tx.from.toLowerCase() !== saved.wallet.toLowerCase() ||
          tx.to?.toLowerCase() !== order.token.address.toLowerCase() ||
          tx.input.toLowerCase() !== expected.toLowerCase() ||
          tx.value !== 0n
        )
          throw new Error("Transaction does not match");

        if (!saved.hash) {
          attempt = { ...saved, candidateHash: hash };
          saveSendAttempt(attempt);
        }
        const receipt = await getTransactionReceipt(config, { hash, chainId });
        if (!saved.hash) {
          const block = await getBlock(config, { blockHash: receipt.blockHash, chainId });
          if (
            block.timestamp < BigInt(Math.floor(saved.timestamp / 1000)) ||
            listLocalSends(saved.wallet).some((row) => row.id.toLowerCase() === hash.toLowerCase())
          )
            throw new Error("Transaction predates this attempt");
          attempt = { wallet: saved.wallet, timestamp: saved.timestamp, data: saved.data, hash };
          saveSendAttempt(attempt);
        }
        finish(attempt, order, hash, receipt.status === "success");
      });
    } catch {
      setPhase({
        ...phase,
        attempt,
        notice: attempt.userOpHash
          ? SPONSORED_UNKNOWN
          : "Unable to verify this transfer. Do not send again. Check the hash and try checking status later.",
      });
    } finally {
      busy.current = false;
    }
  };

  return { phase, review, edit, switchNetwork, approve, reset, needsSwitch, reconcile };
}

function explicitWalletRefusal(error: unknown): boolean {
  // EIP-1193 code 4001 explicitly indicates the user refused the request.
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && cause.code === 4001) return true;
    cause = "cause" in cause ? cause.cause : null;
  }
  return false;
}

function recordSend(attempt: SendAttempt, hash: Hex, status: SendActivityItem["status"]): boolean {
  return upsertLocalSend(attempt.wallet, {
    id: hash,
    type: "send",
    timestamp: attempt.timestamp,
    status,
    data: { ...attempt.data, txHash: hash },
  });
}
