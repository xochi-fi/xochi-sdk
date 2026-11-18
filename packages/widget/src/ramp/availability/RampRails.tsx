/**
 * RampRails
 *
 * Live Peer rail availability for Trade/Buy (`onramp`) and Send/payment_app
 * (`offramp`). The critical facts come first, before any rail can be chosen.
 * Fresh `available` offers form a native radio group (arrow keys move, one
 * tab stop); every other rail stays readable in a list with its state, reason
 * and next step in text. Nothing here starts a purchase or a cash-out: the
 * selection is held for the execution flow that follows (W2/W4).
 */

import { RailTiles, RailChoice, UnavailableRails } from "./RailTiles.js";
import { isPeerMobileWeb } from "../peer/environment.js";
import { useId, useState, type ReactNode } from "react";
import type { RampDirection, RampIntent, RampOffer } from "@xochi/client";
import {
  formatRampTime,
  overallCard,
  parseRampAmount,
  railCard,
  rampFacts,
  type RailCard,
} from "./model.js";
import { useRampDiscovery } from "./useRampDiscovery.js";
import { formatUsdc } from "../offramp/model.js";

const COPY: Record<
  RampDirection,
  { title: string; amountLabel: string; currencyLabel: string; selected: string }
> = {
  onramp: {
    title: "Buy USDC on Base with a payment app",
    amountLabel: "USDC to receive",
    currencyLabel: "Pay in",
    selected: "This view cannot start a purchase; nothing will be charged.",
  },
  offramp: {
    title: "Cash out to your own payment app",
    amountLabel: "USDC to cash out",
    currencyLabel: "Receive in",
    selected: "This view cannot start a cash-out; nothing will be sent.",
  },
};

interface RampRailsProps {
  direction: RampDirection;
  /** Connected wallet, the onramp recipient and offramp seller. */
  account: string | undefined;
  /** Host default (`fiatCurrency`); the only other choice is USD. */
  fiatCurrency?: string;
  /** Whether this surface is the visible one; hidden surfaces read nothing. */
  active: boolean;
  onConnectRequest?: () => void;
  renderSelected?: (
    intent: RampIntent,
    offer: RampOffer,
    lock: (value?: boolean) => void,
  ) => ReactNode;
}

