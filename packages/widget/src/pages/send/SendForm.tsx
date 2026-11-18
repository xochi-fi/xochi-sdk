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
import { abbreviateMetaAddress, parseStealthMetaAddress } from "./stealthRecipient.js";
import { STEALTH_PRIVACY_LIMITS } from "../trade/settlementCopy.js";
import { stealthSendDestinations } from "./stealthSend.js";
import { Receive } from "./Receive.js";
import { ScanRecipient } from "./ScanRecipient.js";
import type { ResolvedRecipient } from "../../lib/recipient/index.js";

type SettlementOrder = Omit<SwapPrefill, "nonce">;
type RoutedReview = {
  order: SettlementOrder;
  recipient: ResolvedRecipient;
  privacy: "Private" | "Shielded";
  amount: string;
};

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

function RecipientChip({ recipient }: { recipient: ResolvedRecipient }) {
  const value =
    recipient.address ?? recipient.stealthMetaAddress ?? recipient.shieldedAlias ?? recipient.input;
  const short = value.startsWith("0x")
    ? `${value.slice(0, 6)}…${value.slice(-4)}`
    : value.startsWith("st:eth:")
      ? abbreviateMetaAddress(value)
      : value;
  const hue = [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 0);
  return (
    <span className="send-recipient">
      <span
        className="send-identicon"
        aria-hidden="true"
        style={{
          background: `conic-gradient(from ${hue}deg, hsl(${hue} 60% 45%) 25%, hsl(${(hue + 100) % 360} 65% 68%) 0 50%, hsl(${hue} 60% 45%) 0 75%, hsl(${(hue + 100) % 360} 65% 68%) 0)`,
        }}
      />
      <span>
        {recipient.name && <strong>{recipient.name}</strong>}
        <small>{short}</small>
      </span>
    </span>
  );
}

interface SendFormProps {
  initialChain?: number;
  active?: boolean;
  /** Hosted wallet UI delegates the connect prompt to the embedding page. */
  onConnectRequest?: () => void;
  destinations: readonly SendDestinationKind[];
  onStealthContinue: (order: SettlementOrder) => void;
}

/** Every digit the token has: review shows the amount exactly, never rounded. */
const exact = (amount: bigint, decimals: number): string =>
  formatTokenAmount(amount, decimals, decimals);

export function SendForm(props: SendFormProps) {
  const { address } = useAccount();
  return <WalletSendForm key={address?.toLowerCase()} {...props} />;
}

