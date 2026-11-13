/**
 * Trade Page Configuration
 *
 * Token metadata comes from the public @xochi/client vocabulary.
 * Balances are read live on-chain via usePublicBalances.
 */

import type { ChainId, Token } from "../../types/intent.js";
import {
  CANTON_COIN,
  CANTON_MAINNET_CHAIN_ID,
  DEFAULT_SLIPPAGE_BPS,
  TOKENS as CLIENT_TOKENS,
  TRON_CHAIN_ID,
  TRON_TOKENS_BY_ADDRESS,
  isCantonDestinationChainId,
  type SelectableChainId,
  type TokenInfo,
} from "@xochi/client";
import { ARC_BROWSER_ENABLED as ARC_LIVE } from "../../config.js";

// The configurator preview imports it from here.
export { DEFAULT_SLIPPAGE_BPS };

/**
 * Stealth settlement (send side). Gates the Stealth toggle so the UI only
 * offers a settlement path the solver can honor end to end. Stealth (ERC-5564)
 * has no trust-score gate; the flag reflects whether the send + receive path is
 * shipped. While false, the trade UI presents stealth as coming soon (disabled
 * toggle, hidden receive panel). Live: the prod worker enables the settle + claim handlers
 * (STEALTH_SETTLEMENT_LIVE=true), the gas floor prices the sponsored 4337 claim
 * leg (Riddler #560 / xochi#216), and the two-step client-signed claim shipped.
 */
export const STEALTH_SETTLEMENT_LIVE: boolean = true;

/**
 * Stealth RECEIVE side (scan + claim). Distinct from STEALTH_SETTLEMENT_LIVE
 * (the send side): scanning reads the worker's ERC-5564 announcement index,
 * which Riddler populates once it settles to a real counterfactual and emits the
 * announcement. The rebuild has landed -- the scanner matches the counterfactual
 * SimpleAccount (not the stealth EOA, #188/#170), and the two-step client-signed
 * claim (prepare/submit) is wired end to end -- so the scan/claim UI is live.
 */
export const STEALTH_CLAIM_LIVE: boolean = true;

/**
 * Aztec L2 shielded settlement (send side). Per the accepted design
 * (shielded-execution.md D1) the payout lands in a recipient-private Aztec
 * account while the amount and token stay public, so no copy may claim it hides
 * the amount. Gated on the pxe-bridge security review; do not name that review
 * in any user-facing copy.
 *
 * The third privacy button is a shortcut to zk.money, not this direct
 * settlement path. Its Ethereum DAI deposit stays Public. Direct Aztec
 * settlement remains gated and tracked by xochi-widget#142.
 *
 * The SELECTION path is written and unit-tested with `live: true` inputs
 * (served-availability gating, the wallet nudge, the served refusal reason in
 * the title, the retry-prefill restore), so that much cannot rot before the
 * flip. The SETTLEMENT path is not, and this flag does not make it appear.
 * Flipping it alone would let a user pick Shielded and then read a confirm
 * modal that says the payout arrives in Public, because there is no
 * SHIELDED_DESTINATION: `destination` resolves to DEFAULT_DESTINATION for
 * anything that is not stealth (useSwapPanel), TransactionPreview labels a
 * `chain` destination "Public", and the local activity capture then records
 * the order as public, which also defeats the shielded retry-prefill. Step 3
 * below is real work, not a copy pass.
 *
 * FLIP CHECKLIST (server first, always: the UI must never advertise ahead of the
 * solver):
 *   1. Set SHIELDED_SETTLEMENT_LIVE = "true" in workers/api/wrangler.toml for the
 *      target env, deploy, and confirm a quote serves shielded available:true for
 *      a score >= 50 wallet and the Verified-tier reason below it.
 *   2. Flip this const only alongside a direct-settlement UI; the current
 *      "Shielded" shortcut must keep routing to zk.money.
 *   3. Wire the destination so the signed order and the screen agree: add a
 *      SHIELDED_DESTINATION, resolve it in useSwapPanel's `destination`, give
 *      TransactionPreview an honest label and a claim line that is not the
 *      ERC-4337 stealth wording, and widen the activity capture past
 *      `type === "stealth" ? "stealth" : "public"`.
 *   4. Flip SHIELDED_ACCOUNTS_LIVE and give the PrivacyPanel row a live state.
 *      Today the row only renders while the flag is false, so flipping removes
 *      it rather than replacing it.
 *   5. Copy pass: the caption steady-state line here, plus the surfaces that read
 *      "planned, not yet live" (UBIQUITOUS_LANGUAGE.md, whitepaper, appendix,
 *      one-pager, llms.txt, agents.json, the settlementType .describe()).
 *   6. Regenerate the OpenAPI spec (npm run openapi:check).
 *
 * The `: boolean` annotation is load-bearing. Without it TS narrows to the literal
 * `false` and marks every live branch unreachable.
 */
