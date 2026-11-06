// The escrow gateway's transaction sender: one nonce slot per send, followed
// by observation when its outcome is in doubt (escrow-gateway.ts header).
// Internal: `OnchainEscrowGateway` owns one; index.ts does not re-export it.

import { ethers } from "ethers";
import type { Hex } from "@xochi/signer";

import { EscrowRefusalError } from "./escrow-verify";

export type TxOutcome =
  | { status: "confirmed"; txHash: Hex; blockNumber: number }
  | { status: "reverted"; txHash: Hex; blockNumber: number }
  // The node refused the signed transaction (it is not in any mempool), or its
  // slot was consumed with the effect absent; nothing of this hash can land.
  // Safe to re-plan -- the refusal is definite.
  | { status: "not_sent"; txHash: Hex; reason: string }
  // Sent or possibly sent, outcome unknown. Resolve by observation; never send
  // a NEW transaction for it. `from`/`nonce` are the slot it was signed for:
  // only a transaction in that slot can land (`resolveTx`). `hashes`, when
  // given, is every signing of the action in that slot (`txHash` last).
  | {
      status: "in_doubt";
      txHash: Hex;
      reason: string;
      from?: string;
      nonce?: number;
      hashes?: Hex[];
    }
  // A fill or claim whose slot was still unmined when chain time reached the
  // last moment it could land (`landBy`: past the FillAuth deadline, at
  // refundableAt), so the slot is being freed: a zero-value self-transfer was
  // signed at the SAME nonce with a bumped fee (`cancelTxHash`) and a node is
  // shown to hold it, so a dead send cannot hold up every later send from the
  // key. NOT a final answer: the action may already have landed in the last
  // block it could (a receipt backend trailing the head the deadline was read
  // from), and if no signing is mined the cancel may not be either. Keep
  // following it like `in_doubt`: `resolveTx(chainId, hashes, { from, nonce },
  // effect)` -- the action's `hashes`, never `cancelTxHash`, whose receipt is
  // not the action's -- or call `fill` again for the fillId. It is a no-show
  // only once that resolves `not_sent` (the nonce consumed with the effect
  // absent at that block). `txHash` is the action's latest signing.
  | {
      status: "cancelled";
      txHash: Hex;
      hashes: Hex[];
      cancelTxHash: Hex;
      reason: string;
      from: string;
      nonce: number;
    };

// ethers codes for a node that REJECTED the raw transaction outright.
const DEFINITE_REJECTIONS: Record<string, true> = {
  INSUFFICIENT_FUNDS: true,
  NONCE_EXPIRED: true,
  REPLACEMENT_UNDERPRICED: true,
};
// Node answers ethers leaves UNKNOWN_ERROR. "intrinsic gas too low" fails the
// pool's validation on every node of the chain, so it is as definite as the
// codes above (Arbitrum answers it to a 21000-gas transfer).
const INTRINSIC_GAS_TOO_LOW = /intrinsic gas too low/i;
// The node already holds exactly these bytes (geth "already known", older
// geth/Besu "known transaction", Nethermind "AlreadyKnown").
const ALREADY_HELD = /already known|known transaction|alreadyknown/i;

// ethers' error `code`, if any.
function codeOf(err: unknown): unknown {
  return err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
}

// The node's own message, which ethers keeps under `error` (UNKNOWN_ERROR) or
// `info.error` (the codes it maps).
function nodeMessage(err: unknown): string {
  const e = err as {
    error?: { message?: unknown };
    info?: { error?: { message?: unknown } };
  } | null;
  const message = e?.error?.message ?? e?.info?.error?.message;
  return typeof message === "string" ? message : "";
}

// The broadcast failed with one of those codes or answers: the bytes are in no mempool.
function definitelyRejected(err: unknown): boolean {
  const code = codeOf(err);
  return (
    (typeof code === "string" && DEFINITE_REJECTIONS[code] === true) ||
    INTRINSIC_GAS_TOO_LOW.test(nodeMessage(err))
  );
}

// A same-nonce replacement pays at least this much more (geth and most
// mempools demand +10%), and never more than this multiple of the higher of
// the original fee and the market's: an RPC that answers every broadcast
// ambiguously must not walk the fee up without limit.
const REPLACEMENT_BUMP_EIGHTHS = 9n; // 9/8 = +12.5%
const REPLACEMENT_FEE_CAP_MULTIPLE = 4n;

