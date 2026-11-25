/**
 * PaymentAppSend
 *
 * Trade/Cash out: cash Base USDC out to the user's own payment-app account
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

import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useAccount, useConfig } from "wagmi";
import { skipToken, useQuery } from "@tanstack/react-query";
import { formatTokenAmount } from "../../utils/format.js";
import { TIMEOUTS } from "../../config.js";
import { RampDisclosure, RampFacts } from "../availability/RampDisclosure.js";
import {
  RailChoice,
  RailTileContent,
  RailTiles,
  UnavailableRails,
} from "../availability/RailTiles.js";
import { OverallCard } from "../availability/RampRails.js";
import { getExplorerTxUrl, type RampOffer } from "@xochi/client";
import {
  formatRampTime,
  overallCard,
  parseRampAmount,
  railCard,
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
  onConnectRequest?: () => void;
}

function useOfframpPort() {
  const injected = useContext(OfframpPortContext);
  const config = useConfig();
  return useMemo(() => injected ?? createLiveOfframpPort(config), [injected, config]);
}

export function PaymentAppSend({
  active,
  fiatCurrency = "USD",
  onConnectRequest,
}: PaymentAppSendProps) {
  const port = useOfframpPort();
  const { address } = useAccount();
  return (
    <WalletPaymentAppSend
      key={address}
      address={address}
      port={port}
      active={active}
      fiatCurrency={fiatCurrency}
      onConnectRequest={onConnectRequest}
    />
  );
}

function WalletPaymentAppSend({
  active,
  fiatCurrency = "USD",
  address,
  onConnectRequest,
  port,
}: PaymentAppSendProps & {
  address?: string;
  port: ReturnType<typeof useOfframpPort>;
}) {
  const checkpoint = address ? inspectOfframpPrerequisite(address) : undefined;
  const [route, setRoute] = useState<OfframpPrerequisite>();
  const [routeAmount, setRouteAmount] = useState<string>();
  const funding = useMemo(
    () =>
      route ? (amount: string) => route.funded(amount) : checkpoint ? async () => false : undefined,
    [route, !!checkpoint],
  );
  const flow = useOfframp(port, address, active, funding);
  const [reviewDraft, setReviewDraft] = useState<ReviewDraft>();
  useEffect(() => {
    if (flow.view.kind === "order") setReviewDraft(undefined);
  }, [flow.view.kind]);
  const [editAmount, setEditAmount] = useState("");
  const [editCurrency, setEditCurrency] = useState(fiatCurrency);

  return (
    <section className="ramp-rails" aria-label="Cash out">
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
          amountText={editAmount}
          setAmountText={setEditAmount}
          currency={editCurrency}
          setCurrency={setEditCurrency}
          onConnectRequest={onConnectRequest}
          routeAmount={routeAmount}
          onReceipt={setRoute}
          onReady={(next, amount) => {
            setRoute(next);
            setRouteAmount(amount);
          }}
        />
      )}
      {flow.view.kind === "review" && (
        <ReviewStep
          flow={flow}
          quote={flow.view.quote}
          draft={
            reviewDraft?.rail === flow.view.quote.offer.rail.id
              ? reviewDraft
              : { rail: flow.view.quote.offer.rail.id, payee: "", owned: false, accepted: false }
          }
          setDraft={setReviewDraft}
        />
      )}
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
  onConnectRequest,
  amountText,
  setAmountText,
  currency,
  setCurrency,
  onReady,
  onReceipt,
}: {
  flow: Flow;
  account: string | undefined;
  active: boolean;
  fiatCurrency: string;
  routeAmount?: string;
  onConnectRequest?: () => void;
  amountText: string;
  setAmountText: (value: string) => void;
  currency: string;
  setCurrency: (value: string) => void;
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
  const spendable = port.spendable;
  const balanceEnabled =
    active && source === "base_usdc" && !!account && !!settlement && !!spendable;
  const balanceRead = useQuery({
    queryKey: ["cash-out-balance", settlement?.asset_id, account, routeAmount],
    queryFn: account && spendable ? () => spendable(account) : skipToken,
    enabled: balanceEnabled,
    staleTime: TIMEOUTS.balanceRefresh,
    refetchInterval: TIMEOUTS.balanceRefresh / 2,
    retry: false,
  });
  // A failed refresh invalidates the query, but the last verified read has its own deadline.
  const [, expireBalance] = useState(0);
  useEffect(() => {
    if (!balanceEnabled || !balanceRead.isRefetchError) return;
    const remaining = balanceRead.dataUpdatedAt + TIMEOUTS.balanceRefresh - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => expireBalance(balanceRead.dataUpdatedAt), remaining);
    return () => clearTimeout(timer);
  }, [balanceEnabled, balanceRead.isRefetchError, balanceRead.dataUpdatedAt]);
  const recentBalance = balanceRead.isRefetchError
    ? Date.now() - balanceRead.dataUpdatedAt < TIMEOUTS.balanceRefresh
    : balanceRead.isSuccess && !balanceRead.isStale;
  const balance = balanceEnabled && recentBalance ? (balanceRead.data ?? null) : null;
  const checkingBalance = balanceEnabled && balanceRead.isPending;
  const cap = port.canaryCap();
  const max =
    balance !== null && cap !== undefined && balance > BigInt(cap) ? BigInt(cap) : balance;
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    if (routeAmount) {
      setSource("base_usdc");
      setAmountText(usdcDecimal(routeAmount));
    }
  }, [routeAmount, setAmountText]);
  const amount = parseRampAmount(amountText);
  const amountInvalid = amountText.trim() !== "" && amount === undefined;
  // Enforced before any rail read or review: an over-cap amount is never estimated.
  const overCap = canaryCapError(amount, port.canaryCap());
  const balanceNote =
    amount !== undefined && balance !== null && BigInt(amount) > balance
      ? balance === 0n
        ? "Your wallet has 0 USDC on Base. Receive USDC on Base to cash out."
        : `Your wallet has ${formatUsdc(balance.toString())} on Base. You entered ${formatUsdc(amount)}. Try a smaller amount, or receive more USDC on Base.`
      : undefined;
  const canCheck = !overCap && !balanceNote && !checkingBalance;
  const amountInput = useRef<HTMLInputElement>(null);
  const focusAfterBalanceRetry = useRef(false);
  useLayoutEffect(() => {
    if (balanceNote || !focusAfterBalanceRetry.current) return;
    focusAfterBalanceRetry.current = false;
    if (document.activeElement === document.body) amountInput.current?.focus();
  }, [balanceNote]);
  const { state, now, refresh } = useOfframpRails({
    port,
    runtime: flow.runtime,
    settlement,
    account,
    amount: canCheck ? amount : undefined,
    currency,
    enabled: active && source === "base_usdc",
  });

  const checked =
    state.status === "done" &&
    canCheck &&
    state.intent.exact.money.atomic === amount &&
    state.intent.fiat.currency === currency &&
    state.intent.recipient === account;
  const cards: { card: RailCard; offer: RampOffer }[] =
    checked && settlement
      ? state.offers.map((offer) => ({
          offer,
          card: railCard(offer, state.intent, settlement, now),
        }))
      : [];
  const selectable = cards.filter((c) => c.card.selectable);
  const blocked = cards.filter((c) => !c.card.selectable);
  const chosen = selectable.find((c) => c.card.id === selected);
  const currentEstimate = useRef<RampOffer | undefined>(undefined);
  useLayoutEffect(() => {
    currentEstimate.current = active && source === "base_usdc" ? chosen?.offer : undefined;
    return () => {
      currentEstimate.current = undefined;
    };
  }, [active, source, chosen?.offer]);
  const lost = selected !== undefined && chosen === undefined && checked;
  const currencies = [...new Set([fiatCurrency, "USD"])];
  const estimateFor = (offer: RampOffer) =>
    state.status === "done" ? state.estimates.find((e) => e.offerId === offer.offer_id) : undefined;

  let status: string | undefined;
  if (!account)
    status = onConnectRequest
      ? undefined
      : "Connect a wallet and enter an amount to check availability.";
  else if (!settlement)
    status = "Peer’s Base USDC configuration is unavailable. Check again later.";
  else if (overCap) status = overCap;
  else if (balanceNote)
    status = balanceRead.isRefetchError
      ? `Could not refresh your balance. Last verified on Base: ${formatUsdc(balance!.toString())}.`
      : balanceNote;
  else if (lost) status = "That app is unavailable. Choose again.";
  else if (flow.runtimeFailed)
    status = "Cash out is unavailable for this wallet. Reconnect your wallet and check again.";
  else if (account && amount === undefined && !amountInvalid)
    status = "Enter an amount to check payment apps.";
  else if (amount !== undefined && checkingBalance)
    status = balanceRead.isPaused
      ? "Reconnect to check your USDC balance on Base."
      : "Checking your USDC balance on Base…";
  else if (state.status === "loading") status = "Checking payment apps…";

  const sourcePicker = (
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
  );
  return (
    <>
      {source === "other" ? (
        <>
          {sourcePicker}
          <OfframpRoute
            port={port}
            onReceipt={onReceipt}
            onReady={onReady}
            onLock={() => setRouteLocked(true)}
          />
        </>
      ) : (
        <>
          <div className="send-form__row ramp-amount-row">
            <label className="send-field">
              <span className="send-field__label">USDC to cash out</span>
              <input
                ref={amountInput}
                className="send-field__control"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amountText}
                aria-invalid={amountInvalid || (!!balanceNote && !overCap)}
                aria-describedby={
                  amountInvalid
                    ? `${id}-amount-error`
                    : balanceNote && !overCap
                      ? `${id}-cash-out-status`
                      : undefined
                }
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
            {account && (
              <button
                type="button"
                className="send-secondary"
                disabled={!max}
                onClick={() => {
                  if (!max) return;
                  setAmountText(usdcDecimal(max.toString()));
                  setSelected(undefined);
                }}
              >
                Max
              </button>
            )}
            {currencies.length > 1 && (
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
            )}
          </div>
          {sourcePicker}
          <RampDisclosure direction="offramp" />

          {status && (
            <p className="send-note" id={`${id}-cash-out-status`} role="status">
              {status}
            </p>
          )}
          {balanceNote && !overCap && (
            <button
              type="button"
              className="send-secondary"
              aria-disabled={balanceRead.isFetching || balanceRead.isPaused}
              onClick={(event) => {
                if (balanceRead.isFetching || balanceRead.isPaused) return;
                focusAfterBalanceRetry.current = document.activeElement === event.currentTarget;
                void balanceRead.refetch();
              }}
            >
              Check balance again
            </button>
          )}

          {checked && cards.length === 0 && (
            <OverallCard {...overallCard(state.availability, "offramp")} />
          )}

          <RailTiles title="Your account" guest={!account} untested={!checked}>
            {selectable.map(({ card, offer }) => {
              const est = estimateFor(offer);
              return (
                <RailChoice
                  key={card.id}
                  card={card}
                  name={card.name}
                  group={`${id}-rail`}
                  selected={chosen?.card.id === card.id}
                  status={
                    est && est.receive.asset.kind === "fiat"
                      ? formatEstimate(
                          est.receive.atomic,
                          est.receive.asset.currency,
                          est.receive.asset.decimals,
                        )
                      : undefined
                  }
                  onSelect={() => setSelected(card.id)}
                />
              );
            })}
            {blocked
              .filter(
                ({ offer }) =>
                  offer.availability.state === "setup_required" &&
                  offer.availability.requirement_codes.includes("maker_account_setup"),
              )
              .map(({ card, offer }) => (
                <AccountSetup
                  key={card.id}
                  flow={flow}
                  rail={offer.rail.id}
                  name={card.name}
                  requirements={card.needs}
                  reason={card.reason}
                  onDone={refresh}
                />
              ))}
          </RailTiles>
          <UnavailableRails
            cards={blocked
              .filter(
                ({ offer }) =>
                  offer.availability.state !== "setup_required" ||
                  !offer.availability.requirement_codes.includes("maker_account_setup"),
              )
              .map(({ card }) => card)}
          />

          {checked && (
            <button type="button" className="send-secondary" onClick={refresh}>
              Check again
            </button>
          )}
          <div className="ramp-bottom-action">
            {!account && onConnectRequest ? (
              <button type="button" className="submit-btn send-cta" onClick={onConnectRequest}>
                Connect wallet
              </button>
            ) : (
              <button
                type="button"
                className="submit-btn send-cta"
                disabled={
                  !chosen || overCap !== undefined || state.status !== "done" || flow.busy !== false
                }
                onClick={() => {
                  if (chosen && state.status === "done")
                    void flow.estimate(
                      chosen.offer,
                      state.intent,
                      () => currentEstimate.current === chosen.offer,
                    );
                }}
              >
                {flow.busy === "estimating" ? "Getting estimate..." : "Get estimate"}
              </button>
            )}
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
          {(
            {
              Venmo: "Enter your @username.",
              Wise: "Enter your account email.",
              Revolut: "Enter your Revolut tag.",
            } as Record<string, string>
          )[rail] ?? "Enter the identifier for your account."}
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
  requirements,
  reason,
  onDone,
}: {
  flow: Flow;
  rail: string;
  name: string;
  requirements: string[];
  reason: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [owned, setOwned] = useState(false);
  const error = value === "" ? undefined : payeeError(value);
  if (!open)
    return (
      <button type="button" className="ramp-tile" onClick={() => setOpen(true)}>
        <RailTileContent id={rail} name={name} status="Set up first" />
      </button>
    );
  return (
    <form
      className="send-form ramp-tile-setup"
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
      <p className="send-note">{reason}</p>
      {requirements.length > 0 && <p className="send-note">{requirements.join(". ")}.</p>}
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

interface ReviewDraft {
  rail: string;
  payee: string;
  owned: boolean;
  accepted: boolean;
}

function ReviewStep({
  flow,
  quote,
  draft,
  setDraft,
}: {
  flow: Flow;
  quote: OfframpQuote;
  draft: ReviewDraft;
  setDraft: (draft: ReviewDraft) => void;
}) {
  const consentId = useId();
  const port = useOfframpPort();
  const { preview } = quote;
  const [now, setNow] = useState(() => port.now());
  const { payee, owned, accepted } = draft;
  const setPayee = (value: string) => setDraft({ ...draft, payee: value });
  const setOwned = (value: boolean) => setDraft({ ...draft, owned: value });
  const [confirmedMask, setConfirmedMask] = useState<string | undefined>(
    () =>
      quote.registeredPayee ??
      (draft.owned && !payeeError(draft.payee) ? maskPayee(draft.payee) : undefined),
  );
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
          <dt className="send-field__label">You deposit</dt>
          <dd className="send-review__amount">{formatUsdc(preview.pay.atomic)}</dd>
        </div>
        <div>
          <dt className="send-field__label">Estimated payout</dt>
          <dd>
            {fiat.kind === "fiat"
              ? formatEstimate(preview.receive.atomic, fiat.currency, fiat.decimals)
              : "Unknown"}
          </dd>
        </div>
        {fees.length > 0 && (
          <div>
            <dt className="send-field__label">Fees in the estimate</dt>
            <dd>
              {fees
                .map(
                  (f) =>
                    `${formatUsdc(f.money.atomic)} (${f.code === "peer_fee" ? "Peer fee" : f.code === "maker_fee" ? "Payment rate fee" : "Fee"})`,
                )
                .join(", ")}
            </dd>
          </div>
        )}
        <div>
          <dt className="send-field__label">Estimate</dt>
          <dd role="status">
            {stale
              ? "Expired. Get a new estimate."
              : `Valid until ${formatRampTime(preview.expires_at)}`}
          </dd>
        </div>
        <div>
          <dt className="send-field__label">Payout account</dt>
          <dd className="send-review__mono">{confirmedMask ?? "Not entered yet"}</dd>
        </div>
        <div>
          <dt className="send-field__label">Deposit destination</dt>
          <dd>Peer’s holding contract on Base</dd>
        </div>
        {escrow && (
          <div>
            <dt>Holding contract address</dt>
            <dd>
              <code className="send-review__mono">{escrow}</code>
              <button
                type="button"
                className="send-secondary"
                onClick={() => void navigator.clipboard?.writeText(escrow).catch(() => {})}
              >
                Copy
              </button>
            </dd>
          </div>
        )}
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

      <RampFacts direction="offramp" id={consentId} />
      <label className="send-check">
        <input
          type="checkbox"
          checked={accepted}
          aria-describedby={consentId}
          onChange={(e) => setDraft({ ...draft, accepted: e.target.checked })}
        />
        <span>I accept the cash-out terms.</span>
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
            void flow.confirm(quote.registeredPayee ? undefined : payee);
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
  const [withdrawText, setWithdrawText] = useState<string>();
  const transaction = order.depositTransaction;
  const baseReceipt = transaction ? getExplorerTxUrl(BASE_CHAIN_ID, transaction) : undefined;
  const payout = order.estimatedPayout;
  const delivered = order.amounts?.deliveredFiat;
  const receivedPayment =
    order.phase === "delivering" ||
    order.phase === "delivered" ||
    (order.amounts !== undefined && BigInt(order.amounts.filled) > 0n) ||
    order.snapshot.peer.partial_result !== undefined;
  const headline = orderHeadline(order.snapshot, order.phase, order.reason);
  const steps = progressSteps(order.phase);
  const leg = order.snapshot.peer;
  // Re-read on every render: the port's chain is the wallet's, not React state.
  void chainId;
  const onBase = port.wallet.chainId() === BASE_CHAIN_ID;
  const walletDue = leg.state === "action_required";
  const needsHash = leg.state === "in_doubt" && order.pendingAction !== undefined;
  const withdrawable = canWithdraw(order.snapshot, order.phase);
  const withdrawValue =
    withdrawText ?? (order.amounts ? usdcDecimal(order.amounts.withdrawable) : "");
  const withdrawAmount = parseRampAmount(withdrawValue);
  const finished =
    order.snapshot.terminal || (order.stage === "before_deposit" && leg.state === "failed");

  return (
    <section className="send-review" aria-label="Cash-out order">
      <h3 className="ramp-rail__name">{`${formatUsdc(order.amount)} to your ${order.railName} account`}</h3>
      {payout?.asset.kind === "fiat" && (
        <p className="send-note">
          Original estimate:{" "}
          {formatEstimate(payout.atomic, payout.asset.currency, payout.asset.decimals)}
        </p>
      )}
      {order.payeeMask && !receivedPayment && (
        <p className="send-note">{`Payout account ${order.payeeMask} (your own).`}</p>
      )}
      <div className={`ramp-order__headline ramp-order__headline--${headline.tone}`} role="status">
        <strong>{headline.title}</strong>
        <span>{headline.detail}</span>
      </div>

      {receivedPayment && (
        <section className="send-review ramp-receipt" aria-label="Payment receipt">
          <h4>Payment receipt</h4>
          {delivered?.asset.kind === "fiat" && (
            <p>
              Fiat delivered:{" "}
              {formatTokenAmount(
                BigInt(delivered.atomic),
                delivered.asset.decimals,
                delivered.asset.decimals,
              )}{" "}
              {delivered.asset.currency}
            </p>
          )}
          <p>Check your {order.railName} for the payment.</p>
          {order.payeeMask && <p className="send-review__mono">{order.payeeMask}</p>}
          {baseReceipt && (
            <a href={baseReceipt} target="_blank" rel="noopener noreferrer">
              View Base transaction
            </a>
          )}
        </section>
      )}
      {order.amounts && (
        <dl className="send-review__facts" aria-label="Confirmed order totals">
          {[
            ["Deposited", order.amounts.deposited],
            ["Paid out (USDC debited)", order.amounts.filled],
            ["Reserved by buyers", order.amounts.reserved],
            ["Available to withdraw", order.amounts.withdrawable],
            ["Returned to wallet", order.amounts.withdrawn],
          ].map(([label, amount]) => (
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
              value={withdrawValue}
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
