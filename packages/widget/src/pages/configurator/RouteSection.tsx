/**
 * The Route section (xochi-fi/xochi-widget#35, #46): the route row (send leg,
 * flip, receive leg), the amount, and the locks. Each leg is the frame's own
 * token and chain picker (`TokenSelector`), so the configurator shows a route
 * the way the card does. Every choice the pickers list that leaves no route
 * the solver fills stays listed with the frame's reason and cannot be chosen
 * (routePicks.ts).
 */

import { useId, useState } from "react";
import { EXTENDED_CHAIN_NAMES } from "@xochi/client";
import type { Token } from "../../types/intent.js";
import { type EmbedLock } from "@xochi/widget-lib";
import { amountProblem, type EmbedDefaults, type EmbedOffer } from "../trade/embedParams.js";
import { TokenSelector, type ExtendedChainId } from "../trade/Selectors.js";
import { PolicyNote } from "./PolicyNote.js";
import {
  allowListPolicy,
  chainRefusal,
  changeRoute,
  flipRoute,
  offeredChain,
  tokenAvailability,
  type RouteChange,
  type RouteChoice,
} from "./routePicks.js";

/** The route in words, for its row: `250 USDT on Base to USDC on Ethereum`. */
export function routeSummary(config: EmbedDefaults): string {
  const amount = config.amount === "" ? "" : `${config.amount} `;
  return (
    `${amount}${config.fromToken.symbol} on ${EXTENDED_CHAIN_NAMES[config.fromChainId]} ` +
    `to ${config.toToken.symbol} on ${EXTENDED_CHAIN_NAMES[config.toChainId]}`
  );
}

/**
 * The locks for one part of the route (xochi-widget#39). Kept apart from the
 * pickers, which set the values a lock then holds.
 */
function LockChecks({
  fields,
  locks,
  held,
  onLocks,
}: {
  fields: readonly { lock: EmbedLock; label: string }[];
  locks: readonly EmbedLock[];
  /** Locks the frame applies though not asked: the amount lock's send leg. */
  held: readonly EmbedLock[];
  onLocks: (locks: readonly EmbedLock[]) => void;
}) {
  return (
    <div className="config-locks">
      {fields.map(({ lock, label }) => (
        <label key={lock} className="config-check">
          <input
            type="checkbox"
            checked={locks.includes(lock) || held.includes(lock)}
            disabled={held.includes(lock)}
            title={held.includes(lock) ? "Locked with the amount" : undefined}
            onChange={(e) =>
              onLocks(e.target.checked ? [...locks, lock] : locks.filter((field) => field !== lock))
            }
          />
          {label}
        </label>
      ))}
    </div>
  );
}

interface RouteSectionProps {
  offer: EmbedOffer;
  /** What the frame opens on now. */
  config: EmbedDefaults;
  /** The amount as typed, which may be one the frame refuses. */
  amountText: string;
  /** A control changed the route; this is the whole route it leaves. */
  onRoute: (route: RouteChoice) => void;
  onAmount: (text: string) => void;
  /** The locks as asked (the frame may drop an amount lock with no amount). */
  locks: readonly EmbedLock[];
  onLocks: (locks: readonly EmbedLock[]) => void;
  /** Why the frame drops a lock, if it does. */
  lockProblem: string | undefined;
}