// `paid` raised by REPLACEMENT_BUMP_EIGHTHS (by at least 1 wei), and at least `floor`.
function bumpFee(paid: bigint, floor: bigint): bigint {
  const raised = (paid * REPLACEMENT_BUMP_EIGHTHS + 7n) / 8n;
  const atLeast = raised > paid ? raised : paid + 1n;
  return atLeast > floor ? atLeast : floor;
}

// Whether `r` is priced out of inclusion at a block with `baseFee`, against
// the market `fees`: an EIP-1559 send whose max fee does not cover the base
// fee plus the tip it offers (so a block pays it less than that tip), or
// whose tip is below the market's; a legacy one below the market gas price.
// Not ethers' `maxFeePerGas` (~2 x baseFee + tip), which is a headroom
// heuristic for a NEW send: against it a send at 21 is "underpriced" the
// moment the base fee moves 10 -> 11, though it still clears that block.
function belowInclusion(
  r: ethers.TransactionLike<string>,
  baseFee: bigint | null,
  fees: ethers.FeeData,
): boolean {
  if (r.maxFeePerGas != null) {
    const tip = BigInt(r.maxPriorityFeePerGas ?? 0);
    if (baseFee !== null && BigInt(r.maxFeePerGas) < baseFee + tip) return true;
    return fees.maxPriorityFeePerGas != null && tip < fees.maxPriorityFeePerGas;
  }
  return fees.gasPrice != null && BigInt(r.gasPrice ?? 0) < fees.gasPrice;
}

export function describeRevert(err: unknown): string {
  const e = err as {
    revert?: { name: string; args: unknown[] };
    shortMessage?: string;
    message?: string;
  };
  if (e?.revert) return `${e.revert.name}(${e.revert.args.map(String).join(", ")})`;
  return e?.shortMessage ?? e?.message ?? String(err);
}

export function providerOf(runner: ethers.Signer): ethers.Provider {
  if (!runner.provider)
    throw new Error("escrow gateway: every signer must be connected to a provider");
  return runner.provider;
}

// Run `run` after every earlier `run` queued under `key` has settled. `queues`
// holds each key's tail, which only orders the NEXT run (a run's own failure
// still reaches its caller); a key is deleted once its queue drains.
export async function queued<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const mine = prior.then(run, run);
  const tail = mine.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await mine;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

function receiptOutcome(txHash: Hex, receipt: ethers.TransactionReceipt): TxOutcome {
  return receipt.status === 1
    ? { status: "confirmed", txHash, blockNumber: receipt.blockNumber }
    : { status: "reverted", txHash, blockNumber: receipt.blockNumber };
}

// Resolves after `ms`, or at once when `signal` aborts (the caller checks it).
// The global timer, so a test's fake timers drive it.
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// One fill/claim slot left in doubt: everything needed to follow it, re-send
// the same bytes, or re-sign the same call at the same nonce.
interface InDoubtSend {
  key: string; // `${chainId}:${address}`, the send queue and nonce record it belongs to
  signer: ethers.Signer;
  request: ethers.TransactionLike<string>; // populated: nonce, gas and fees fixed
  raw: string; // the latest signing of the slot (the highest fee)
  hashes: Hex[]; // every signing of the slot that may have reached a mempool
  from: string;
  nonce: number;
  originalFee: bigint; // maxFeePerGas (or gasPrice) of the first signing
  passes: number; // unresolved passes since the slot was last (re-)signed
  landBy?: bigint; // first chain second at which no signing of the action can land
  orderId?: string; // the order its warnings name
  cancel?: { hash: Hex; raw: string }; // the self-transfer freeing the slot past `landBy`
  released?: boolean; // its nonce was found consumed: nothing left to free
}

// The last transaction this gateway broadcast from a `${chainId}:${address}`
// (the map key carries the chain), kept while the node's pending count may
// not yet show it (`assignNonce`).
interface NonceRecord {
  nonce: number;
  hash: Hex;
  raw: string; // re-broadcast once when the node no longer holds it
  landBy?: bigint; // chain second past which the send it carries is dead
  expiresAtMs: number; // on `now`: past this a held-but-uncounted send is a gap, not lag
}

interface SendPlan {
  signer: ethers.Signer;
  contract: ethers.Contract;
  method: string;
  args: unknown[];
  // Replaces the default `staticCall` simulation; throws a refusal to stop.
  simulate?: () => Promise<void>;
  // Runs INSIDE the send queue, before simulation: a deadline the queue wait
  // may have run past is re-checked where nothing waits after it.
  recheck?: () => Promise<void>;
  // `fill:<fillId>` / `claim:<orderId>`: an in-doubt outcome is recorded under
  // it, so the next call for the same action follows it instead of sending.
  inDoubtKey?: string;
  orderId?: string; // the order a fill/claim is for; warnings about its slot name it
  // The first chain second at which the call can no longer land (a fill:
  // FillAuth deadline + 1; a claim: refundableAt). Bounds the receipt wait, and
  // past it an unmined slot is freed with a same-nonce self-transfer.
  landBy?: bigint;
}

