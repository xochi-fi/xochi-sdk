/**
 * PaymentAppSend
 *
 * Send/payment_app: cash Base USDC out to the user's own payment-app account
 * through a Peer maker deposit (W4, #177).
 *
 *   edit   -> live rails (only fresh `available` offers are radios), amount,
 *             currency, and the source asset (Base USDC only; anything else
 *             needs W6's separate Xochi route and is not executable here);
 *   review -> platform, currency, own-account payee (masked once entered),
 *             deposit amount, approximate payout and the public Base
 *             transaction; a stale estimate cannot be confirmed;
 *   order  -> explicit wallet approvals one at a time, then progress from
 *             chain and indexer facts, and withdrawal of unmatched USDC.
 *
 * The payee handle lives in this component's state until the review is
 * confirmed, then only in S5's provider-private store.
 */

import { useContext, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useAccount, useConfig } from "wagmi";
import type { RampOffer } from "@xochi/client";
import {
  formatRampTime,
  overallCard,
  parseRampAmount,
  railCard,
  rampFacts,
  type RailCard,
} from "../availability/model.js";
import {
  canaryCapError,
  canWithdraw,
  estimateSecondsLeft,
  formatEstimate,
  formatUsdc,
  maskPayee,
  orderHeadline,
  payeeError,
  progressSteps,
  usdcDecimal,
  WALLET_ACTION_LABELS,
} from "./model.js";
import { BASE_CHAIN_ID, createLiveOfframpPort, OfframpPortContext } from "./port.js";
import { useOfframp, type OfframpOrder, type OfframpQuote } from "./useOfframp.js";
import { CompletedPrerequisite } from "./CompletedPrerequisite.js";
import { OfframpRoute } from "./OfframpRoute.js";
import { inspectOfframpPrerequisite, type OfframpPrerequisite } from "./prerequisite.js";
import { useOfframpRails } from "./useOfframpRails.js";

type Flow = ReturnType<typeof useOfframp>;

interface PaymentAppSendProps {
  /** Whether this surface is the visible one; hidden surfaces read nothing. */
  active: boolean;
  /** Host default (`fiatCurrency`); the only other choice is USD. */
  fiatCurrency?: string;
}

function useOfframpPort() {
  const injected = useContext(OfframpPortContext);
  const config = useConfig();
  return useMemo(() => injected ?? createLiveOfframpPort(config), [injected, config]);
}

export function PaymentAppSend({ active, fiatCurrency = "USD" }: PaymentAppSendProps) {
  const port = useOfframpPort();
  const { address } = useAccount();
  return (
    <WalletPaymentAppSend
      key={address}
      address={address}
      port={port}
      active={active}
      fiatCurrency={fiatCurrency}
    />
  );
}

function WalletPaymentAppSend({
  active,
  fiatCurrency = "USD",
  address,
  port,
}: PaymentAppSendProps & {
  address?: string;
  port: ReturnType<typeof useOfframpPort>;
}) {
  const id = useId();
  const checkpoint = address ? inspectOfframpPrerequisite(address) : undefined;
  const [route, setRoute] = useState<OfframpPrerequisite>();
  const [routeAmount, setRouteAmount] = useState<string>();
  const funding = useMemo(
    () =>
      route ? (amount: string) => route.funded(amount) : checkpoint ? async () => false : undefined,
    [route, !!checkpoint],
  );
  const flow = useOfframp(port, address, active, funding);

  return (
    <section className="ramp-rails" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="send-review__title">
        Cash out to your own payment app
      </h3>
      {checkpoint && !route && flow.view.kind !== "edit" && (
        <OfframpRoute
          key={address}
          port={port}
          onLock={() => {}}
          onReceipt={setRoute}
          onReady={(next, amount) => {
            setRoute(next);
            setRouteAmount(amount);
          }}
        />
      )}
      {route && (
        <CompletedPrerequisite
          receipt={route.snapshot().xochi?.transaction_hash ?? route.snapshot().operation_id}
          wallet={address ?? ""}
          peerFailed={
            flow.view.kind === "order" &&
            flow.view.order.stage === "before_deposit" &&
            flow.view.order.snapshot.peer.state === "failed"
          }
        />
      )}
      {flow.view.kind === "edit" && (
        <EditStep
          key={address}
          flow={flow}
          account={address}
          active={active}
          fiatCurrency={fiatCurrency}
          routeAmount={routeAmount}
          onReceipt={setRoute}
          onReady={(next, amount) => {
            setRoute(next);
            setRouteAmount(amount);
          }}
        />
      )}
      {flow.view.kind === "review" && <ReviewStep flow={flow} quote={flow.view.quote} />}
      {flow.view.kind === "order" && <OrderStep flow={flow} order={flow.view.order} />}
      {flow.notice && (
        <p className="send-field__error" role="alert">
          {flow.notice}
        </p>
      )}
    </section>
  );
}

