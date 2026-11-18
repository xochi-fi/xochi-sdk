/**
 * AddressSend
 *
 * The Send tab's `address` destination: pick a network, an asset, an amount
 * and a recipient; review the exact transfer; approve it in the wallet. The
 * form never touches the wallet. Only the review screen's approval button
 * does, and only for the order it shows (useAddressSend).
 */

import { useId, useMemo, useState, type FormEvent } from "react";
import { useAccount, useConfig } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { getExplorerTxUrl, type SelectableChainId } from "@xochi/client";
import { usePublicBalances } from "../../hooks/usePublicBalances.js";
import { formatTokenAmount } from "../../utils/format.js";
import {
  chainName,
  checkAddressSend,
  defaultSendToken,
  sendChainIds,
  sendTokens,
  type AddressSendDraft,
  type AddressSendErrors,
} from "./addressSend.js";
import { useAddressSend } from "./useAddressSend.js";

interface AddressSendProps {
  /** Hosted wallet UI delegates the connect prompt to the embedding page. */
  onConnectRequest?: () => void;
}

/** Every digit the token has: review shows the amount exactly, never rounded. */
const exact = (amount: bigint, decimals: number): string =>
  formatTokenAmount(amount, decimals, decimals);

export function AddressSend(props: AddressSendProps) {
  const { address } = useAccount();
  return <WalletAddressSend key={address?.toLowerCase()} {...props} />;
}

