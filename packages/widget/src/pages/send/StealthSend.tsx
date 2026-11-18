/**
 * StealthSend
 *
 * The Send tab's `stealth` destination (see stealthSend.ts for what a Stealth
 * send is). Collects the asset, amount, the network the private payout lands
 * on and who it pays, then hands the order to the Swap card with Stealth
 * selected.
 *
 * Who it pays is the wallet's own stealth keys, or someone else's pasted
 * meta-address (stealthRecipient.ts). Someone else's needs no keys of the
 * wallet's own and goes through a review first that shows the meta-address
 * against the network, amount and asset. Key setup for the wallet's own is an
 * explicit button on the shared StealthProvider (`useStealth`): opening this
 * panel never asks the wallet for anything.
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
import { parseStealthMetaAddress } from "./stealthRecipient.js";
import { MetaAddressValue } from "./MetaAddressValue.js";
import { formatTokenAmount } from "../../utils/format.js";
import { STEALTH_PRIVACY_LIMITS } from "../trade/settlementCopy.js";

type Payee = "self" | "other";

/** Every digit the token has, as the address review shows it. */
const exact = (amount: bigint, decimals: number): string =>
  formatTokenAmount(amount, decimals, decimals);
type StealthOrder = Omit<SwapPrefill, "nonce">;

interface StealthSendProps {
  /** Open the Swap card on this order with Stealth selected. */
  onContinue: (order: Omit<SwapPrefill, "nonce">) => void;
  onConnectRequest?: () => void;
  recipient: string;
  onRecipient: (value: string) => void;
  onPaste: () => void;
  onPasteValue: (value: string) => void;
}

export function StealthSend({
  onContinue,
  onConnectRequest,
  recipient: metaInput,
  onRecipient,
  onPaste,
  onPasteValue,
}: StealthSendProps) {
  const id = useId();
  const config = useConfig();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connectWallet = onConnectRequest ?? openConnectModal;
  const stealth = useStealth();
  const { capabilities, state } = useCapabilities();
  const { readBalanceOf } = usePublicBalances();

  const chainIds = useMemo(() => sendChainIds(config.chains.map((c) => c.id)), [config.chains]);
  const [chainId, setChainId] = useState(() =>
    chainIds.includes(8453) ? 8453 : (chainIds[0] ?? 0),
  );
  const tokens = sendTokens(chainId);
  const [symbol, setSymbol] = useState(() => defaultSendToken(chainId)?.symbol ?? "");
  const token = tokens.find((t) => t.symbol === symbol) ?? tokens[0];
  const [amount, setAmount] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [payee, setPayee] = useState<Payee>("other");
  const [review, setReview] = useState<StealthOrder | null>(null);

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
  const metaCheck = payee === "other" ? parseStealthMetaAddress(metaInput) : null;
  const metaError = attempted && metaCheck && !metaCheck.ok ? metaCheck.error : null;
  // Someone else's meta-address is the keys; this wallet's own are not needed.
  const keysReady = payee === "other" || stealth.metaAddress !== null;

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
    const order: StealthOrder = {
      fromChainId: chainId as SwapPrefill["fromChainId"],
      toChainId: destination as SwapPrefill["toChainId"],
      fromToken: token.address,
      toToken: destinationToken.address,
      fromAmount: amountCheck.amount.toString(),
      settlement: "stealth",
    };
    if (payee === "self") {
      onContinue(order);
      return;
    }
    if (!metaCheck?.ok) return;
    setReview({ ...order, stealthRecipient: metaCheck.recipient });
  };

  const fieldIds = {
    chain: `${id}-chain`,
    asset: `${id}-asset`,
    amount: `${id}-amount`,
    destination: `${id}-destination`,
    meta: `${id}-meta`,
  };
  const noRoute = token !== undefined && destinations.length === 0;

  if (review?.stealthRecipient) {
    const reviewToken = sendTokens(review.fromChainId).find(
      (t) => t.address.toLowerCase() === review.fromToken.toLowerCase(),
    );
    return (
      <section className="send-review" aria-label="Review Stealth send">
        <h3 className="send-review__title">Review the Stealth send</h3>
        <dl className="send-review__facts">
          <div>
            <dt>You send</dt>
            <dd className="send-review__amount">
              {reviewToken
                ? `${exact(BigInt(review.fromAmount), reviewToken.decimals)} ${reviewToken.symbol}`
                : review.fromAmount}
            </dd>
          </div>
          <div>
            <dt>From network</dt>
            <dd>{chainName(review.fromChainId)}</dd>
          </div>
          <div>
            <dt>Arrives on</dt>
            <dd>{chainName(review.toChainId)}</dd>
          </div>
          <div>
            <dt>Pays the stealth meta-address</dt>
            <dd>
              <MetaAddressValue encoded={review.stealthRecipient.encoded} />
            </dd>
          </div>
        </dl>
        <p className="send-note">
          The payout lands at a one-time address derived from these keys. Only the recipient can
          find and claim it with their own stealth keys. Check the meta-address against the one the
          recipient gave you: a payment to the wrong keys cannot be recovered.
        </p>
        <p className="send-note">{STEALTH_PRIVACY_LIMITS}</p>
        <p className="send-note">
          It settles as a Xochi order: you review the quote and approve it in Swap.
        </p>
        <div className="send-review__actions">
          <button type="button" className="send-secondary" onClick={() => setReview(null)}>
            Back
          </button>
          <button
            type="button"
            className="submit-btn send-cta"
            onClick={() => {
              onContinue(review);
              setReview(null);
            }}
          >
            Opens Swap to quote
          </button>
        </div>
      </section>
    );
  }

  return (
    <form className="send-form" onSubmit={onSubmit} noValidate aria-label="Send privately">
      <fieldset className="send-payee">
        <legend className="send-field__label">Pays to</legend>
        <label className="send-payee__option">
          <input
            type="radio"
            name={`${id}-payee`}
            value="other"
            checked={payee === "other"}
            onChange={() => setPayee("other")}
          />
          Someone else
        </label>
        <label className="send-payee__option">
          <input
            type="radio"
            name={`${id}-payee`}
            value="self"
            checked={payee === "self"}
            onChange={() => setPayee("self")}
          />
          My stealth keys
        </label>
      </fieldset>

      {payee === "self" ? (
        <p className="send-note">
          A Stealth send pays out to a one-time address only your stealth keys control. You claim it
          with the receiving wallet. Review the quote and approve it in Swap.
        </p>
      ) : (
        <div className="send-field">
          <label className="send-field__label" htmlFor={fieldIds.meta}>
            Recipient stealth meta-address
          </label>
          <textarea
            id={fieldIds.meta}
            className="send-field__control send-field__control--mono send-field__control--meta"
            rows={4}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="st:eth:0x..."
            value={metaInput}
            aria-invalid={metaError ? true : undefined}
            aria-describedby={`${fieldIds.meta}-hint`}
            onChange={(e) => onRecipient(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              onPasteValue(e.clipboardData.getData("text"));
            }}
          />
          <button type="button" className="send-secondary" onClick={onPaste}>
            Paste
          </button>
          <span id={`${fieldIds.meta}-hint`} className="send-field__hint">
            {metaError ??
              "The st:eth:0x... meta-address the recipient shared. They claim the payment with their own stealth keys."}
          </span>
        </div>
      )}
      <p className="send-note">{STEALTH_PRIVACY_LIMITS}</p>

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
            : payee === "other"
              ? "Review Stealth send"
              : "Opens Swap to quote"}
      </button>
    </form>
  );
}