export const SHIELDED_SETTLEMENT_LIVE: boolean = false;

/**
 * Shielded RECEIVE side (shielded accounts). Distinct from
 * SHIELDED_SETTLEMENT_LIVE the way STEALTH_CLAIM_LIVE is distinct from
 * STEALTH_SETTLEMENT_LIVE: sending to a shielded note and holding or viewing a
 * shielded balance are separate paths that can ship apart. While false the
 * PrivacyPanel shows an inert "Shielded" status row with an Unavailable chip.
 */
export const SHIELDED_ACCOUNTS_LIVE: boolean = false;

/**
 * Tron as a cross-chain destination (EVM origin -> TRC-20 payout).
 *
 * Live: the solver quotes the corridor, and the whole path is wired. The
 * recipient-address input renders for any non-EVM destination (SwapPanel), the
 * schema accepts a Tron `to_chain_id`/`to_token`/`recipient_address`
 * (`destinationChainId`, `destinationTokenAddress`, `recipientAddress`), the
 * quote persists the recipient and binds it into the served EIP-712, and execute
 * checks that binding verbatim (base58 is case-sensitive, so `recipient` and
 * both token legs compare exactly -- see tron-destination.test.ts).
 *
 * The selector additionally narrows to `capabilities.chains`, so Tron only
 * renders while the solver still advertises it; this flag does not override that.
 *
 * Note on economics: this corridor carries a fixed per-transfer network cost
 * well above the $1 global floor, so the solver returns a per-route
 * `min_fillable_usd` and the decline copy folds it in. Do not restate the figure
 * here: it is live-priced solver-side and moving (axol-io/Riddler#841 takes the
 * energy price off a stale constant, #843 makes it per-token, which together cut
 * a USDC payout by roughly 7x). Read the served `min_fillable_usd`, never a
 * number written in this file.
 *
 * The origin direction is live and independently narrowed by typed routes.
 */
export const TRON_DESTINATION_LIVE: boolean = true;

/**
 * Tron as a cross-chain origin (deposit route). The connected wallet remains
 * EVM; the origin token, deposit address, and refund address are base58. Exact
 * typed routes and deposit-attestation verification remain mandatory.
 */
export const TRON_ORIGIN_LIVE: boolean = true;

/**
 * Arc origin needs a browser-safe RPC for wallet operations. Arc destination
 * needs no browser RPC and is offered when an exact typed route advertises it.
 */
export { ARC_LIVE };

/** Gnosis is live, still narrowed by the exact typed capability routes. */
export const GNOSIS_LIVE: boolean = true;

/**
 * Canton as a cross-chain destination: Base USDC -> Canton Coin, delivered to
 * a Canton party the user types (xochi-sdk#116). Destination-only and public
 * only; settled through the Base `RiddlerEscrow` (the deploy's `escrows` pin,
 * `configureWidget`): the solver delivers, Riddler attests, the solver claims,
 * or the taker refunds from `refundableAt` on.
 *
 * Off until the Worker forwards escrow quotes and status (`escrow`,
 * `cantonUpdateId`), Riddler serves the corridor (axol-io/riddler#1469), and a
 * staging run has reached a terminal status. Even on, Canton is offered only
 * while the live capability matrix advertises it (`cvm`) with an exact route.
 * Off, Canton is selectable nowhere: selectors, embed parameters, resume and
 * local activity all refuse it, and no escrow pin reaches the machine.
 */
export const CANTON_DESTINATION_LIVE: boolean = false;

/**
 * Client launch gates remain necessary after a solver advertises a chain.
 * `cantonLive` is `CANTON_DESTINATION_LIVE`; tests pass it to exercise both.
 */
export function chainEnabledForRole(
  chainId: number,
  role: "origin" | "destination",
  cantonLive: boolean = CANTON_DESTINATION_LIVE,
): boolean {
  if (chainId === TRON_CHAIN_ID) {
    return role === "origin" ? TRON_ORIGIN_LIVE : TRON_DESTINATION_LIVE;
  }
  if (isCantonDestinationChainId(chainId)) return role === "destination" && cantonLive;
  if (chainId === 5042) return role === "destination" || ARC_LIVE;
  if (chainId === 100) return GNOSIS_LIVE;
  return true;
}

