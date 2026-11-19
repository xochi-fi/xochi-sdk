import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { useAccount, useConfig } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { getExplorerTxUrl, type SelectableChainId } from "@xochi/client";
import { usePublicBalances } from "../../hooks/usePublicBalances.js";
import { formatTokenAmount } from "../../utils/format.js";
import {
  chainName,
  checkAddressSend,
  checkSendAmount,
  defaultSendChain,
  defaultSendToken,
  sendChainIds,
  sendTokens,
  type AddressSendDraft,
  type AddressSendErrors,
} from "./addressSend.js";
import { useAddressSend } from "./useAddressSend.js";

import type { SwapPrefill } from "../trade/SwapPanel.js";
import type { SendDestinationKind } from "../trade/WidgetTabs.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { useLocalSends } from "../../hooks/useLocalSends.js";
import { useSendRecipient } from "./useSendRecipient.js";
import { RecipientChip } from "./RecipientChip.js";
import { parseStealthMetaAddress } from "./stealthRecipient.js";
import { MODE_META, SHIELDED_DEPOSIT_NOTE } from "../trade/settlementCopy.js";
import { TokenIcon } from "../../components/TokenIcon.js";
import type { SendRetryDraft } from "./sendRetry.js";
import { SHIELDED_DESCRIPTION } from "./sendCopy.js";
import { PrivacyBars } from "../../components/PrivacyBars.js";
import { SITE_URL } from "../../config.js";
import { stealthSendDestinations } from "./stealthSend.js";
import { Receive } from "./Receive.js";
import { ScanRecipient } from "./ScanRecipient.js";
import type { ResolvedRecipient } from "../../lib/recipient/index.js";

type SettlementOrder = Omit<SwapPrefill, "nonce">;
const LAST_ASSET_KEY = "xochi:send:last-asset";

function lastAsset(chainId: number) {
  try {
    const address = localStorage.getItem(LAST_ASSET_KEY);
    return (
      sendTokens(chainId).find((token) => token.address === address) ?? defaultSendToken(chainId)
    );
  } catch {
    return defaultSendToken(chainId);
  }
}

interface SendFormProps {
  initialChain?: number;
  retry?: SendRetryDraft;
  onEditRetry?: () => void;
  active?: boolean;
  /** Hosted wallet UI delegates the connect prompt to the embedding page. */
  onConnectRequest?: () => void;
  destinations: readonly SendDestinationKind[];
  onQuote: (order: SettlementOrder, recipient: ResolvedRecipient) => void;
}

/** Every digit the token has: review shows the amount exactly, never rounded. */
const exact = (amount: bigint, decimals: number): string =>
  formatTokenAmount(amount, decimals, decimals);

export function SendForm(props: SendFormProps) {
  const { address } = useAccount();
  const [receive, setReceive] = useState(
    () => !props.retry && new URLSearchParams(location.search).get("receive") === "1",
  );
  return (
    <WalletSendForm
      key={`${address?.toLowerCase()}:${props.retry?.nonce}`}
      {...props}
      receive={receive}
      setReceive={setReceive}
    />
  );
}