export interface TxSenderOptions {
  now: () => number; // ms
  receiptTimeoutMs: number;
  receiptPollMs: number;
  replaceInDoubtAfterBlocks?: number;
  replaceInDoubtAfterPasses?: number;
  replaceInDoubtWithinSec?: number;
  warn: (message: string, orderId: string) => void;
  // The later of the chains' latest block times and, unless `withLocal` is
  // false, the local clock (`OnchainEscrowGateway.nowSec`).
  nowSec: (providers: ethers.Provider[], withLocal?: boolean) => Promise<bigint>;
}

// The gateway's options are documented on `OnchainEscrowGatewayOptions`.
export class TxSender {
  private readonly opts: TxSenderOptions;
  private readonly now: () => number;
  private readonly receiptTimeoutMs: number;
  private readonly receiptPollMs: number;
  private readonly warn: (message: string, orderId: string) => void;
  // Fill/claim slots this gateway left in doubt, by `fill:<fillId>` /
  // `claim:<orderId>`. Process-local: it stops THIS process sending a second
  // transaction; a restarted solver must resolve its own in-doubt hashes
  // (`resolveTx`) before acting again.
  private readonly inDoubt = new Map<string, InDoubtSend>();
  // One nonce assignment at a time per `${chainId}:${address}`: two sends
  // populated concurrently read the same pending nonce, and the second is
  // refused REPLACEMENT_UNDERPRICED / nonce too low. Keyed per chain because
  // nonces are: one EOA used as both origin claimer and destination filler must
  // not let an origin claim hold up a destination fill. Held only through
  // simulate/populate/sign/broadcast, never through the receipt wait.
  private readonly sendQueues = new Map<string, Promise<unknown>>();
  // The last transaction this gateway broadcast from each
  // `${chainId}:${address}`, kept until the node's own pending count passes
  // its nonce. The queue orders nonce assignment but cannot make the read
  // fresh: a default ethers provider answers an identical
  // `eth_getTransactionCount` inside 250ms from its request cache, handing the
  // second of two back-to-back sends the nonce the first just took.
  // The hash and bytes are kept so a record is only trusted while the node
  // still holds that transaction: one it evicted would otherwise put every
  // later send behind a nonce nobody holds (`assignNonce`).
  private readonly lastNonce = new Map<string, NonceRecord>();

  constructor(opts: TxSenderOptions) {
    this.opts = opts;
    this.now = opts.now;
    this.receiptTimeoutMs = opts.receiptTimeoutMs;
    this.receiptPollMs = opts.receiptPollMs;
    this.warn = opts.warn;
  }

  // Simulate, then sign and broadcast inside the `${chainId}:${address}` queue,
  // then wait for the receipt OUTSIDE it: only nonce assignment needs ordering,
  // and a queue held through a 120s receipt wait stalls every later send from
  // the same key past windows measured in tens of seconds. Throws a refusal
  // (nothing sent) when `recheck` or the simulation refuses; every outcome
  // after signing is RETURNED, never thrown.
  async send(plan: SendPlan): Promise<TxOutcome> {
    const { signer, method, args } = plan;
    const provider = providerOf(signer);
    const fn = plan.contract.connect(signer).getFunction(method);
    const { slot, error } = await this.serialized(signer, async (key) => {
      await plan.recheck?.();
      if (plan.simulate) {
        await plan.simulate();
      } else {
        try {
          await fn.staticCall(...args);
        } catch (err) {
          throw new EscrowRefusalError(
            "simulation_failed",
            `${method} would revert: ${describeRevert(err)}`,
          );
        }
      }
      // Nothing sent after an unmined slot can land before it: a dead one is
      // freed first, whether or not its own caller ever comes back for it.
      await this.releaseDeadSlots(key, provider);
      const from = await signer.getAddress();
      const nonce = await this.assignNonce(key, provider, from);
      const request = await signer.populateTransaction(
        await fn.populateTransaction(...args, { nonce }),
      );
      const raw = await signer.signTransaction(request);
      const slot: InDoubtSend = {
        key,
        signer,
        request,
        raw,
        hashes: [ethers.keccak256(raw) as Hex],
        from,
        nonce,
        originalFee: BigInt(request.maxFeePerGas ?? request.gasPrice ?? 0),
        passes: 0,
        landBy: plan.landBy,
        orderId: plan.orderId,
      };
      try {
        await provider.broadcastTransaction(raw);
      } catch (err) {
        return { slot, error: err as unknown };
      }
      // The node holds it: the next send from this key goes after it, whatever
      // a lagging read says. An ambiguous broadcast is NOT recorded: if the
      // node did take it its pending count says so, and if it did not, a gap
      // here would strand every later send from this key behind a nonce no
      // node holds (an owed fill's claim included).
      this.recordBroadcast(slot, slot.hashes[0]!, raw, slot.landBy);
      return { slot, error: null };
    });
    const reason = error === null ? "" : `broadcast of ${method} failed: ${describeRevert(error)}`;
    if (error !== null && definitelyRejected(error))
      return { status: "not_sent", txHash: slot.hashes[0]!, reason };
    // An ambiguous broadcast is followed like an accepted one: the wait
    // re-broadcasts whatever the node turns out not to hold.
    const outcome = await this.awaitReceipt(provider, method, slot, reason);
    if ((outcome.status === "in_doubt" || outcome.status === "cancelled") && plan.inDoubtKey)
      this.inDoubt.set(plan.inDoubtKey, slot);
    return outcome;
  }