function WalletSendForm({
  onConnectRequest,
  initialChain: requestedChain,
  active = true,
  destinations,
  onStealthContinue,
}: SendFormProps) {
  const id = useId();
  const [recoveryHash, setRecoveryHash] = useState<string | null>(null);
  const config = useConfig();
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const connectWallet = onConnectRequest ?? openConnectModal;
  const { readBalanceOf } = usePublicBalances();
  const send = useAddressSend();

  const chainIds = useMemo(() => sendChainIds(config.chains.map((c) => c.id)), [config.chains]);
  const initialChain = defaultSendChain(chainIds, requestedChain);
  const [draft, setDraft] = useState<AddressSendDraft>(() => ({
    chainId: initialChain,
    tokenAddress: lastAsset(initialChain)?.address ?? "",
    amount: "",
    recipient: "",
  }));
  const [attempted, setAttempted] = useState(false);
  const [input, setInput] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [publicChoice, setPublicChoice] = useState<string>();
  const [receive, setReceive] = useState(
    () => new URLSearchParams(location.search).get("receive") === "1",
  );
  const [reviewedRecipient, setReviewedRecipient] = useState<ResolvedRecipient>();
  const [routedReview, setRoutedReview] = useState<RoutedReview>();
  const [selectedDestination, setSelectedDestination] = useState<number>();
  const [inviteStatus, setInviteStatus] = useState("");
  const history = useLocalSends();
  const { capabilities, state: capabilityState } = useCapabilities();

  const tokens = sendTokens(draft.chainId);
  const token = tokens.find((t) => t.address.toLowerCase() === draft.tokenAddress.toLowerCase());
  const balance = token ? readBalanceOf(draft.chainId, token.address) : null;
  const lookup = useSendRecipient(input, draft.chainId);
  const recipient = lookup.status === "resolved" ? lookup.recipient : undefined;
  const privacy = recipient?.shieldedAlias
    ? "Shielded"
    : recipient?.stealthMetaAddress && publicChoice !== input
      ? "Private"
      : "Public";
  const networkMismatch =
    privacy === "Public" && lookup.status === "resolved" && lookup.networkMismatch;
  const isZero = recipient?.address === "0x0000000000000000000000000000000000000000";
  const contract =
    recipient?.address && token && recipient.address.toLowerCase() === token.address.toLowerCase();
  const permitted = destinations.includes(privacy === "Private" ? "stealth" : "address");
  const privateChains =
    privacy === "Private" && token
      ? stealthSendDestinations(capabilities, capabilityState, draft.chainId, token.symbol)
      : [];
  const destination =
    privacy === "Shielded"
      ? 1
      : privacy === "Public"
        ? draft.chainId
        : selectedDestination !== undefined && privateChains.includes(selectedDestination)
          ? selectedDestination
          : privateChains.includes(draft.chainId)
            ? draft.chainId
            : privateChains[0];
  const canRoute =
    privacy === "Public" ||
    (privacy === "Private"
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
  const update = (patch: Partial<AddressSendDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const { phase } = send;

  const onChain = (next: number): void => {
    const same = sendTokens(next).find((t) => t.symbol === token?.symbol) ?? defaultSendToken(next);
    setPublicChoice(undefined);
    update({ chainId: next, tokenAddress: same?.address ?? "" });
  };
  const onInput = useCallback((next: string) => {
    setInput(next);
    setPublicChoice(undefined);
    setPasteError("");
    setInviteStatus("");
  }, []);
  const paste = async () => {
    try {
      onInput((await navigator.clipboard.readText()).trim());
    } catch {
      setPasteError("Paste into To directly");
    }
  };
  const copyInvite = async () => {
    const link = new URL(location.pathname, location.origin);
    link.searchParams.set("initialTab", "send");
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
    if (!destinationToken || (privacy === "Private" && !meta.ok)) return;
    setRoutedReview({
      privacy,
      recipient,
      amount: `${exact(amountCheck.amount, token.decimals)} ${token.symbol}`,
      order: {
        fromChainId: draft.chainId as SelectableChainId,
        toChainId: destination as SelectableChainId,
        fromToken: token.address,
        toToken: destinationToken.address,
        fromAmount: amountCheck.amount.toString(),
        settlement: privacy === "Private" ? "stealth" : "public",
        ...(privacy === "Private" && meta.ok
          ? { stealthRecipient: meta.recipient }
          : { recipientTag: recipient.shieldedAlias }),
      },
    });
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

  if (phase.step === "edit" && routedReview) {
    const { order, privacy: reviewedPrivacy, recipient: payee, amount } = routedReview;
    return (
      <section className="send-review" aria-label="Review send">
        <RecipientChip recipient={payee} />
        <dl className="send-review__facts">
          <div>
            <dt>To</dt>
            <dd className="send-review__mono">
              {order.stealthRecipient?.encoded ?? payee.address ?? payee.input}
            </dd>
          </div>
          {payee.address && order.stealthRecipient && (
            <div>
              <dt>Wallet</dt>
              <dd className="send-review__mono">{payee.address}</dd>
            </div>
          )}
          <div>
            <dt>Network</dt>
            <dd>
              {order.fromChainId !== order.toChainId && `${chainName(order.fromChainId)} → `}
              {chainName(order.toChainId)}
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{amount}</dd>
          </div>
          <div>
            <dt>Privacy</dt>
            <dd>{reviewedPrivacy}</dd>
          </div>
        </dl>
        {reviewedPrivacy === "Private" && <p className="send-note">{STEALTH_PRIVACY_LIMITS}</p>}
        <div className="send-review__actions">
          <button
            type="button"
            className="send-secondary"
            onClick={() => setRoutedReview(undefined)}
          >
            Back
          </button>
          <button
            type="button"
            className="submit-btn send-cta"
            onClick={() => {
              setRoutedReview(undefined);
              onStealthContinue(order);
            }}
          >
            Continue to quote
          </button>
        </div>
      </section>
    );
  }

  if (phase.step === "edit") {
    const status = {
      empty: attempted ? "Enter a recipient" : "",
      looking: "Looking up…",
      resolved: "",
      not_found: "Not found",
      unsupported: "Not a supported name",
      unavailable: "Lookup unavailable",
      invalid: /^0x/i.test(input.trim()) ? "Check this address" : "Check this stealth address",
    }[lookup.status];
    const network = (
      <select
        aria-label="Network"
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
          <label htmlFor={`${id}-to`}>To</label>
          <button type="button" className="send-secondary" onClick={() => setReceive(true)}>
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
            placeholder="Name, address, or stealth address"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              onInput(e.clipboardData.getData("text").trim());
            }}
            aria-invalid={isZero || contract || lookup.status === "invalid" ? true : undefined}
          />
          <button type="button" className="send-secondary" onClick={() => void paste()}>
            Paste
          </button>
          {active && <ScanRecipient onScan={onInput} />}
        </div>
        {(pasteError || status) && (
          <p className="send-note" role="status">
            {pasteError || status}
          </p>
        )}
        <div className="send-recipient-row">
          {recipient && <RecipientChip recipient={recipient} />}
          {privacy === "Private" && destination !== undefined ? (
            <select
              aria-label="Destination network"
              className="send-field__control send-chip"
              value={destination}
              onChange={(event) => setSelectedDestination(Number(event.target.value))}
            >
              {privateChains.map((chain) => (
                <option key={chain} value={chain}>
                  {chainName(chain)}
                </option>
              ))}
            </select>
          ) : privacy === "Shielded" ? (
            <span className="send-chip">Ethereum</span>
          ) : (
            network
          )}
          {recipient &&
            (recipient.address &&
            recipient.stealthMetaAddress &&
            destinations.includes("address") &&
            (privacy === "Private" || destinations.includes("stealth")) ? (
              <button
                type="button"
                className="send-secondary send-chip"
                aria-label={`Privacy: ${privacy}. Switch to ${privacy === "Private" ? "Public" : "Private"}`}
                onClick={() => setPublicChoice(privacy === "Private" ? input : undefined)}
              >
                {privacy}
              </button>
            ) : (
              <span className="send-chip">{privacy}</span>
            ))}
        </div>
        {networkMismatch && (
          <p className="send-note">
            This name points to another address on {chainName(draft.chainId)}
          </p>
        )}
        {isZero && <p className="send-field__error">Check this address</p>}
        {contract && <p className="send-field__error">This is a token contract, not a wallet</p>}
        {!contract && recipient && !permitted && (
          <p className="send-note">This privacy mode is unavailable here</p>
        )}
        {!contract && recipient && permitted && !canRoute && (
          <p className="send-note">{privacy} route unavailable</p>
        )}
        {!contract &&
          recipient?.address &&
          !recipient.stealthMetaAddress &&
          !recipient.shieldedAlias && (
            <p className="send-note send-invite">
              <span>{recipient.name ?? "This wallet"} hasn't set up private receiving</span>
              <button type="button" className="send-secondary" onClick={() => void copyInvite()}>
                Copy invite link
              </button>
              {inviteStatus && <span role="status">{inviteStatus}</span>}
            </p>
          )}
        {!contract && firstTime && <p className="send-note">First time sending here</p>}
        <label className="send-field__label" htmlFor={`${id}-amount`}>
          Amount
        </label>
        <div className="send-field__with-action send-input">
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
          <button
            type="button"
            className="send-secondary"
            disabled={balance === null || !token}
            onClick={() => {
              if (balance !== null && token) update({ amount: exact(balance, token.decimals) });
            }}
          >
            Max
          </button>
        </div>
        {(privacy === "Shielded" || (privacy === "Private" && destination !== undefined)) && (
          <div className="send-recipient-row">
            <span>Pay from</span>
            {network}
          </div>
        )}
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