// ============================================================
// Token Configuration by Chain (with chainId for frontend)
// ============================================================

/** Extend public token metadata with the frontend chain id. */
function toFrontendToken(token: TokenInfo, chainId: SelectableChainId): Token {
  return { ...token, chainId };
}

/**
 * Tron metadata stays keyed by its verbatim base58 address because those
 * addresses are case-sensitive.
 */
const TRON_TOKENS: Token[] = [];
for (const token of Object.values(TRON_TOKENS_BY_ADDRESS)) {
  if (token !== undefined) TRON_TOKENS.push(toFrontendToken(token, TRON_CHAIN_ID));
}

export const TOKENS: Record<SelectableChainId, Token[]> = {
  1: CLIENT_TOKENS[1].map((token) => toFrontendToken(token, 1)),
  10: CLIENT_TOKENS[10].map((token) => toFrontendToken(token, 10)),
  137: CLIENT_TOKENS[137].map((token) => toFrontendToken(token, 137)),
  42161: CLIENT_TOKENS[42161].map((token) => toFrontendToken(token, 42161)),
  8453: CLIENT_TOKENS[8453].map((token) => toFrontendToken(token, 8453)),
  4663: CLIENT_TOKENS[4663].map((token) => toFrontendToken(token, 4663)),
  5042: CLIENT_TOKENS[5042].map((token) => toFrontendToken(token, 5042)),
  100: CLIENT_TOKENS[100].map((token) => toFrontendToken(token, 100)),
  [TRON_CHAIN_ID]: TRON_TOKENS,
  // Presentation only: the matrix and `chainEnabledForRole` decide whether
  // Canton is offered at all.
  [CANTON_MAINNET_CHAIN_ID]: [toFrontendToken(CANTON_COIN, CANTON_MAINNET_CHAIN_ID)],
};

// ============================================================
// Constants
// ============================================================

/** Default source chain for new users */
export const DEFAULT_CHAIN_ID: ChainId = 8453;

/** "Ethereum", "Base or Ethereum", "Base, Ethereum or Arbitrum". */
export function joinChainNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Default destination chain: Arbitrum.
 *
 * This used to be Ethereum L1, chosen so both Public and Stealth were available
 * on first render (see stealthDestinationChains). That default was reversed in
 * #425 because it
 * put the most expensive destination in the supported set on the first screen a
 * user sees.
 *
 * Cost is `max(floor(destination_chain), 0.22%)` and the floor is gas-derived:
 * roughly $0.22 to an L1 destination against roughly $0.011 to an L2. Since the
 * cost ceiling landed (MAX_COST_RATIO 0.015, xochi#429), that floor no longer
 * shows up as a bad quote -- it shows up as a REFUSAL, so an L1 default meant a
 * $1 order bounced with an "amount too small" notice out of the box. On an L2
 * destination the same $1 order quotes at about 1.08%.
 *
 * An explicit Stealth choice shows live receive assets rather than silently
 * moving the destination or changing the privacy choice.
 */
export const DEFAULT_TO_CHAIN_ID: ChainId = 42161;

// ============================================================
// Helpers
// ============================================================

/**
 * Find token by symbol in a chain.
 *
 * Reads the LOCAL `TOKENS` map, which is already keyed by `SelectableChainId`
 * and carries `TRON_TOKENS`, rather than delegating to the shared EVM-only
 * registry. Delegating meant every Tron lookup returned undefined, so the two
 * callers that rebuild a panel from a stored record (the Retry prefill and
 * `planResume`) could not express a Tron leg and refused the whole trade.
 */
export const findTokenBySymbol = (chainId: SelectableChainId, symbol: string): Token | undefined =>
  TOKENS[chainId]?.find((t) => t.symbol === symbol);

/**
 * The tokens a fresh panel opens on: USDC on both default chains, a route the
 * solver fills (stablecoins are the only supported source today). Read by the
 * panel's initial state and by the frame URL parameters (embedParams.ts), which
 * fall back to exactly these.
 */
export const DEFAULT_FROM_TOKEN: Token =
  findTokenBySymbol(DEFAULT_CHAIN_ID, "USDC") ?? TOKENS[DEFAULT_CHAIN_ID][0];
export const DEFAULT_TO_TOKEN: Token =
  findTokenBySymbol(DEFAULT_TO_CHAIN_ID, "USDC") ?? TOKENS[DEFAULT_TO_CHAIN_ID][0];