  // Poll for a receipt of any signing of the slot until `receiptTimeoutMs` has
  // passed on `now` or chain time reaches the slot's `landBy`, whichever is
  // first, keeping the slot moving in between: its latest signing is
  // re-broadcast whenever the node does not hold it, and a fill or claim (a
  // slot with a `landBy`) is re-signed at the same nonce with a bumped fee when
  // a new block left it out and either it could not be included at that
  // block's base fee (`belowInclusion`) or `replaceInDoubtAfterBlocks` blocks
  // have now left it out since it was last signed. Time alone never re-signs:
  // a fill at an adequate fee waiting out a 12s block is signed once. A slot
  // still unmined at `landBy` is freed
  // (`cancelled` once a node is shown to hold the self-transfer, else
  // `in_doubt`). The head is read BEFORE the receipts, so a signing mined in
  // any block up to the head that decides `landBy` is seen as landed. `note`
  // is why the first broadcast was ambiguous, if it was.
  private async awaitReceipt(
    provider: ethers.Provider,
    method: string,
    slot: InDoubtSend,
    note: string,
  ): Promise<TxOutcome> {
    const deadline = this.now() + this.receiptTimeoutMs;
    const afterBlocks = this.opts.replaceInDoubtAfterBlocks ?? 3;
    let lastError = note ? `: ${note}` : "";
    let lastHead: number | null = null;
    let missed = 0; // blocks since the slot was last signed that did not include it
    while (true) {
      let head: ethers.Block | null = null;
      if (slot.landBy !== undefined) {
        try {
          head = await provider.getBlock("latest");
        } catch (err) {
          lastError = `: ${describeRevert(err)}`;
        }
      }
      try {
        const landed = await this.receiptOf(provider, slot.hashes);
        if (landed) return landed;
      } catch (err) {
        lastError = `: ${describeRevert(err)}`;
      }
      const txHash = slot.hashes[slot.hashes.length - 1]!;
      const followed = { txHash, hashes: [...slot.hashes], from: slot.from, nonce: slot.nonce };
      let newBlock = false;
      let headBaseFee: bigint | null = null;
      if (head && slot.landBy !== undefined) {
        if (BigInt(head.timestamp) >= slot.landBy) {
          const released = await this.releaseSlot(slot, slot.landBy);
          const reason = `no receipt for ${method}; ${released.note}`;
          return released.cancelTxHash
            ? { status: "cancelled", ...followed, cancelTxHash: released.cancelTxHash, reason }
            : { status: "in_doubt", ...followed, reason };
        }
        if (lastHead !== null && head.number > lastHead) {
          missed += head.number - lastHead;
          newBlock = true;
          headBaseFee = head.baseFeePerGas;
        }
        if (lastHead === null || head.number > lastHead) lastHead = head.number;
      }
      if (this.now() >= deadline) {
        return {
          status: "in_doubt",
          ...followed,
          reason: `no receipt for ${method} within ${this.receiptTimeoutMs}ms${lastError}`,
        };
      }
      await pause(this.receiptPollMs);
      try {
        if (newBlock) {
          const fees = await provider.getFeeData();
          if (
            (belowInclusion(slot.request, headBaseFee, fees) || missed >= afterBlocks) &&
            (await this.replaceAtSameNonce(slot, fees)).adopted
          ) {
            missed = 0;
            continue;
          }
        }
        if ((await this.txState(provider, slot.hashes[slot.hashes.length - 1]!)) === null)
          await this.rebroadcast(slot);
      } catch (err) {
        lastError = `: ${describeRevert(err)}`;
      }
    }
  }