export function RampRails({
  direction,
  account,
  fiatCurrency = "USD",
  active,
  onConnectRequest,
  renderSelected,
}: RampRailsProps) {
  const id = useId();
  const [locked, setLocked] = useState<{ intent: RampIntent; offer: RampOffer }>();
  const copy = COPY[direction];
  const [amountText, setAmountText] = useState("");
  const [currency, setCurrency] = useState(fiatCurrency);
  const [selected, setSelected] = useState<string | undefined>();
  const mobile = direction === "onramp" && isPeerMobileWeb();
  const amount = parseRampAmount(amountText);
  const amountInvalid = amountText.trim() !== "" && amount === undefined;
  const { state, now, settlement, refresh, cap } = useRampDiscovery({
    direction,
    amount,
    currency,
    account,
    enabled: active && !mobile,
  });

  const cards: RailCard[] =
    state.status === "done" && settlement && account && amount !== undefined && !mobile
      ? state.result.offers.map((offer) => railCard(offer, state.intent, settlement, now))
      : [];
  const selectable = cards.filter((c) => c.selectable);
  const blocked = cards.filter((c) => !c.selectable);
  const chosen = selectable.find((c) => c.id === selected);
  const lost = selected !== undefined && chosen === undefined && state.status === "done";
  const currencies = [...new Set([fiatCurrency, "USD"])];

  let status: string;
  if (!settlement)
    status = "Peer's Base USDC configuration did not validate, so no rail can be used.";
  else if (!account) status = "Connect a wallet and enter an amount to check availability.";
  else if (amount === undefined) status = "Enter an amount to check availability.";
  else if (cap !== undefined)
    status = `This deployment limits each purchase to ${formatUsdc(cap)} for now. Enter ${formatUsdc(cap)} or less.`;
  else if (state.status !== "done") status = "Checking payment apps...";
  else
    status =
      selectable.length === 0
        ? "No rail can be chosen right now."
        : `${selectable.length} of ${cards.length} ${cards.length === 1 ? "rail" : "rails"} can be chosen.`;

  return (
    <section className="ramp-rails" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="send-review__title">
        {copy.title}
      </h3>

      {mobile && (
        <p className="send-note" role="status">
          Buy in desktop Chrome or Brave with the Peer extension, or use the Peer app.
        </p>
      )}
      {!mobile && (
        <div className="send-form__row">
          <label className="send-field">
            <span className="send-field__label">{copy.amountLabel}</span>
            <input
              className="send-field__control"
              disabled={locked !== undefined}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amountText}
              aria-invalid={amountInvalid}
              aria-describedby={amountInvalid ? `${id}-amount-error` : undefined}
              onChange={(e) => {
                setAmountText(e.target.value);
                setSelected(undefined);
              }}
            />
            {amountInvalid && (
              <span id={`${id}-amount-error`} className="send-field__error">
                Enter a positive amount with at most 6 decimals.
              </span>
            )}
          </label>
          <label className="send-field">
            <span className="send-field__label">{copy.currencyLabel}</span>
            <select
              className="send-field__control"
              value={currency}
              disabled={locked !== undefined}
              onChange={(e) => {
                setCurrency(e.target.value);
                setSelected(undefined);
              }}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <section className="ramp-facts" aria-labelledby={`${id}-facts`}>
        <h4 id={`${id}-facts`} className="ramp-facts__title">
          Before you choose
        </h4>
        <ul className="ramp-facts__list">
          {rampFacts(direction).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>

      {!mobile && (
        <p className="send-note" role="status" aria-live="polite">
          {status}
          {lost && " The rail you chose is no longer available; choose again."}
        </p>
      )}

      {state.status === "done" && cards.length === 0 && (
        <OverallCard {...overallCard(state.result.availability, direction)} />
      )}

      <RailTiles title="Payment apps" untested={mobile || state.status !== "done"}>
        {selectable.map((card) => (
          <RailChoice
            key={card.id}
            card={card}
            name={card.name}
            group={`${id}-rail`}
            selected={chosen?.id === card.id}
            disabled={locked !== undefined}
            onSelect={() => setSelected(card.id)}
          />
        ))}
      </RailTiles>
      <UnavailableRails cards={blocked} />
      {!account && !mobile && onConnectRequest && (
        <button
          type="button"
          className="submit-btn send-cta ramp-bottom-action"
          onClick={onConnectRequest}
        >
          Connect wallet
        </button>
      )}

      {state.status === "done" && (
        <button
          type="button"
          className="send-secondary"
          disabled={locked !== undefined}
          onClick={refresh}
        >
          Check again
        </button>
      )}

      {renderSelected &&
        (locked
          ? renderSelected(locked.intent, locked.offer, (value = true) => {
              if (!value) {
                setLocked(undefined);
                setSelected(undefined);
                refresh();
              }
            })
          : chosen && state.status === "done"
            ? renderSelected(
                state.intent,
                state.result.offers.find((offer) => offer.rail.id === chosen.id)!,
                () =>
                  setLocked({
                    intent: state.intent,
                    offer: state.result.offers.find((offer) => offer.rail.id === chosen.id)!,
                  }),
              )
            : null)}

      {chosen && !renderSelected && (
        <p className="send-note" role="note">
          {`${chosen.name} selected. ${copy.selected}`}
        </p>
      )}
    </section>
  );
}

export function OverallCard(card: Omit<RailCard, "id" | "name" | "needs">) {
  return (
    <div className="ramp-rail" role="note">
      <span className="ramp-rail__body">
        <span className="ramp-rail__head">
          <span className="ramp-rail__name">Peer</span>
          <span className={`ramp-rail__status ramp-rail__status--${card.state}`}>
            {card.status}
          </span>
        </span>
        <span className="ramp-rail__text">{card.reason}</span>
        {card.retryAfter && (
          <span className="ramp-rail__text">{`Retry after ${formatRampTime(card.retryAfter)}.`}</span>
        )}
        {card.next && <span className="ramp-rail__text">{`Next: ${card.next}`}</span>}
      </span>
    </div>
  );
}