function EditStep({
  flow,
  account,
  active,
  fiatCurrency,
  routeAmount,
  onReady,
  onReceipt,
}: {
  flow: Flow;
  account: string | undefined;
  active: boolean;
  fiatCurrency: string;
  routeAmount?: string;
  onReady(route: OfframpPrerequisite, amount: string): void;
  onReceipt(route: OfframpPrerequisite): void;
}) {
  const id = useId();
  const port = useOfframpPort();
  const settlement = useMemo(() => port.settlement(), [port]);
  const [routeLocked, setRouteLocked] = useState(
    () => !!(account && inspectOfframpPrerequisite(account)),
  );
  const [source, setSource] = useState<"base_usdc" | "other">(() =>
    account && inspectOfframpPrerequisite(account) ? "other" : "base_usdc",
  );
  const [amountText, setAmountText] = useState(routeAmount ? usdcDecimal(routeAmount) : "");
  const [currency, setCurrency] = useState(fiatCurrency);
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    if (routeAmount) {
      setSource("base_usdc");
      setAmountText(usdcDecimal(routeAmount));
    }
  }, [routeAmount]);
  const amount = parseRampAmount(amountText);
  const amountInvalid = amountText.trim() !== "" && amount === undefined;
  // Enforced before any rail read or review: an over-cap amount is never estimated.
  const overCap = canaryCapError(amount, port.canaryCap());
  const { state, now, refresh } = useOfframpRails({
    port,
    runtime: flow.runtime,
    settlement,
    account,
    amount: overCap ? undefined : amount,
    currency,
    enabled: active && source === "base_usdc",
  });

  const cards: { card: RailCard; offer: RampOffer }[] =
    state.status === "done" && settlement
      ? state.offers.map((offer) => ({
          offer,
          card: railCard(offer, state.intent, settlement, now),
        }))
      : [];
  const selectable = cards.filter((c) => c.card.selectable);
  const blocked = cards.filter((c) => !c.card.selectable);
  const chosen = selectable.find((c) => c.card.id === selected);
  const lost = selected !== undefined && chosen === undefined && state.status === "done";
  const currencies = [...new Set([fiatCurrency, "USD"])];
  const estimateFor = (offer: RampOffer) =>
    state.status === "done" ? state.estimates.find((e) => e.offerId === offer.offer_id) : undefined;

  let status: string;
  if (!settlement)
    status = "Peer's Base USDC configuration did not validate, so no rail can be used.";
  else if (!account) status = "Connect a wallet to check live Peer rails for it.";
  else if (flow.runtimeFailed) status = "The cash-out runtime could not start for this wallet.";
  else if (amount === undefined) status = "Enter an amount to check live Peer rails.";
  else if (overCap) status = overCap;
  else if (state.status !== "done") status = "Checking live Peer rails...";
  else
    status =
      selectable.length === 0
        ? "No rail can be chosen right now."
        : `${selectable.length} of ${cards.length} ${cards.length === 1 ? "rail" : "rails"} can be chosen.`;

  return (
    <>
      <section className="ramp-facts" aria-labelledby={`${id}-facts`}>
        <h4 id={`${id}-facts`} className="ramp-facts__title">
          Before you choose
        </h4>
        <ul className="ramp-facts__list">
          {rampFacts("offramp").map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>

      <label className="send-field">
        <span className="send-field__label">Cash out from</span>
        <select
          className="send-field__control"
          value={source}
          disabled={!!routeAmount || routeLocked}
          onChange={(e) => {
            setSource(e.target.value as "base_usdc" | "other");
            setSelected(undefined);
          }}
        >
          <option value="base_usdc">USDC on Base</option>
          <option value="other">Another token or network</option>
        </select>
      </label>

      {source === "other" ? (
        <OfframpRoute
          port={port}
          onReceipt={onReceipt}
          onReady={onReady}
          onLock={() => setRouteLocked(true)}
        />
      ) : (
        <>
          <div className="send-form__row">
            <label className="send-field">
              <span className="send-field__label">USDC to cash out</span>
              <input
                className="send-field__control"
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
              <span className="send-field__label">Receive in</span>
              <select
                className="send-field__control"
                value={currency}
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

          <p className="send-note" role="status" aria-live="polite">
            {status}
            {lost && " The rail you chose is no longer available; choose again."}
          </p>

          {state.status === "done" && cards.length === 0 && (
            <OverallCard {...overallCard(state.availability, "offramp")} />
          )}

          {selectable.length > 0 && (
            <fieldset className="ramp-rails__group">
              <legend className="ramp-facts__title">Available now</legend>
              {selectable.map(({ card, offer }) => {
                const est = estimateFor(offer);
                return (
                  <label key={card.id} className="ramp-rail ramp-rail--selectable">
                    <input
                      type="radio"
                      name={`${id}-rail`}
                      value={card.id}
                      checked={chosen?.card.id === card.id}
                      onChange={() => setSelected(card.id)}
                      aria-labelledby={`${id}-${card.id}-name`}
                      aria-describedby={`${id}-${card.id}-detail`}
                    />
                    <RailBody
                      card={card}
                      idPrefix={`${id}-${card.id}`}
                      estimate={
                        est
                          ? `Estimated payout ${formatEstimate(est.receive.atomic, est.receive.asset.kind === "fiat" ? est.receive.asset.currency : currency, est.receive.asset.decimals)}.`
                          : undefined
                      }
                    />
                  </label>
                );
              })}
            </fieldset>
          )}

          {blocked.length > 0 && (
            <section aria-labelledby={`${id}-blocked`}>
              <h4 id={`${id}-blocked`} className="ramp-facts__title">
                Not selectable now
              </h4>
              <ul className="ramp-rails__list">
                {blocked.map(({ card, offer }) => (
                  <li key={card.id} className="ramp-rail">
                    <RailBody card={card} idPrefix={`${id}-${card.id}`} />
                    {offer.availability.state === "setup_required" &&
                      offer.availability.requirement_codes.includes("maker_account_setup") && (
                        <AccountSetup
                          flow={flow}
                          rail={offer.rail.id}
                          name={card.name}
                          onDone={refresh}
                        />
                      )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="send-review__actions">
            {state.status === "done" && (
              <button type="button" className="send-secondary" onClick={refresh}>
                Check again
              </button>
            )}
            <button
              type="button"
              className="submit-btn send-cta"
              disabled={
                !chosen || overCap !== undefined || state.status !== "done" || flow.busy !== false
              }
              onClick={() => {
                if (chosen && state.status === "done")
                  void flow.estimate(chosen.offer, state.intent);
              }}
            >
              {flow.busy === "estimating" ? "Getting estimate..." : "Get estimate"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Own-account entry: the handle must belong to the user; copy says so. */
function PayeeFields({
  rail,
  value,
  owned,
  onValue,
  onOwned,
  error,
}: {
  rail: string;
  value: string;
  owned: boolean;
  onValue: (v: string) => void;
  onOwned: (v: boolean) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <>
      <label className="send-field">
        <span className="send-field__label">{`Your own ${rail} account`}</span>
        <input
          className="send-field__control send-field__control--mono"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onValue(e.target.value)}
        />
        <span id={`${id}-hint`} className="send-field__hint">
          This must be your own account. Paying out to someone else's account is not supported.
        </span>
        {error && <span className="send-field__error">{error}</span>}
      </label>
      <label className="send-check">
        <input type="checkbox" checked={owned} onChange={(e) => onOwned(e.target.checked)} />
        <span>{`This ${rail} account belongs to me.`}</span>
      </label>
    </>
  );
}

function AccountSetup({
  flow,
  rail,
  name,
  onDone,
}: {
  flow: Flow;
  rail: string;
  name: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [owned, setOwned] = useState(false);
  const error = value === "" ? undefined : payeeError(value);
  if (!open)
    return (
      <button type="button" className="send-secondary" onClick={() => setOpen(true)}>
        {`Set up your ${name} account`}
      </button>
    );
  return (
    <form
      className="send-form"
      aria-label={`Set up your ${name} account`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (payeeError(value) || !owned) return;
        void flow.setupAccount(rail, value).then((ok) => {
          if (!ok) return;
          setValue("");
          setOpen(false);
          onDone();
        });
      }}
    >
      <PayeeFields
        rail={name}
        value={value}
        owned={owned}
        onValue={setValue}
        onOwned={setOwned}
        error={error}
      />
      <button
        type="submit"
        className="submit-btn send-cta"
        disabled={!owned || payeeError(value) !== undefined || flow.busy !== false}
      >
        Register this account with Peer
      </button>
    </form>
  );
}

function ReviewStep({ flow, quote }: { flow: Flow; quote: OfframpQuote }) {
  const port = useOfframpPort();
  const { preview } = quote;
  const [now, setNow] = useState(() => port.now());
  const [payee, setPayee] = useState("");
  const [owned, setOwned] = useState(false);
  const [confirmedMask, setConfirmedMask] = useState<string | undefined>(quote.registeredPayee);
  const [accepted, setAccepted] = useState(false);
  const left = estimateSecondsLeft(preview, now);
  const stale = left === 0;
  const escrow = port.escrow();

  // Flip to stale exactly at expiry: one timer, no ticking.
  useEffect(() => {
    if (stale) return;
    const at = Date.parse(preview.expires_at);
    const timer = setTimeout(() => setNow(port.now()), Math.max(0, at - port.now()) + 1);
    return () => clearTimeout(timer);
  }, [port, preview, stale]);

  const fiat = preview.receive.asset;
  const fees = preview.fees.filter((f) => BigInt(f.money.atomic) > 0n);
  const error = payee === "" ? undefined : payeeError(payee);
  const ready = confirmedMask !== undefined && accepted && !stale && flow.busy === false;

  return (
    <section className="send-review" aria-label="Review cash-out">
      <dl className="send-review__facts">
        <div>
          <dt className="send-field__label">Platform</dt>
          <dd>{quote.railName}</dd>
        </div>
        <div>
          <dt className="send-field__label">Currency</dt>
          <dd>{quote.intent.fiat.currency}</dd>
        </div>
        <div>
          <dt className="send-field__label">You deposit</dt>
          <dd className="send-review__amount">{formatUsdc(preview.pay.atomic)}</dd>
        </div>
        <div>
          <dt className="send-field__label">Estimated payout</dt>
          <dd>
            {fiat.kind === "fiat"
              ? `${formatEstimate(preview.receive.atomic, fiat.currency, fiat.decimals)}, not a locked rate`
              : "Unknown"}
          </dd>
        </div>
        {fees.length > 0 && (
          <div>
            <dt className="send-field__label">Fees in the estimate</dt>
            <dd>{fees.map((f) => `${formatUsdc(f.money.atomic)} (${f.code})`).join(", ")}</dd>
          </div>
        )}
        <div>
          <dt className="send-field__label">Estimate</dt>
          <dd role="status">
            {stale
              ? "Expired. It can no longer be used; get a new estimate."
              : `Usable until ${formatRampTime(preview.expires_at)}. Fills can be partial and have no set time.`}
          </dd>
        </div>
        <div>
          <dt className="send-field__label">Payout account</dt>
          <dd className="send-review__mono">{confirmedMask ?? "Not entered yet"}</dd>
        </div>
        <div>
          <dt className="send-field__label">Public Base transaction</dt>
          <dd>
            {`A deposit of ${formatUsdc(preview.pay.atomic)} from your wallet into Peer's escrow`}
            {escrow && (
              <>
                {" "}
                <code className="send-review__mono">{escrow}</code>
              </>
            )}
            {
              " on Base. The amount and your wallet address are public. Your wallet may first ask to let the escrow use exactly this USDC."
            }
          </dd>
        </div>
      </dl>

      {confirmedMask === undefined ? (
        <form
          className="send-form"
          aria-label="Payout account"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (payeeError(payee) || !owned) return;
            setConfirmedMask(maskPayee(payee));
          }}
        >
          <PayeeFields
            rail={quote.railName}
            value={payee}
            owned={owned}
            onValue={setPayee}
            onOwned={setOwned}
            error={error}
          />
          <button
            type="submit"
            className="send-secondary"
            disabled={!owned || payeeError(payee) !== undefined}
          >
            Use this account
          </button>
        </form>
      ) : (
        !quote.registeredPayee && (
          <button
            type="button"
            className="send-secondary"
            disabled={flow.busy !== false}
            onClick={() => setConfirmedMask(undefined)}
          >
            Change account
          </button>
        )
      )}

      <label className="send-check">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>
          I understand the payout is an estimate, not a locked rate; fills can be partial and arrive
          at no set time; the buyer sees my payment details; and the deposit is public on Base.
        </span>
      </label>

      <div className="send-review__actions">
        <button
          type="button"
          className="send-secondary"
          disabled={flow.busy !== false}
          onClick={flow.edit}
        >
          {stale ? "Get a new estimate" : "Back"}
        </button>
        <button
          type="button"
          className="submit-btn send-cta"
          disabled={!ready}
          onClick={() => {
            void flow.confirm(quote.registeredPayee ? undefined : payee).then(() => setPayee(""));
          }}
        >
          {flow.busy === "confirming" ? "Confirming..." : "Confirm cash-out"}
        </button>
      </div>
    </section>
  );
}

function OrderStep({ flow, order }: { flow: Flow; order: OfframpOrder }) {
  const port = useOfframpPort();
  const { chainId } = useAccount();
  const [hash, setHash] = useState("");
  const [withdrawText, setWithdrawText] = useState("");
  const headline = orderHeadline(order.snapshot, order.phase, order.reason);
  const steps = progressSteps(order.phase);
  const leg = order.snapshot.peer;
  // Re-read on every render: the port's chain is the wallet's, not React state.
  void chainId;
  const onBase = port.wallet.chainId() === BASE_CHAIN_ID;
  const walletDue = leg.state === "action_required";
  const needsHash = leg.state === "in_doubt" && order.pendingAction !== undefined;
  const withdrawable = canWithdraw(order.snapshot, order.phase);
  const withdrawAmount = parseRampAmount(withdrawText);
  const finished =
    order.snapshot.terminal || (order.stage === "before_deposit" && leg.state === "failed");

  return (
    <section className="send-review" aria-label="Cash-out order">
      <p className="ramp-rail__name">{`${order.railName} · ${order.currency} · ${formatUsdc(order.amount)}`}</p>
      {order.payeeMask && (
        <p className="send-note">{`Payout account ${order.payeeMask} (your own).`}</p>
      )}
      <div className={`ramp-order__headline ramp-order__headline--${headline.tone}`} role="status">
        <strong>{headline.title}</strong>
        <span>{headline.detail}</span>
      </div>

      {order.amounts && (
        <dl className="send-review__facts" aria-label="Confirmed order totals">
          {Object.entries(order.amounts).map(([label, amount]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatUsdc(amount)}</dd>
            </div>
          ))}
        </dl>
      )}
      {order.stage === "deposit" && order.phase !== "returned" && (
        <ol className="ramp-order__steps" aria-label="Order progress">
          {steps.map((s) => (
            <li
              key={s.id}
              className={`ramp-order__step ramp-order__step--${s.state}`}
              aria-current={s.state === "current" ? "step" : undefined}
            >
              {`${s.label}${s.state === "done" ? " (done)" : s.state === "current" ? " (now)" : ""}`}
            </li>
          ))}
        </ol>
      )}

      {walletDue && (
        <div className="send-form">
          <p className="send-note">
            {order.nextAction
              ? `Next wallet step: ${WALLET_ACTION_LABELS[order.nextAction]}.`
              : "Your wallet asks for each step separately: first, only if needed, to let Peer's escrow use exactly this USDC; then to create the deposit."}
          </p>
          {!onBase ? (
            <button
              type="button"
              className="submit-btn send-cta"
              disabled={flow.busy !== false}
              onClick={() => void flow.switchNetwork()}
            >
              {flow.busy === "switching" ? "Switching..." : "Switch wallet to Base"}
            </button>
          ) : (
            <button
              type="button"
              className="submit-btn send-cta"
              disabled={flow.busy !== false}
              onClick={() => void flow.walletStep()}
            >
              {flow.busy === "wallet" ? "Waiting for wallet..." : "Approve in wallet"}
            </button>
          )}
        </div>
      )}

      {needsHash && (
        <form
          className="send-form"
          aria-label="Attach transaction"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void flow.attachHash(hash);
          }}
        >
          <label className="send-field">
            <span className="send-field__label">Transaction hash from your wallet</span>
            <input
              className="send-field__control send-field__control--mono"
              autoComplete="off"
              spellCheck={false}
              value={hash}
              onChange={(e) => setHash(e.target.value)}
            />
            <span className="send-field__hint">
              {`For "${WALLET_ACTION_LABELS[order.pendingAction!]}". Only that one transaction is reconciled; nothing is sent again.`}
            </span>
          </label>
          <button type="submit" className="send-secondary" disabled={flow.busy !== false}>
            Attach and check
          </button>
        </form>
      )}

      {withdrawable && (
        <form
          className="send-form"
          aria-label="Withdraw unmatched USDC"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (withdrawAmount) void flow.prepareWithdrawal(withdrawAmount);
          }}
        >
          <label className="send-field">
            <span className="send-field__label">USDC to withdraw</span>
            <input
              className="send-field__control"
              inputMode="decimal"
              autoComplete="off"
              placeholder={order.phase === "awaiting_buyer" ? "All of it" : "0.00"}
              value={withdrawText}
              onChange={(e) => setWithdrawText(e.target.value)}
            />
            <span className="send-field__hint">
              Only USDC no buyer has reserved can come back. A buyer mid-payment keeps their part.
            </span>
          </label>
          <button
            type="submit"
            className="send-secondary"
            disabled={!withdrawAmount || flow.busy !== false}
          >
            {flow.busy === "withdrawing" ? "Preparing..." : "Prepare withdrawal"}
          </button>
          {order.phase === "awaiting_buyer" && withdrawText === "" && (
            <button
              type="button"
              className="send-secondary"
              disabled={flow.busy !== false}
              onClick={() => setWithdrawText(usdcDecimal(order.amount))}
            >
              Withdraw all of it
            </button>
          )}
        </form>
      )}

      <div className="send-review__actions">
        {!finished && (
          <button
            type="button"
            className="send-secondary"
            disabled={flow.busy !== false}
            onClick={() => void flow.check()}
          >
            {flow.busy === "checking" ? "Checking..." : "Check status"}
          </button>
        )}
        {finished && (
          <button type="button" className="send-secondary" onClick={flow.startOver}>
            Start a new cash-out
          </button>
        )}
      </div>
      <p className="send-note">It also appears in Activity.</p>
    </section>
  );
}

function RailBody({
  card,
  idPrefix,
  estimate,
}: {
  card: RailCard;
  idPrefix: string;
  estimate?: string;
}) {
  return (
    <span className="ramp-rail__body">
      <span className="ramp-rail__head">
        <span id={`${idPrefix}-name`} className="ramp-rail__name">
          {card.name}
        </span>
        <span className={`ramp-rail__status ramp-rail__status--${card.state}`}>{card.status}</span>
      </span>
      <span id={`${idPrefix}-detail`} className="ramp-rail__text">
        {card.reason}
        {estimate && ` ${estimate}`}
      </span>
      {card.retryAfter && (
        <span className="ramp-rail__text">{`Retry after ${formatRampTime(card.retryAfter)}.`}</span>
      )}
      {card.next && <span className="ramp-rail__text">{`Next: ${card.next}`}</span>}
      {card.selectable && card.needs.length > 0 && (
        <span className="ramp-rail__text">{`Needs: ${card.needs.join("; ")}.`}</span>
      )}
    </span>
  );
}

function OverallCard(card: Omit<RailCard, "id" | "name" | "needs">) {
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
        {card.next && <span className="ramp-rail__text">{`Next: ${card.next}`}</span>}
      </span>
    </div>
  );
}