function WalletSendForm({
  onConnectRequest,
  initialChain: requestedChain,
  retry,
  onEditRetry,
  active = true,
  destinations,
  onQuote,
  receive,
  setReceive,
}: SendFormProps & { receive: boolean; setReceive: (receive: boolean) => void }) {
  const id = useId();
  const [recoveryHash, setRecoveryHash] = useState<string | null>(null);
  const config = useConfig();
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connectWallet = onConnectRequest ?? openConnectModal;
  const { readBalanceOf } = usePublicBalances();
  const send = useAddressSend();

  const chainIds = useMemo(() => sendChainIds(config.chains.map((c) => c.id)), [config.chains]);
  const initialChain = defaultSendChain(chainIds, retry?.fromChainId ?? requestedChain);
  const retryToken =
    retry &&
    sendTokens(initialChain).find(
      (asset) => asset.address.toLowerCase() === retry.fromToken.toLowerCase(),
    );
  const [draft, setDraft] = useState<AddressSendDraft>(() => ({
    chainId: initialChain,
    tokenAddress: retryToken?.address ?? lastAsset(initialChain)?.address ?? "",
    amount:
      retry && retryToken && /^\d+$/.test(retry.fromAmount)
        ? exact(BigInt(retry.fromAmount), retryToken.decimals)
        : "",
    recipient: "",
  }));
  const [attempted, setAttempted] = useState(false);
  const [input, setInput] = useState(retry?.input ?? "");
  const [pasteError, setPasteError] = useState("");
  const [publicChoice, setPublicChoice] = useState<string>();
  const [reviewedRecipient, setReviewedRecipient] = useState<ResolvedRecipient>();
  const [selectedDestination, setSelectedDestination] = useState<number | undefined>(
    retry?.toChainId,
  );
  const [inviteStatus, setInviteStatus] = useState("");
  const history = useLocalSends();
  const { capabilities, state: capabilityState } = useCapabilities();

  const tokens = sendTokens(draft.chainId);
  const token = tokens.find((t) => t.address.toLowerCase() === draft.tokenAddress.toLowerCase());
  const balance = token ? readBalanceOf(draft.chainId, token.address) : null;
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const lookup = useSendRecipient(input, draft.chainId, lookupAttempt);
  const recipient = lookup.status === "resolved" ? lookup.recipient : undefined;
  const privacy = recipient?.shieldedAlias
    ? "Shielded"
    : recipient?.stealthMetaAddress && publicChoice !== input
      ? "Stealth"
      : "Public";
  const displayedMode = recipient ? privacy : (retry?.mode ?? privacy);
  const retryMismatch =
    retry &&
    recipient &&
    privacy !== retry.mode &&
    !(retry.mode === "Stealth" && publicChoice === input && privacy === "Public");
  const networkMismatch =
    privacy === "Public" && lookup.status === "resolved" && lookup.networkMismatch;
  const isZero = recipient?.address === "0x0000000000000000000000000000000000000000";
  const contract =
    recipient?.address && token && recipient.address.toLowerCase() === token.address.toLowerCase();
  const permitted = destinations.includes(privacy === "Stealth" ? "stealth" : "address");
  const stealthChains =
    privacy === "Stealth" && token
      ? stealthSendDestinations(capabilities, capabilityState, draft.chainId, token.symbol)
      : [];
  const destination =
    privacy === "Shielded"
      ? 1
      : privacy === "Public"
        ? draft.chainId
        : selectedDestination !== undefined && stealthChains.includes(selectedDestination)
          ? selectedDestination
          : stealthChains.includes(draft.chainId)
            ? draft.chainId
            : stealthChains[0];
  const canRoute =
    privacy === "Public" ||
    (privacy === "Stealth"
      ? destination !== undefined
      : capabilityState === "live" &&
        capabilities.routes?.some(
          (route) =>
            route.origin.chainId === draft.chainId &&
            route.origin.token === token?.symbol &&
            route.destination.kind === "zk_money" &&
            route.destination.token === "DAI" &&
            route.privacyModes.includes("public"),
        ) === true);
  const check = checkAddressSend(
    { ...draft, recipient: recipient?.address ?? "" },
    { chainIds, balance },
  );
  const amountCheck = token ? checkSendAmount(draft.amount, token, balance) : null;
  const errors: AddressSendErrors = attempted && !check.ok ? check.errors : {};
  const update = (patch: Partial<AddressSendDraft>): void => {
    onEditRetry?.();
    setDraft((d) => ({ ...d, ...patch }));
  };
  const { phase } = send;

  const onChain = (next: number): void => {
    const same = sendTokens(next).find((t) => t.symbol === token?.symbol) ?? defaultSendToken(next);
    update({ chainId: next, tokenAddress: same?.address ?? "" });
  };
  const onInput = useCallback(
    (next: string) => {
      onEditRetry?.();
      setInput(next);
      setPublicChoice(undefined);
      setPasteError("");
      setInviteStatus("");
    },
    [onEditRetry],
  );
  const paste = async () => {
    try {
      onInput((await navigator.clipboard.readText()).trim());
    } catch {
      setPasteError("Paste into To directly");
    }
  };
  const copyInvite = async () => {
    const embedded = window.parent !== window;
    const link = embedded
      ? new URL("/trade", SITE_URL)
      : new URL(location.pathname, location.origin);
    link.searchParams.set(embedded ? "tab" : "initialTab", "send");
    link.searchParams.set("receive", "1");
    try {
      await navigator.clipboard.writeText(link.href);
      setInviteStatus("Invite copied");
    } catch {
      setInviteStatus("Could not copy invite");
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!isConnected) {
      connectWallet?.();
      return;
    }
    setAttempted(true);
    if (
      !recipient ||
      isZero ||
      networkMismatch ||
      retryMismatch ||
      contract ||
      !permitted ||
      !canRoute ||
      !token ||
      !amountCheck ||
      "error" in amountCheck
    )
      return;
    if (privacy === "Public" && !check.ok) return;
    try {
      localStorage.setItem(LAST_ASSET_KEY, token.address);
    } catch {
      // Asset preference is optional. The transfer checkpoint is independent.
    }
    if (privacy === "Public") {
      if (check.ok) {
        setReviewedRecipient(recipient);
        send.review(check.order);
      }
      return;
    }
    const meta = parseStealthMetaAddress(recipient.stealthMetaAddress ?? "");
    if (destination === undefined) return;
    const destinationToken = sendTokens(destination).find(
      (candidate) => candidate.symbol === (privacy === "Shielded" ? "DAI" : token.symbol),
    );
    if (!destinationToken || (privacy === "Stealth" && !meta.ok)) return;
    onQuote(
      {
        fromChainId: draft.chainId as SelectableChainId,
        toChainId: destination as SelectableChainId,
        fromToken: token.address,
        toToken: destinationToken.address,
        fromAmount: amountCheck.amount.toString(),
        settlement: privacy === "Stealth" ? "stealth" : "public",
        ...(privacy === "Stealth" && meta.ok
          ? { stealthRecipient: meta.recipient }
          : { recipientTag: recipient.shieldedAlias }),
      },
      recipient,
    );
  };

  if (phase.step === "edit" && receive) {
    return (
      <>
        <div className="send-toolbar">
          <button type="button" className="send-secondary" onClick={() => setReceive(false)}>
            Back to Send
          </button>
        </div>
        <Receive onConnect={connectWallet} />
      </>
    );
  }

  if (phase.step === "edit") {
    const status = {
      empty: attempted ? "Enter a recipient" : "",
      looking: "Looking up…",
      resolved: "",
      not_found: "Not found. Try a 0x address, .eth, .gwei, .wei, or zk.money name",
      unsupported: "Not a supported name",
      unavailable: "Lookup unavailable",
      invalid: "reason" in lookup ? lookup.reason.replace(/\.$/, "") : "Check the recipient",
    }[lookup.status];
    const network = (
      <select
        aria-label="Pay from"
        className="send-field__control send-chip"
        value={draft.chainId}
        onChange={(e) => onChain(Number(e.target.value))}
      >
        {chainIds.map((chain) => (
          <option key={chain} value={chain}>
            {chainName(chain)}
          </option>
        ))}
      </select>
    );
    const firstTime =
      address &&
      recipient?.address &&
      !history.some(
        (item) =>
          item.status !== "failed" &&
          item.data.recipient.toLowerCase() === recipient.address?.toLowerCase(),
      );
    return (
      <form
        className="send-form send-form--recipient"
        onSubmit={onSubmit}
        noValidate
        aria-label="Send"
      >
        <div className="send-toolbar">
          <label className="send-field__label" htmlFor={`${id}-to`}>
            To
          </label>
          <button
            type="button"
            className="send-secondary"
            onClick={() => {
              onEditRetry?.();
              setReceive(true);
            }}
          >
            Receive
          </button>
        </div>
        <div className="send-field__with-action send-input send-input--recipient">
          <input
            id={`${id}-to`}
            className="send-field__control"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Name or address"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              onInput(e.clipboardData.getData("text").trim());
            }}
            aria-invalid={isZero || contract || lookup.status === "invalid" ? true : undefined}
          />
          <button
            type="button"
            className="send-secondary send-icon-button"
            aria-label="Paste"
            onClick={() => void paste()}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8M8 16h6" />
              <rect x="8" y="2" width="8" height="6" rx="2" />
            </svg>
          </button>
          {active && <ScanRecipient onScan={onInput} />}
        </div>
        {(pasteError || status) && (
          <p className="send-note" role="status">
            {pasteError || status}
          </p>
        )}
        {retry && !input && <p className="send-note">Paste the recipient again.</p>}
        {retryMismatch && (
          <p className="send-note">Enter a recipient who can receive with {retry.mode}</p>
        )}
        {lookup.status === "unavailable" && (
          <button
            type="button"
            className="send-secondary"
            onClick={() => setLookupAttempt((n) => n + 1)}
          >
            Retry
          </button>
        )}
        <div className="send-recipient-announcement" aria-live="polite">
          {recipient && (
            <div className="send-recipient-row">
              <RecipientChip recipient={recipient} />
              {privacy === "Stealth" && stealthChains.length > 1 ? (
                <select
                  aria-label="Destination network"
                  className="send-field__control send-chip"
                  value={destination}
                  onChange={(event) => {
                    onEditRetry?.();
                    setSelectedDestination(Number(event.target.value));
                  }}
                >
                  {stealthChains.map((chain) => (
                    <option key={chain} value={chain}>
                      {chainName(chain)}
                    </option>
                  ))}
                </select>
              ) : destination !== undefined ? (
                <span className="send-note">Arrives on {chainName(destination)}</span>
              ) : null}
            </div>
          )}
          {(recipient || retry) && (
            <div className="send-mode">
              <strong>
                <PrivacyBars
                  count={displayedMode === "Stealth" ? 2 : displayedMode === "Shielded" ? 3 : 1}
                  active
                />
                {displayedMode}
              </strong>
              <p className="send-note">
                {displayedMode === "Stealth"
                  ? MODE_META.stealth
                  : displayedMode === "Shielded"
                    ? SHIELDED_DESCRIPTION
                    : MODE_META.public}
              </p>
              {displayedMode === "Shielded" && <p className="send-note">{SHIELDED_DEPOSIT_NOTE}</p>}
            </div>
          )}
        </div>
        {recipient?.address &&
          recipient.stealthMetaAddress &&
          destinations.includes("address") &&
          (privacy === "Stealth" || destinations.includes("stealth")) && (
            <button
              type="button"
              className="send-secondary send-mode__action"
              onClick={() => setPublicChoice(privacy === "Stealth" ? input : undefined)}
            >
              {privacy === "Stealth" ? "Send publicly instead" : "Send with Stealth"}
            </button>
          )}
        {networkMismatch && (
          <p className="send-note">
            This name points to another address on {chainName(draft.chainId)}
          </p>
        )}
        {isZero && <p className="send-field__error">The zero address cannot receive funds</p>}
        {contract && <p className="send-field__error">This is a token contract, not a wallet</p>}
        {!contract && recipient && !permitted && (
          <p className="send-note">This mode is unavailable here. Try another recipient.</p>
        )}
        {!contract && recipient && permitted && !canRoute && (
          <p className="send-note">{privacy} route unavailable. Try another asset or network.</p>
        )}
        {!contract &&
          recipient?.address &&
          recipient.kind !== "address" &&
          !recipient.stealthMetaAddress &&
          !recipient.shieldedAlias && (
            <p className="send-note send-invite">
              <span>{recipient.name ?? "This wallet"} hasn't set up stealth receiving</span>
              <button type="button" className="send-secondary" onClick={() => void copyInvite()}>
                Copy invite
              </button>
              {inviteStatus && <span role="status">{inviteStatus}</span>}
            </p>
          )}
        {!contract && firstTime && <p className="send-note">First time sending here</p>}
        <label className="send-field__label" htmlFor={`${id}-amount`}>
          Amount
        </label>
        <div className="send-field__with-action send-input send-input--amount">
          <input
            id={`${id}-amount`}
            className="send-field__control"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={draft.amount}
            aria-invalid={errors.amount ? true : undefined}
            onChange={(e) => update({ amount: e.target.value })}
          />
          <div className="send-asset">
            {token && <TokenIcon symbol={token.symbol} className="token-icon" />}
            <select
              aria-label="Asset"
              className="send-field__control send-chip"
              value={token?.address ?? ""}
              onChange={(e) => update({ tokenAddress: e.target.value })}
            >
              {tokens.map((asset) => (
                <option key={asset.address} value={asset.address}>
                  {asset.symbol}
                </option>
              ))}
            </select>
          </div>
          {balance !== null && token && (
            <button
              type="button"
              className="send-secondary"
              onClick={() => update({ amount: exact(balance, token.decimals) })}
            >
              Max
            </button>
          )}
        </div>
        <div className="send-recipient-row">
          <span className="send-field__label">Pay from</span>
          {network}
        </div>
        {(errors.amount || (balance !== null && token)) && (
          <span className="send-field__hint">
            {errors.amount ??
              (token && balance !== null
                ? `Balance ${exact(balance, token.decimals)} ${token.symbol}`
                : "")}
          </span>
        )}
        <button
          type="submit"
          className="submit-btn send-cta"
          disabled={
            isConnected &&
            (!!contract ||
              !!networkMismatch ||
              !!retryMismatch ||
              isZero ||
              (!!recipient && (!permitted || !canRoute)) ||
              lookup.status === "looking")
          }
        >
          {isConnected ? "Send" : "Connect wallet"}
        </button>
      </form>
    );
  }

  if (phase.step === "blocked")
    return (
      <p className="send-note" role="alert">
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
        <dt>To</dt>
        <dd className="send-review__mono">{order.recipient}</dd>
      </div>
      <div>
        <dt>Privacy</dt>
        <dd>Public</dd>
      </div>
    </dl>
  );

  if (phase.step === "in_doubt") {
    const hash = phase.attempt.hash ?? recoveryHash ?? phase.attempt.candidateHash ?? "";
    return (
      <section className="send-review" aria-label="Send status unknown">
        <h3>Transfer status unknown</h3>
        {summary}
        <p role="alert">{phase.notice}</p>
        <label className="send-field">
          <span className="send-field__label">Transaction hash</span>
          <input
            className="send-field__control send-field__control--mono"
            value={hash}
            readOnly={!!phase.attempt.hash}
            onChange={(e) => setRecoveryHash(e.target.value)}
          />
        </label>
        <button type="button" className="send-secondary" onClick={() => void send.reconcile(hash)}>
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
              ? "The transfer failed onchain"
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
      {reviewedRecipient && <RecipientChip recipient={reviewedRecipient} />}
      {summary}
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
            {phase.step === "approving" ? "Confirm in your wallet…" : "Confirm in wallet"}
          </button>
        )}
      </div>
    </section>
  );
}
