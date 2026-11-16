/**
 * Escrow order tracking (SPEC.md §5.2, ESCROW-RFC.md §3): where a taker's
 * escrowed principal is, for a UI.
 *
 * The flow, end to end:
 *
 *  1. Quote. An escrow-bearing quote is verified at ingest against the caller's
 *     `MachineConfig.escrows` pin (`checkSignableQuote` ->
 *     `assertEscrowQuoteMatchesRequest`), which returns the `VerifiedEscrowOrder`
 *     to keep as evidence. Without a pin it is refused.
 *  2. Sign. The taker signs the intent and the origin pull. The pull IS the
 *     escrow open (order v2): ERC-3009 `nonce` / Permit2 witness = `orderId`,
 *     `to` / `spender` = the pinned escrow (`pullPinFor`).
 *  3. Execute. `/api/intent/execute` carries the pull signature, and the venue
 *     submits `openWith*` for the taker (`/xochi/execute`, relayed open).
 *  4. Track. `escrowProgress` reads the status poll's escrow fields
 *     (`IntentStatusData.escrow`) and `refundableAt` (`readEscrowLock`, or
 *     `fillDeadline + claimWindow`).
 *  5. Refund. Past `refundableAt` with no claim, anyone may call
 *     `refund(orderId)`; `escrowRefundCall` builds it. The principal returns
 *     to the depositor whoever sends it.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { EscrowStatusData } from "./machine/wire.js";

/**
 * What a UI shows for an escrow order:
 *
 * - `awaiting_open`: OpenAuth issued, no lock seen yet; nothing has moved.
 * - `awaiting_delivery`: principal locked; the solver has not been attested.
 * - `delivered`: the delivery is attested (`cantonUpdateId`, or a fill
 *   receipt); the claim is pending. Not a balance read: only the attestation.
 * - `claimed`: a final `Claimed`; the solver was paid from the lock.
 * - `refundable`: `refundableAt` has passed unclaimed, or the venue has queued
 *   the refund (`refund_pending`); `refund(orderId)` is open to anyone.
 * - `refunded`: a final `Refunded`; the principal is back with the depositor.
 * - `expired`: the OpenAuth lapsed and no lock opened; nothing moved.
 * - `unknown`: a status this build does not model; keep polling.
 */
export type EscrowProgress =
  | "awaiting_open"
  | "awaiting_delivery"
  | "delivered"
  | "claimed"
  | "refundable"
  | "refunded"
  | "expired"
  | "unknown";

/** The served statuses (SPEC.md §3.4) an escrow order reads. */
const ESCROW_WIRE_PROGRESS: Readonly<Record<string, EscrowProgress>> = {
  pending: "awaiting_open",
  expired: "expired",
  completed: "claimed",
  refunded: "refunded",
  refund_pending: "refundable",
  executing: "awaiting_delivery",
  settling: "awaiting_delivery",
};

/**
 * The progress of an escrow order at `nowSec` (unix seconds). `refundableAt` is
 * the lock's (`readEscrowLock`) or `escrowRefundableAt(fillDeadline,
 * claimWindow)`; `null` when unknown, in which case only the venue's own
 * `refund_pending` reads as refundable. `delivered` also counts an EVM fill
 * receipt (`settlementTxHash`).
 */
export function escrowProgress(
  status: Pick<EscrowStatusData, "wireStatus" | "cantonUpdateId">,
  opts: { refundableAt: number | null; nowSec: number; settlementTxHash?: string | null },
): EscrowProgress {
  const progress = ESCROW_WIRE_PROGRESS[status.wireStatus] ?? "unknown";
  if (progress !== "awaiting_delivery") return progress;
  // `claim` reverts from `refundableAt` on, so an attested-but-unclaimed order
  // past it is refundable, not delivered.
  if (opts.refundableAt !== null && opts.nowSec >= opts.refundableAt) return "refundable";
  return status.cantonUpdateId || opts.settlementTxHash ? "delivered" : "awaiting_delivery";
}

/** `refundableAt = fillDeadline + claimWindow` (ESCROW-RFC.md §3). */
export function escrowRefundableAt(fillDeadline: number, claimWindowSeconds: number): number {
  return fillDeadline + claimWindowSeconds;
}

/** The `RiddlerEscrow` reads and the refund this client uses. */
export const RIDDLER_ESCROW_ABI = [
  {
    type: "function",
    name: "locks",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [
      { name: "depositor", type: "address" },
      { name: "refundableAt", type: "uint64" },
      { name: "feeBps", type: "uint16" },
      { name: "status", type: "uint8" },
      { name: "token", type: "address" },
      { name: "toChainId", type: "uint64" },
      { name: "verifier", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "claimWindow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [],
  },
] as const;

/** `RiddlerEscrow.Status`, in contract order. */
export const ESCROW_LOCK_STATUSES = ["none", "open", "claimed", "refunded"] as const;
export type EscrowLockStatus = (typeof ESCROW_LOCK_STATUSES)[number];

/** One `locks(orderId)` entry. `status: "none"` means no lock was ever opened. */
export interface EscrowLock {
  status: EscrowLockStatus;
  depositor: Address;
  /** Unix seconds; 0 when no lock exists. */
  refundableAt: number;
  token: Address;
  amount: bigint;
  toChainId: bigint;
}

/** The structural slice of a viem `PublicClient` `readEscrowLock` needs. */
export interface EscrowReader {
  readContract(args: {
    address: Address;
    abi: typeof RIDDLER_ESCROW_ABI;
    functionName: "locks";
    args: readonly [Hex];
  }): Promise<readonly [Address, bigint, number, number, Address, bigint, Address, bigint]>;
}

/** Decode a `locks(orderId)` result tuple; an unknown status refuses. */
export function parseEscrowLock(
  raw: readonly [Address, bigint, number, number, Address, bigint, Address, bigint],
): EscrowLock {
  const [depositor, refundableAt, , status, token, toChainId, , amount] = raw;
  const named = ESCROW_LOCK_STATUSES[status];
  if (named === undefined) throw new Error(`RiddlerEscrow lock status ${status} is not modelled`);
  return { status: named, depositor, refundableAt: Number(refundableAt), token, amount, toChainId };
}

/**
 * Read the lock for `orderId` from `escrow`, the CALLER-PINNED escrow for the
 * origin chain (never the status poll's `escrow.address`). The lock is the
 * authority on `refundableAt` and on whether the order was claimed or refunded.
 */
export async function readEscrowLock(
  client: EscrowReader,
  escrow: Address,
  orderId: Hex,
): Promise<EscrowLock> {
  const raw = await client.readContract({
    address: escrow,
    abi: RIDDLER_ESCROW_ABI,
    functionName: "locks",
    args: [orderId],
  });
  return parseEscrowLock(raw);
}

/**
 * The permissionless `refund(orderId)` call, for any sender once `refundableAt`
 * has passed with no claim. The principal goes to the lock's depositor whoever
 * sends it; before `refundableAt` it reverts.
 */
export function escrowRefundCall(escrow: Address, orderId: Hex): { to: Address; data: Hex } {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: RIDDLER_ESCROW_ABI, functionName: "refund", args: [orderId] }),
  };
}