  // Before a second send for the same key, an earlier in-doubt one is followed
  // by observation. Confirmed, or the action visibly done on chain (`isDone`:
  // `filled(fillId)`, lock `Claimed`) -> refuse with `doneCode`; reverted, or
  // its slot consumed with the effect absent -> definite, so a fresh decision
  // may proceed; otherwise still in doubt -> rescue it (`rescue`) and refuse,
  // so no transaction at a NEW nonce is ever sent for it. `landBy` is the
  // first chain second at which none of its signings can land any more.
  async guardInDoubt(
    key: string,
    doneCode: "already_filled" | "already_claimed",
    orderId: string,
    isDone: (blockTag?: number) => Promise<boolean>,
    landBy: bigint,
  ): Promise<void> {
    const prior = this.inDoubt.get(key);
    if (!prior) return;
    const resolved = await this.resolveSlot(providerOf(prior.signer), prior.hashes, prior, isDone);
    if (resolved.status === "confirmed") {
      this.inDoubt.delete(key);
      throw new EscrowRefusalError(
        doneCode,
        `earlier ${key} ${resolved.txHash} confirmed in block ${resolved.blockNumber}`,
        orderId,
      );
    }
    if (resolved.status === "in_doubt") {
      if (await isDone()) {
        this.inDoubt.delete(key);
        throw new EscrowRefusalError(
          doneCode,
          `earlier ${key} ${resolved.txHash} has no receipt, but the chain shows it done`,
          orderId,
        );
      }
      const rescued = await this.rescue(prior, landBy);
      throw new EscrowRefusalError(
        "in_doubt",
        `earlier ${key} at nonce ${prior.nonce} is unresolved; ${rescued}`,
        orderId,
      );
    }
    this.inDoubt.delete(key);
  }

  // Keep an unresolved slot moving without ever leaving it: re-broadcast its
  // latest signing (same bytes, same hash -- a node that never got it takes it
  // now, one that has it says so), and after `replaceInDoubtAfterPasses`
  // passes, or inside `replaceInDoubtWithinSec` of `landBy`, re-sign the same
  // call at the SAME nonce with higher fees, for a send stuck underpriced. Only
  // one transaction per slot can land, so neither step can double-send; a
  // second claim against a Claimed lock would only revert `NotOpen`. Past
  // `landBy` the slot is freed instead (`releaseSlot`).
  private async rescue(prior: InDoubtSend, landBy: bigint): Promise<string> {
    const provider = providerOf(prior.signer);
    const now = await this.opts.nowSec([provider], false);
    if (now >= landBy) return (await this.releaseSlot(prior, landBy)).note;
    prior.passes += 1;
    const due =
      prior.passes >= (this.opts.replaceInDoubtAfterPasses ?? 3) ||
      landBy - now <= BigInt(this.opts.replaceInDoubtWithinSec ?? 300);
    const replaced = due ? await this.replaceAtSameNonce(prior) : null;
    if (replaced?.adopted) return replaced.note;
    const rebroadcast = await this.rebroadcast(prior);
    return replaced ? `${replaced.note}; ${rebroadcast}` : rebroadcast;
  }

  // Re-broadcast the slot's latest signing: same bytes, same hash. Never throws.
  private async rebroadcast(slot: InDoubtSend): Promise<string> {
    const hash = slot.hashes[slot.hashes.length - 1]!;
    try {
      await providerOf(slot.signer).broadcastTransaction(slot.raw);
    } catch (err) {
      // "already known" from a node that holds it is the expected answer.
      return `re-broadcast ${hash}: ${describeRevert(err)}`;
    }
    this.recordBroadcast(slot, hash, slot.raw, slot.landBy);
    return `re-broadcast ${hash}`;
  }

