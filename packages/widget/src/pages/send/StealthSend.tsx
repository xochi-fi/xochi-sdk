/**
 * StealthSend
 *
 * The Send tab's `stealth` destination (see stealthSend.ts for what a Stealth
 * send is). Collects the asset, amount and the network the private payout
 * lands on, then hands the order to the Swap card with Stealth selected. Key
 * setup is an explicit button on the shared StealthProvider (`useStealth`):
 * opening this panel never asks the wallet for anything.
 */

import { useId, useMemo, useState, type FormEvent } from "react";
import { useAccount, useConfig } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useStealth } from "../../hooks/useStealth.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { usePublicBalances } from "../../hooks/usePublicBalances.js";
import type { SwapPrefill } from "../trade/SwapPanel.js";
import {
  chainName,
  checkSendAmount,
  defaultSendToken,
  sendChainIds,
  sendTokens,
} from "./addressSend.js";
import { stealthSendDestinations } from "./stealthSend.js";

interface StealthSendProps {
  /** Open the Swap card on this order with Stealth selected. */
  onContinue: (order: Omit<SwapPrefill, "nonce">) => void;
  onConnectRequest?: () => void;
}

export function StealthSend({ onContinue, onConnectRequest }: StealthSendProps) {
  const id = useId();
  const config = useConfig();
  const { isConnected, chainId: walletChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connectWallet = onConnectRequest ?? openConnectModal;
  const stealth = useStealth();
  const { capabilities, state } = useCapabilities();
  const { readBalanceOf } = usePublicBalances();

  const chainIds = useMemo(() => sendChainIds(config.chains.map((c) => c.id)), [config.chains]);
  const [chainId, setChainId] = useState(() =>
    walletChainId !== undefined && chainIds.includes(walletChainId)
      ? walletChainId
      : (chainIds[0] ?? 0),
  );
  const tokens = sendTokens(chainId);
  const [symbol, setSymbol] = useState(() => defaultSendToken(chainId)?.symbol ?? "");
  const token = tokens.find((t) => t.symbol === symbol) ?? tokens[0];
  const [amount, setAmount] = useState("");
  const [attempted, setAttempted] = useState(false);

  const destinations = token
    ? stealthSendDestinations(capabilities, state, chainId, token.symbol)
    : [];
  const [pickedDestination, setDestination] = useState<number | null>(null);
  const destination =
    pickedDestination !== null && destinations.includes(pickedDestination)
      ? pickedDestination
      : (destinations[0] ?? null);
  const destinationToken =
    destination !== null && token
      ? sendTokens(destination).find((t) => t.symbol === token.symbol)
      : undefined;

  const balance = token ? readBalanceOf(chainId, token.address) : null;
  const amountCheck = token ? checkSendAmount(amount, token, balance) : null;
  const amountError = attempted && amountCheck && "error" in amountCheck ? amountCheck.error : null;
  const keysReady = stealth.metaAddress !== null;

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!isConnected) {
      connectWallet?.();
      return;
    }
    if (!keysReady) {
      void stealth.initializeKeys();
      return;
    }
    setAttempted(true);
    if (!token || !destinationToken || destination === null || !amountCheck) return;
    if ("error" in amountCheck) return;
    onContinue({
      fromChainId: chainId as SwapPrefill["fromChainId"],
      toChainId: destination as SwapPrefill["toChainId"],
      fromToken: token.address,
      toToken: destinationToken.address,
      fromAmount: amountCheck.amount.toString(),
      settlement: "stealth",
    });
  };

  const fieldIds = {
    chain: `${id}-chain`,
    asset: `${id}-asset`,
    amount: `${id}-amount`,
    destination: `${id}-destination`,
  };
  const noRoute = token !== undefined && destinations.length === 0;

  return (
    <form className="send-form" onSubmit={onSubmit} noValidate aria-label="Send privately">
      <p className="send-note">
        A Stealth send pays out to a one-time address only your stealth keys control. You claim it
        from Claims with the receiving wallet. It settles as a Xochi order, so you review the quote
        and approve it in Swap.
      </p>

      <div className="send-form__row">
        <div className="send-field">
          <label className="send-field__label" htmlFor={fieldIds.chain}>
            From network
          </label>
          <select
            id={fieldIds.chain}
            className="send-field__control"
            value={chainId}
            onChange={(e) => {
              const next = Number(e.target.value);
              setChainId(next);
              if (!sendTokens(next).some((t) => t.symbol === symbol)) {
                setSymbol(defaultSendToken(next)?.symbol ?? "");
              }
            }}
          >
            {chainIds.map((c) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
          </select>
        </div>
        <div className="send-field">
          <label className="send-field__label" htmlFor={fieldIds.asset}>
            Asset
          </label>
          <select
            id={fieldIds.asset}
            className="send-field__control"
            value={token?.symbol ?? ""}
            onChange={(e) => setSymbol(e.target.value)}
          >
            {tokens.map((t) => (
              <option key={t.address} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="send-field">
        <label className="send-field__label" htmlFor={fieldIds.amount}>
          Amount
        </label>
        <input
          id={fieldIds.amount}
          className="send-field__control"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          aria-invalid={amountError ? true : undefined}
          aria-describedby={`${fieldIds.amount}-hint`}
          onChange={(e) => setAmount(e.target.value)}
        />
        <span id={`${fieldIds.amount}-hint`} className="send-field__hint">
          {amountError ?? "The quote in Swap shows what arrives after fees."}
        </span>
      </div>

      {noRoute ? (
        <p className="send-note" role="status">
          {state === "live"
            ? `Stealth does not settle ${token.symbol} from ${chainName(chainId)} right now. Choose another asset or network.`
            : "Stealth networks are not confirmed yet. Nothing can be sent privately until they are."}
        </p>
      ) : (
        <div className="send-field">
          <label className="send-field__label" htmlFor={fieldIds.destination}>
            Arrives on
          </label>
          <select
            id={fieldIds.destination}
            className="send-field__control"
            value={destination ?? ""}
            onChange={(e) => setDestination(Number(e.target.value))}
          >
            {destinations.map((c) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
          </select>
        </div>
      )}

      {isConnected && !keysReady && (
        <p className="send-note">
          Stealth needs keys first. Setting them up asks your wallet for one signature; it moves no
          funds.
        </p>
      )}
      {stealth.error && isConnected && !keysReady && (
        <p className="send-field__error" role="alert">
          Stealth setup did not finish. Retry, or use another destination.
        </p>
      )}

      <button
        type="submit"
        className="submit-btn send-cta"
        disabled={isConnected && (stealth.isLoading || (keysReady && noRoute))}
      >
        {!isConnected
          ? "Connect wallet"
          : !keysReady
            ? stealth.isLoading
              ? "Setting up Stealth..."
              : "Set up Stealth keys"
            : "Continue to Stealth swap"}
      </button>
    </form>
  );
}