export function RouteSection({
  offer,
  config,
  amountText,
  onRoute,
  onAmount,
  locks,
  onLocks,
  lockProblem,
}: RouteSectionProps) {
  const amountId = useId();
  const amountHintId = useId();
  const sendLabelId = useId();
  const receiveLabelId = useId();
  const flipHintId = useId();
  // Accumulated half-turns of the flip glyph, as on the card.
  const [turns, setTurns] = useState(0);

  const applyChange = (change: RouteChange): void => {
    const next = changeRoute(offer, config, change);
    if (next) onRoute(next);
  };

  // The pickers narrow to the allow-lists, not the locks (`allowListPolicy`).
  const pickerPolicy = allowListPolicy(config);

  // The picker moves the chain first when a token sits on another one; the
  // token's own change carries both, so it is the one that lands.
  const onToken = (leg: "sell" | "buy", token: Token): void => {
    if (tokenAvailability(offer, config, leg, token).state !== "available") return;
    const chainId = offeredChain(offer, leg, token.chainId);
    if (chainId === null) return;
    applyChange(
      leg === "sell"
        ? { fromChainId: chainId, sellSymbol: token.symbol }
        : { toChainId: chainId, buySymbol: token.symbol },
    );
  };
  const onChain = (leg: "sell" | "buy", id: ExtendedChainId): void => {
    const chainId = offeredChain(offer, leg, id);
    if (chainId === null || chainRefusal(offer, config, leg, chainId) !== null) return;
    applyChange(leg === "sell" ? { fromChainId: chainId } : { toChainId: chainId });
  };

  const flip = flipRoute(offer, config);

  const trimmedAmount = amountText.trim();
  const amountError = trimmedAmount === "" ? null : amountProblem(trimmedAmount, config.fromToken);
  // The locks the frame holds beyond those asked (the amount lock's send leg).
  const held = config.locks.filter((lock) => !locks.includes(lock));

  return (
    <>
      <div className="config-route">
        <div className="config-route__leg" role="group" aria-labelledby={sendLabelId}>
          <span id={sendLabelId} className="config-route__label">
            Send
          </span>
          <TokenSelector
            chainId={config.fromChainId}
            value={config.fromToken}
            chainIds={offer.sourceChainIds}
            tokensByChain={offer.routeModel.originTokens}
            onChange={(token) => onToken("sell", token)}
            onChainChange={(id) => onChain("sell", id)}
            showChain
            isSource
            policy={pickerPolicy}
            classify={(token) => tokenAvailability(offer, config, "sell", token)}
            chainBlockedReason={(id) => chainRefusal(offer, config, "sell", id)}
          />
        </div>
        <button
          type="button"
          className="swap-btn config-route__flip"
          aria-label="Flip route"
          // Not `disabled`: the reason has to stay reachable (see the hint).
          aria-disabled={flip.blocked === null ? undefined : true}
          aria-describedby={flip.blocked === null ? undefined : flipHintId}
          onClick={() => {
            if (flip.route === null) return;
            setTurns((t) => t + 1);
            onRoute(flip.route);
          }}
        >
          <svg
            className="swap-icon-svg"
            viewBox="0 0 20 16"
            width="18"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: `rotate(${turns * 180}deg)` }}
            aria-hidden="true"
          >
            <path d="M5 6L10 1L15 6" />
            <path d="M5 10L10 15L15 10" />
          </svg>
        </button>
        <div className="config-route__leg" role="group" aria-labelledby={receiveLabelId}>
          <span id={receiveLabelId} className="config-route__label">
            Receive
          </span>
          <TokenSelector
            chainId={config.toChainId}
            value={config.toToken}
            chainIds={offer.destinationChainIds}
            tokensByChain={offer.routeModel.destinationTokens}
            onChange={(token) => onToken("buy", token)}
            onChainChange={(id) => onChain("buy", id)}
            showChain
            policy={pickerPolicy}
            classify={(token) => tokenAvailability(offer, config, "buy", token)}
            chainBlockedReason={(id) => chainRefusal(offer, config, "buy", id)}
          />
        </div>
      </div>
      {flip.blocked === null ? null : (
        <p id={flipHintId} className="config-hint">
          Can't flip: {flip.blocked}
        </p>
      )}
      <LockChecks
        fields={[
          { lock: "sell", label: "Lock send token" },
          { lock: "fromChain", label: "Lock send chain" },
          { lock: "buy", label: "Lock receive token" },
          { lock: "toChain", label: "Lock receive chain" },
        ]}
        locks={locks}
        held={held}
        onLocks={onLocks}
      />

      <div className="config-field config-field--amount">
        <label htmlFor={amountId} className="label">
          Amount to send
        </label>
        <div className="config-amount">
          <input
            id={amountId}
            className="config-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Empty"
            value={amountText}
            aria-invalid={amountError !== null}
            aria-describedby={amountHintId}
            onChange={(e) => onAmount(e.target.value)}
          />
          <span className="config-amount__unit">{config.fromToken.symbol}</span>
        </div>
        <p
          id={amountHintId}
          className={amountError ? "config-hint config-hint--error" : "config-hint"}
        >
          {amountError ?? "Leave empty to let the user type it."}
        </p>
      </div>
      <LockChecks
        fields={[{ lock: "amount", label: "Lock amount (locks the send token and chain too)" }]}
        locks={locks}
        held={held}
        onLocks={onLocks}
      />
      {lockProblem === undefined ? null : (
        <p className="config-hint config-hint--error" role="status">
          Amount lock not applied: {lockProblem}.
        </p>
      )}
      <PolicyNote />
    </>
  );
}
