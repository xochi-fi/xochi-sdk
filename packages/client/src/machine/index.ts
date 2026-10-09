/**
 * The trade lifecycle as a pure state machine.
 *
 *   update(model, msg) -> [model, effects]   (machine.ts)
 *   view(model) -> Receipt                   (view.ts)
 *
 * Plus the wire decoders and the fund-safety gates the machine runs, exported
 * so the widget and headless integrators share one implementation of each.
 */

export {
  init,
  update,
  QUOTE_DEBOUNCE_MS,
  QUOTE_REFRESH_BUFFER_MS,
  RECONCILE_AFTER_ATTEMPTS,
  SIGN_PROMPT_TIMEOUT_MS,
  type Model,
  type Msg,
  type MsgBody,
  type Effect,
  type ApiCall,
  type WalletCall,
  type TimerCall,
  type TimerName,
  type MachineEvent,
  type ErrorReport,
  type Context,
  type WalletContext,
  type Outcome,
  type StealthMetaAddress,
  type MachineConfig,
  type QuoteFlight,
  type SignFlow,
  type PollState,
} from "./machine.js";
export { view } from "./view.js";
export {
  payoutOf,
  costOf,
  settlementDisclosure,
  type Receipt,
  type Served,
  type PayoutSlot,
  type CostSlot,
  type QuoteSlot,
  type SigningSlot,
  type SettlementDisclosure,
} from "./receipt.js";
export { phaseFromStatus, type SwapPhase } from "./phase.js";
export * from "./decisions.js";
export * from "./wire.js";
export * from "./state.js";
export * from "./deposit.js";
export * from "./quoteChecks.js";
export * from "./claimInfo.js";
export * from "./recipientEcho.js";
export * from "./solverPin.js";
export { applyStatusTransition } from "./transition.js";
export { validateSwapParams, type SwapValidationResult } from "./validateRequest.js";