function WalletAddressSend({ onConnectRequest }: AddressSendProps) {
  const id = useId();
  const [recoveryHash, setRecoveryHash] = useState<string | null>(null);
  const config = useConfig();
  const { isConnected, address, chainId: walletChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connectWallet = onConnectRequest ?? openConnectModal;
  const { readBalanceOf } = usePublicBalances();
  const send = useAddressSend();

  const chainIds = useMemo(() => sendChainIds(config.chains.map((c) => c.id)), [config.chains]);
  const initialChain =
    walletChainId !== undefined && chainIds.includes(walletChainId)
      ? walletChainId
      : (chainIds[0] ?? 0);
  const [draft, setDraft] = useState<AddressSendDraft>(() => ({
    chainId: initialChain,
    tokenAddress: defaultSendToken(initialChain)?.address ?? "",
    amount: "",
    recipient: "",
  }));
  // Field errors show once the user asks for review, then track edits.
  const [attempted, setAttempted] = useState(false);

  const tokens = sendTokens(draft.chainId);
  const token = tokens.find((t) => t.address.toLowerCase() === draft.tokenAddress.toLowerCase());
  const balance = token ? readBalanceOf(draft.chainId, token.address) : null;
  const check = checkAddressSend(draft, { chainIds, balance });
  const errors: AddressSendErrors = attempted && !check.ok ? check.errors : {};

  const update = (patch: Partial<AddressSendDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const onChain = (next: number): void => {
    const symbol = token?.symbol;
    const same = sendTokens(next).find((t) => t.symbol === symbol) ?? defaultSendToken(next);
    update({ chainId: next, tokenAddress: same?.address ?? "" });
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!isConnected) {
      connectWallet?.();
      return;
    }
    setAttempted(true);
    if (check.ok) send.review(check.order);
  };

  const { phase } = send;

  if (phase.step === "edit") {
    const fieldIds = {
      chain: `${id}-chain`,
      asset: `${id}-asset`,
      amount: `${id}-amount`,
      recipient: `${id}-recipient`,
    };
    return (
      <form className="send-form" onSubmit={onSubmit} noValidate aria-label="Send to an address">
        <div className="send-form__row">
          <div className="send-field">
            <label className="send-field__label" htmlFor={fieldIds.chain}>
              Network
            </label>
            <select
              id={fieldIds.chain}
              className="send-field__control"
              value={draft.chainId}
              onChange={(e) => onChain(Number(e.target.value))}
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
              value={token?.address ?? ""}
              aria-invalid={errors.asset ? true : undefined}
              onChange={(e) => update({ tokenAddress: e.target.value })}
            >
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
            {errors.asset && <span className="send-field__error">{errors.asset}</span>}
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
            value={draft.amount}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={`${fieldIds.amount}-hint`}
            onChange={(e) => update({ amount: e.target.value })}
          />
          <span id={`${fieldIds.amount}-hint`} className="send-field__hint">
            {errors.amount ??
              (!isConnected || !token
                ? "Connect a wallet to see your balance"
                : balance === null
                  ? "Balance not loaded yet"
                  : `Balance: ${exact(balance, token.decimals)} ${token.symbol}`)}
          </span>
        </div>

        <div className="send-field">
          <label className="send-field__label" htmlFor={fieldIds.recipient}>
            Recipient address
          </label>
          <input
            id={fieldIds.recipient}
            className="send-field__control send-field__control--mono"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="0x..."
            value={draft.recipient}
            aria-invalid={errors.recipient ? true : undefined}
            aria-describedby={`${fieldIds.recipient}-hint`}
            onChange={(e) => update({ recipient: e.target.value })}
          />
          <span id={`${fieldIds.recipient}-hint`} className="send-field__hint">
            {errors.recipient ?? `A wallet address on ${chainName(draft.chainId)}.`}
          </span>
        </div>

        <p className="send-note">
          A public transfer: the amount and both addresses are visible on-chain, and it cannot be
          reversed.
        </p>

        <button type="submit" className="submit-btn send-cta">
          {isConnected ? "Review send" : "Connect wallet"}
        </button>
      </form>
    );
  }

  if (phase.step === "blocked")
    return (
      <p role="alert">
        Send checkpoint unavailable. Restore browser storage before sending. An earlier transfer may
        be unresolved.
      </p>
    );

  const { order } = phase;
  const amountText = `${exact(order.amount, order.token.decimals)} ${order.token.symbol}`;
  const summary = (
    <dl className="send-review__facts">
      <div>
        <dt>You send</dt>
        <dd className="send-review__amount">{amountText}</dd>
      </div>
      <div>
        <dt>Network</dt>
        <dd>{chainName(order.chainId)}</dd>
      </div>
      <div>
        <dt>Token contract</dt>
        <dd className="send-review__mono">{order.token.address}</dd>
      </div>
      <div>
        <dt>To</dt>
        <dd className="send-review__mono">{order.recipient}</dd>
      </div>
      {address && (
        <div>
          <dt>From</dt>
          <dd className="send-review__mono">{address}</dd>
        </div>
      )}
    </dl>
  );

  if (phase.step === "in_doubt") {
    const hash = phase.attempt.hash ?? recoveryHash ?? phase.attempt.candidateHash ?? "";
    return (
      <section className="send-review" aria-label="Send status unknown">
        <h3>Transfer status unknown</h3>
        {summary}
        <p role="alert">{phase.notice}</p>
        <label>
          Transaction hash
          <input
            value={hash}
            readOnly={!!phase.attempt.hash}
            onChange={(e) => setRecoveryHash(e.target.value)}
          />
        </label>
        <button type="button" onClick={() => void send.reconcile(hash)}>
          Check existing transfer
        </button>
      </section>
    );
  }

  if (phase.step === "sent") {
    const explorer = getExplorerTxUrl(order.chainId as SelectableChainId, phase.hash);
    return (
      <section className="send-review" aria-label="Send submitted">
        <h3 className="send-review__title">
          {phase.outcome === "confirmed"
            ? "Sent"
            : phase.outcome === "reverted"
              ? "The transfer failed on-chain"
              : "Submitted, waiting for confirmation"}
        </h3>
        {summary}
        <div className="send-review__hash">
          <span className="send-field__label">Transaction</span>
          <code className="send-review__mono">{phase.hash}</code>
          {explorer && (
            <a href={explorer} target="_blank" rel="noopener noreferrer">
              View on explorer
            </a>
          )}
        </div>
        <p className="send-note">It also appears in Activity.</p>
        {phase.outcome !== "pending" && (
          <button type="button" className="submit-btn send-cta" onClick={send.reset}>
            New send
          </button>
        )}
      </section>
    );
  }

  const busy = phase.step === "approving" || phase.step === "switching";
  const notice = phase.step === "review" ? phase.notice : undefined;
  return (
    <section className="send-review" aria-label="Review send">
      <h3 className="send-review__title">Review the transfer</h3>
      {summary}
      <p className="send-note">
        Your wallet will ask you to approve this exact transfer. Nothing is sent until you do.
      </p>
      {notice && (
        <p className="send-field__error" role="alert">
          {notice}
        </p>
      )}
      <div className="send-review__actions">
        <button type="button" className="send-secondary" onClick={send.edit} disabled={busy}>
          Back
        </button>
        {send.needsSwitch ? (
          <button
            type="button"
            className="submit-btn send-cta"
            onClick={() => void send.switchNetwork()}
            disabled={busy}
          >
            {phase.step === "switching"
              ? "Switching network..."
              : `Switch to ${chainName(order.chainId)}`}
          </button>
        ) : (
          <button
            type="button"
            className="submit-btn send-cta"
            onClick={() => void send.approve()}
            disabled={busy}
          >
            {phase.step === "approving" ? "Confirm in your wallet..." : "Approve in wallet"}
          </button>
        )}
      </div>
    </section>
  );
}