  // Re-sign `prior` at its nonce with fees bumped 12.5% over what it offered,
  // at least the market's and at most REPLACEMENT_FEE_CAP_MULTIPLE x the higher
  // of its original fee and the market's. Adopted (it becomes the slot's
  // latest signing) unless the node refused it outright. `given` is a market
  // read the caller already holds.
  private async replaceAtSameNonce(
    prior: InDoubtSend,
    given?: ethers.FeeData,
  ): Promise<{ adopted: boolean; note: string }> {
    const provider = providerOf(prior.signer);
    const fees = given ?? (await provider.getFeeData());
    const r = prior.request;
    const eip1559 = r.maxFeePerGas != null;
    const offered = BigInt((eip1559 ? r.maxFeePerGas : r.gasPrice) ?? 0);
    const market = (eip1559 ? fees.maxFeePerGas : fees.gasPrice) ?? 0n;
    const fee = bumpFee(offered, market);
    const cap =
      REPLACEMENT_FEE_CAP_MULTIPLE * (prior.originalFee > market ? prior.originalFee : market);
    if (fee > cap)
      return {
        adopted: false,
        note: `replacement at nonce ${prior.nonce} would offer ${fee}, over the cap ${cap}`,
      };
    let next: ethers.TransactionLike<string>;
    if (eip1559) {
      const tip = bumpFee(BigInt(r.maxPriorityFeePerGas ?? 0), fees.maxPriorityFeePerGas ?? 0n);
      next = { ...r, maxFeePerGas: fee, maxPriorityFeePerGas: tip < fee ? tip : fee };
    } else {
      next = { ...r, gasPrice: fee };
    }
    const raw = await prior.signer.signTransaction(next);
    const hash = ethers.keccak256(raw) as Hex;
    const note = `replaced at nonce ${prior.nonce} by ${hash} offering ${fee} (was ${offered})`;
    try {
      await provider.broadcastTransaction(raw);
    } catch (err) {
      if (definitelyRejected(err))
        return {
          adopted: false,
          note: `replacement at nonce ${prior.nonce} refused: ${describeRevert(err)}`,
        };
      // Ambiguous: it may be in a mempool, so it is followed like the original.
      Object.assign(prior, { request: next, raw, hashes: [...prior.hashes, hash], passes: 0 });
      return { adopted: true, note: `${note}, broadcast ambiguous: ${describeRevert(err)}` };
    }
    Object.assign(prior, { request: next, raw, hashes: [...prior.hashes, hash], passes: 0 });
    this.recordBroadcast(prior, hash, raw, prior.landBy);
    return { adopted: true, note };
  }

  // Past `landBy` no signing of the slot's action can land, but an unmined one
  // still holds the nonce, and every later send from the key queues behind
  // it. Free it: a zero-value self-transfer at the SAME nonce, fees bumped over
  // the slot's latest signing (and at least the market's) and gas estimated
  // (Arbitrum charges a plain transfer more than 21000), signed once and
  // re-broadcast on every later call. A signing mined after `landBy` has no
  // effect; one already mined at or before it (a receipt backend behind the
  // head) still had it, which is why the caller keeps following the slot.
  // Never throws. `cancelTxHash` is the self-transfer only once a node is
  // shown to hold it -- the broadcast succeeded, or its hash reads pending or
  // mined -- and null otherwise: a refused or unheard cancel frees nothing.
  private async releaseSlot(
    slot: InDoubtSend,
    landBy: bigint,
  ): Promise<{ cancelTxHash: Hex | null; note: string }> {
    const provider = providerOf(slot.signer);
    const past = `past ${landBy}, when it could last land`;
    try {
      if (!slot.cancel) {
        const [fees, estimate] = await Promise.all([
          provider.getFeeData(),
          provider.estimateGas({ from: slot.from, to: slot.from, value: 0n, data: "0x" }),
        ]);
        // 20% over the estimate for an L1 data cost that moves before it
        // lands; never under a plain transfer's 21000.
        const padded = estimate + estimate / 5n;
        const r = slot.request;
        const base: ethers.TransactionLike<string> = {
          type: r.type,
          chainId: r.chainId,
          nonce: slot.nonce,
          to: slot.from,
          value: 0n,
          data: "0x",
          gasLimit: padded > 21_000n ? padded : 21_000n,
        };
        let cancel: ethers.TransactionLike<string>;
        if (r.maxFeePerGas != null) {
          const fee = bumpFee(BigInt(r.maxFeePerGas), fees.maxFeePerGas ?? 0n);
          const tip = bumpFee(BigInt(r.maxPriorityFeePerGas ?? 0), fees.maxPriorityFeePerGas ?? 0n);
          cancel = { ...base, maxFeePerGas: fee, maxPriorityFeePerGas: tip < fee ? tip : fee };
        } else {
          cancel = { ...base, gasPrice: bumpFee(BigInt(r.gasPrice ?? 0), fees.gasPrice ?? 0n) };
        }
        const raw = await slot.signer.signTransaction(cancel);
        slot.cancel ??= { hash: ethers.keccak256(raw) as Hex, raw };
      }
    } catch (err) {
      return {
        cancelTxHash: null,
        note: `${past}; could not sign a self-transfer to free nonce ${slot.nonce}: ${describeRevert(err)}`,
      };
    }
    const { hash, raw } = slot.cancel!;
    try {
      await provider.broadcastTransaction(raw);
    } catch (err) {
      if (codeOf(err) === "NONCE_EXPIRED") {
        // The slot is consumed: by the action itself or by an earlier send of this self-transfer.
        slot.released = true;
        return { cancelTxHash: null, note: `${past}; nonce ${slot.nonce} is already consumed` };
      }
      if (definitelyRejected(err)) {
        // Not in any mempool ("intrinsic gas too low" included): the next
        // call estimates and signs it afresh, at the market then.
        slot.cancel = undefined;
        return {
          cancelTxHash: null,
          note: `${past}; self-transfer ${hash} to free nonce ${slot.nonce} refused: ${describeRevert(err)}`,
        };
      }
      // Ambiguous: out only if a node is shown to hold it. Kept either way,
      // so the next call re-broadcasts the same bytes.
      let held: "mined" | "pending" | null = null;
      try {
        held = await this.txState(provider, hash);
      } catch (readErr) {
        return {
          cancelTxHash: null,
          note: `${past}; self-transfer ${hash} to free nonce ${slot.nonce} unconfirmed (${describeRevert(err)}; ${describeRevert(readErr)})`,
        };
      }
      if (held === null) {
        return {
          cancelTxHash: null,
          note: `${past}; no node is shown to hold self-transfer ${hash} to free nonce ${slot.nonce}: ${describeRevert(err)}`,
        };
      }
      this.recordBroadcast(slot, hash, raw, undefined);
      return {
        cancelTxHash: hash,
        note: `${past}; freeing nonce ${slot.nonce} with self-transfer ${hash} (${held}): ${describeRevert(err)}`,
      };
    }
    this.recordBroadcast(slot, hash, raw, undefined);
    return {
      cancelTxHash: hash,
      note: `${past}; freeing nonce ${slot.nonce} with self-transfer ${hash}`,
    };
  }

