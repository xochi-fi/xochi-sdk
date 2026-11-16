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
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { erc20Abi, type Hex } from "viem";
import { isUserRejection } from "../../lib/eip712.js";
import { upsertLocalSend, type SendActivityItem } from "../../lib/localSends.js";
import type { AddressSendOrder } from "./addressSend.js";

export type AddressSendPhase =
  | { step: "edit" }
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
}

const DECLINED = "You declined in your wallet. Nothing was sent.";
const NOT_SENT = "The wallet did not send the transfer. Nothing left your wallet.";
const NOT_SWITCHED = "The wallet did not switch networks.";

export function useAddressSend(): UseAddressSendReturn {
  const config = useConfig();
  const { address, chainId, connector } = useAccount();
  const [phase, setPhase] = useState<AddressSendPhase>({ step: "edit" });
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
      reviewedBinding.current = binding;
      sender.current = { address };
      setPhase({ step: "review", order });
    },
    [address, connector, binding],
  );

  const edit = useCallback((): void => {
    reviewedBinding.current = null;
    sender.current = null;
    setPhase({ step: "edit" });
  }, []);

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

  const approve = useCallback(async (): Promise<void> => {
    if (phase.step !== "review" || needsSwitch) return;
    const reviewed = phase.order;
    const from = sender.current;
    if (!from || !address || from.address.toLowerCase() !== address.toLowerCase()) {
      edit();
      return;
    }
    setPhase({ step: "approving", order: reviewed });
    let hash: Hex;
    try {
      hash = await writeContract(config, {
        address: reviewed.token.address as Hex,
        abi: erc20Abi,
        functionName: "transfer",
        args: [reviewed.recipient, reviewed.amount],
        chainId: reviewed.chainId as (typeof config.chains)[number]["id"],
        account: from.address as Hex,
      });
    } catch (err) {
      setPhase({
        step: "review",
        order: reviewed,
        notice: isUserRejection(err) ? DECLINED : NOT_SENT,
      });
      return;
    }

    const record = (status: SendActivityItem["status"]): SendActivityItem => ({
      id: hash,
      type: "send",
      timestamp: Date.now(),
      status,
      data: {
        chainId: reviewed.chainId,
        token: reviewed.token.address,
        symbol: reviewed.token.symbol,
        decimals: reviewed.token.decimals,
        amount: reviewed.amount.toString(),
        recipient: reviewed.recipient,
        txHash: hash,
      },
    });
    upsertLocalSend(from.address, record("pending"));
    reviewedBinding.current = null;
    sender.current = null;
    setPhase({ step: "sent", order: reviewed, hash, outcome: "pending" });

    try {
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: reviewed.chainId as (typeof config.chains)[number]["id"],
      });
      const ok = receipt.status === "success";
      upsertLocalSend(from.address, record(ok ? "completed" : "failed"));
      setPhase((current) =>
        current.step === "sent" && current.hash === hash
          ? { ...current, outcome: ok ? "confirmed" : "reverted" }
          : current,
      );
    } catch {
      // The receipt read failed, not the send: the row stays pending, with its
      // public hash to check on the explorer.
    }
  }, [address, config, edit, needsSwitch, phase]);

  return { phase, review, edit, switchNetwork, approve, reset, needsSwitch };
}