  // Free every in-doubt slot of `key` that is past its `landBy` (see `releaseSlot`).
  private async releaseDeadSlots(key: string, provider: ethers.Provider): Promise<void> {
    const slots = [...this.inDoubt.entries()].filter(
      ([, s]) => s.key === key && s.landBy !== undefined && !s.released,
    );
    if (slots.length === 0) return;
    const now = await this.opts.nowSec([provider], false);
    for (const [inDoubtKey, slot] of slots) {
      if (now < slot.landBy!) continue;
      const first = !slot.cancel;
      const released = await this.releaseSlot(slot, slot.landBy!);
      if (first) this.warn(`in-doubt ${inDoubtKey}: ${released.note}`, slot.orderId ?? inDoubtKey);
    }
  }

  // Record a broadcast the node accepted as `slot.key`'s last, unless a later
  // nonce is already recorded there. A send whose nonce came from the record
  // (and a same-nonce re-signing) inherits its expiry: the expiry bounds how
  // long the node's count may fail to show this gateway's sends, and renewing
  // it on every send would let steady traffic keep a gap open forever.
  private recordBroadcast(
    slot: Pick<InDoubtSend, "key" | "nonce">,
    hash: Hex,
    raw: string,
    landBy: bigint | undefined,
  ): void {
    const prior = this.lastNonce.get(slot.key);
    if (prior && prior.nonce > slot.nonce) return;
    this.lastNonce.set(slot.key, {
      nonce: slot.nonce,
      hash,
      raw,
      landBy,
      expiresAtMs: prior?.expiresAtMs ?? this.now() + this.receiptTimeoutMs,
    });
  }

  // Whether the node knows a transaction, read around any request cache: null
  // when it does not, else whether it is mined or still pending.
  private async txState(provider: ethers.Provider, hash: Hex): Promise<"mined" | "pending" | null> {
    const tx: { blockNumber?: unknown } | null =
      provider instanceof ethers.JsonRpcApiProvider
        ? await provider.send("eth_getTransactionByHash", [hash])
        : await provider.getTransaction(hash);
    if (!tx) return null;
    return tx.blockNumber != null ? "mined" : "pending";
  }

  // The nonce for the next send from `key`: the node's pending count read
  // around any request cache, or one past the last nonce this gateway
  // broadcast from `key` while the node's count does not yet show it. Callers'
  // `cacheTimeout` is not relied on. Run only inside `serialized`. A
  // same-nonce replacement keeps its slot's nonce and never comes through here.
  //
  // The record is trusted only while that transaction still occupies its
  // nonce: mined (the count is stale), or held by the node and not yet
  // expired. One the node's lookup does not show is re-broadcast once, and
  // the node's answer decides: taken, "already known" (a load-balanced lookup
  // backend can lack what its peer holds), nonce consumed, or the slot held by
  // a higher-fee transaction all keep the record. Only an answer that proves
  // it cannot be held (insufficient funds), or an ambiguous one after which
  // the lookup still does not show it, drops the record for the count, so an
  // evicted send never strands the key behind a nonce nobody holds. Past its
  // `landBy` (its action is dead) or `receiptTimeoutMs` after the record
  // chain began (a held send the count skips is a gap, not lag -- the shape a
  // count that once read too high leaves), the record is dropped too.
  private async assignNonce(key: string, provider: ethers.Provider, from: string): Promise<number> {
    const pending =
      provider instanceof ethers.JsonRpcApiProvider
        ? ethers.getNumber(
            await provider.send("eth_getTransactionCount", [from, "pending"]),
            "pending nonce",
          )
        : await provider.getTransactionCount(from, "pending");
    const last = this.lastNonce.get(key);
    if (last === undefined || pending > last.nonce) {
      this.lastNonce.delete(key);
      return pending;
    }
    const held = await this.txState(provider, last.hash);
    if (held === "mined") return last.nonce + 1;
    const expired =
      this.now() > last.expiresAtMs ||
      (last.landBy !== undefined && (await this.opts.nowSec([provider], false)) >= last.landBy);
    if (!expired) {
      if (held === "pending") return last.nonce + 1;
      try {
        await provider.broadcastTransaction(last.raw);
        return last.nonce + 1;
      } catch (err) {
        const code = codeOf(err);
        if (
          code === "NONCE_EXPIRED" ||
          code === "REPLACEMENT_UNDERPRICED" ||
          ALREADY_HELD.test(nodeMessage(err))
        )
          return last.nonce + 1;
        if (!definitelyRejected(err) && (await this.txState(provider, last.hash)) !== null)
          return last.nonce + 1;
      }
    }
    this.lastNonce.delete(key);
    return pending;
  }

  // Run `send` after every earlier send from the same `${chainId}:${address}`
  // has left the queue (it leaves once broadcast; see `send`). `send` gets
  // that key.
  private async serialized<T>(
    signer: ethers.Signer,
    send: (key: string) => Promise<T>,
  ): Promise<T> {
    const { chainId } = await providerOf(signer).getNetwork();
    const key = `${chainId}:${(await signer.getAddress()).toLowerCase()}`;
    return queued(this.sendQueues, key, () => send(key));
  }

  async resolveSlot(
    provider: ethers.Provider,
    hashes: Hex[],
    slot: { from: string; nonce: number } | undefined,
    effect?: (blockTag: number) => Promise<boolean>,
  ): Promise<TxOutcome> {
    const txHash = hashes[hashes.length - 1]!;
    const pending = (reason: string): TxOutcome => ({
      status: "in_doubt",
      txHash,
      hashes: [...hashes],
      reason,
      ...(slot && { from: slot.from, nonce: slot.nonce }),
    });
    let consumedBy: number | null = null;
    if (slot) {
      const block = await provider.getBlockNumber();
      if ((await provider.getTransactionCount(slot.from, block)) > slot.nonce) consumedBy = block;
    }
    const landed = await this.receiptOf(provider, hashes);
    if (landed) return landed;
    if (consumedBy === null || !slot) return pending("no receipt yet");
    const consumed = `nonce ${slot.nonce} of ${slot.from} was consumed by block ${consumedBy} and no receipt for ${hashes.join(", ")} is served`;
    if (!effect)
      return pending(`${consumed}; without an effect check that does not prove it never landed`);
    if (await effect(consumedBy))
      return pending(`${consumed}, but its effect is on chain at that block: it landed`);
    // One more look: the receipt may have been indexed since the first read.
    return (
      (await this.receiptOf(provider, hashes)) ?? {
        status: "not_sent",
        txHash,
        reason: `${consumed} and its effect is absent at that block; it can never land`,
      }
    );
  }

  private async receiptOf(provider: ethers.Provider, hashes: Hex[]): Promise<TxOutcome | null> {
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receiptOutcome(hash, receipt);
    }
    return null;
  }
}
