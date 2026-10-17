// SOLVER_STATE_FILE for examples/escrow-solver.ts: the orders a restart
// resumes (`FillStateFile`), and the lease that keeps the file one process's
// (`StateLock`). Split out so the reference solver reads on its own; nothing
// here knows about awards beyond the `PreparedFill` it stores.

import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { randomUUID } from "crypto";
import { hostname } from "os";
import { dirname, resolve } from "path";
import type { IntentAnnouncement, PreparedFill } from "../src/index";

const say = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One order this solver is accepting (`accepting`: written before `accept`
// runs; nothing has reached the venue), accepted (`accepted`: written from
// `onSigned`, after signing and before the POST, so the signature may have
// been sent and the fill is owed) or filled and has not seen claimed
// (`filled`: the claim repays it), as SOLVER_STATE_FILE keeps it for
// `EscrowSolver.resume`.
export interface PersistedFill {
  auctionId: string;
  announcement: IntentAnnouncement;
  output: string;
  prepared: PreparedFill;
  phase: "accepting" | "accepted" | "filled";
}

// SOLVER_STATE_FILE's orders, read without taking its lock: inspection only.
// A file that does not exist holds none; an entry that does not decode is
// logged and skipped (`parseFillStateFile`).
export function readFillStateFile(path: string, log: (msg: string) => void = say): PersistedFill[] {
  return parseFillStateFile(path, log).fills;
}

const PHASES: readonly string[] = ["accepting", "accepted", "filled"];

// Where a PreparedFill holds a bigint, or a uint that may be one: the only
// places a `{ "$bigint": "<decimal>" }` is revived. The first nine are bigints
// in every PreparedFill, so an entry lacking one is not a PreparedFill.
const BIGINT_PATHS = [
  "originChainId",
  "destinationChainId",
  "bidOutput",
  "acceptBy",
  "fillAuthDomain.chainId",
  "bondDomain.chainId",
  "lock.amount",
  "lock.toChainId",
  "lock.refundableAt",
  "terms.fromChainId",
  "terms.fromAmount",
  "terms.toChainId",
  "terms.fillDeadline",
  "opening.toAmount",
  "fillAuth.amount",
  "fillAuth.deadline",
];
const REQUIRED_BIGINTS = 9;

// Every entry is decoded on its own, so one that does not decode (a value
// this file never wrote, a hand edit, a field an older version persisted) is
// logged loudly and skipped -- NOT resumed, and kept in the file as it was
// for a human -- rather than refusing the whole file and with it every other
// order's owed fill or claim. Its order is still this solver's, maybe accepted
// or filled under some fillId, so its lowercased orderId is returned in
// `held` and no award for that order is accepted until a human resolves it.
// An entry with no string orderId cannot be held that way, so it refuses the
// file whole, as does a file that is not JSON or holds no `fills` list.
function parseFillStateFile(
  path: string,
  log: (msg: string) => void,
): { fills: PersistedFill[]; unreadable: unknown[]; held: Set<string> } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { fills: [], unreadable: [], held: new Set() };
    throw new Error(`SOLVER_STATE_FILE ${path}: ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `SOLVER_STATE_FILE ${path} is not JSON (${errorText(err)}); restore it, or move it aside by hand`,
    );
  }
  const raw = isRecord(parsed) ? parsed.fills : undefined;
  if (!Array.isArray(raw)) throw new Error(`SOLVER_STATE_FILE ${path} holds no \`fills\` list`);
  const fills: PersistedFill[] = [];
  const unreadable: unknown[] = [];
  const held = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    try {
      fills.push(decodeEntry(structuredClone(entry)));
    } catch (err) {
      const orderId =
        isRecord(entry) && isRecord(entry.prepared) ? entry.prepared.orderId : undefined;
      if (typeof orderId !== "string") {
        throw new Error(
          `SOLVER_STATE_FILE ${path}: entry ${i} does not decode (${errorText(err)}) and names no orderId, so no award ` +
            `for its order could be refused; resolve it by hand`,
        );
      }
      unreadable.push(entry);
      held.add(orderId.toLowerCase());
      log(
        `SOLVER_STATE_FILE ${path}: entry ${i} (order ${orderId}) does not decode (${errorText(err)}): ` +
          `NOT resumed, kept in the file as it is, and every award for the order refused -- resolve it by hand`,
      );
    }
  });
  return { fills, unreadable, held };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function decodeEntry(entry: unknown): PersistedFill {
  if (!isRecord(entry) || typeof entry.auctionId !== "string" || typeof entry.output !== "string")
    throw new Error("no auctionId or output");
  if (typeof entry.phase !== "string" || !PHASES.includes(entry.phase))
    throw new Error(`phase ${String(entry.phase)}`);
  if (!isRecord(entry.announcement)) throw new Error("no announcement");
  const prepared = entry.prepared;
  if (
    !isRecord(prepared) ||
    typeof prepared.orderId !== "string" ||
    typeof prepared.fillId !== "string"
  )
    throw new Error("no orderId or fillId");
  BIGINT_PATHS.forEach((path, i) => {
    const [head = "", leaf] = path.split(".");
    const holder = leaf === undefined ? prepared : prepared[head];
    const key = leaf ?? head;
    if (!isRecord(holder)) throw new Error(`no prepared.${head}`);
    const value = holder[key];
    const tagged = isRecord(value) && Object.keys(value).length === 1 ? value.$bigint : undefined;
    if (typeof tagged === "string" && /^\d+$/.test(tagged)) holder[key] = BigInt(tagged);
    else if (
      i < REQUIRED_BIGINTS ||
      !(
        (typeof value === "string" && /^\d+$/.test(value)) ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      )
    ) {
      throw new Error(`prepared.${path} is ${JSON.stringify(value)}, not a decimal`);
    }
  });
  // A file an earlier version wrote may still carry the announcement's
  // `recipientCommitment`, withdrawn in RFC 0.5.0-draft. It is dropped here,
  // so it is neither handed back to the solver nor written out again.
  delete entry.announcement.recipientCommitment;
  // Checked above wherever the solver needs a bigint or a container; the rest
  // is this file's own output.
  const decoded = entry as unknown as PersistedFill;
  return decoded;
}

// Exactly the fields the solver reads back, copied one by one: the venue's
// announcement and order terms are parsed passthrough, so keys the model does
// not know survive into them, and nothing the venue sent beyond the model is
// written here.
function persistable(e: PersistedFill): PersistedFill {
  const { announcement: a, prepared: p } = e;
  return {
    auctionId: e.auctionId,
    announcement: {
      intentId: a.intentId,
      auctionId: a.auctionId,
      orderId: a.orderId,
      fromChainId: a.fromChainId,
      toChainId: a.toChainId,
      fromToken: a.fromToken,
      toToken: a.toToken,
      swapKind: a.swapKind,
      fromAmount: a.fromAmount,
      outputAmount: a.outputAmount,
      settlementPreference: a.settlementPreference,
      minOutput: a.minOutput,
      opensAt: a.opensAt,
      closesAt: a.closesAt,
      exclusiveWindowMs: a.exclusiveWindowMs,
    },
    output: e.output,
    prepared: {
      auctionId: p.auctionId,
      orderId: p.orderId,
      fillId: p.fillId,
      opening: {
        recipient: p.opening.recipient,
        toToken: p.opening.toToken,
        toAmount: p.opening.toAmount,
        blinding: p.opening.blinding,
        intentId: p.opening.intentId,
      },
      terms: {
        depositor: p.terms.depositor,
        fromChainId: p.terms.fromChainId,
        fromToken: p.terms.fromToken,
        fromAmount: p.terms.fromAmount,
        toChainId: p.terms.toChainId,
        fillDeadline: p.terms.fillDeadline,
        escrow: p.terms.escrow,
        destCommitment: p.terms.destCommitment,
      },
      fillAuth: {
        fillId: p.fillAuth.fillId,
        filler: p.fillAuth.filler,
        to: p.fillAuth.to,
        token: p.fillAuth.token,
        amount: p.fillAuth.amount,
        deadline: p.fillAuth.deadline,
      },
      fillAuthSignature: p.fillAuthSignature,
      fillAuthDomain: {
        chainId: p.fillAuthDomain.chainId,
        verifyingContract: p.fillAuthDomain.verifyingContract,
      },
      payee: p.payee,
      acceptBy: p.acceptBy,
      originChainId: p.originChainId,
      destinationChainId: p.destinationChainId,
      lock: {
        orderId: p.lock.orderId,
        depositor: p.lock.depositor,
        token: p.lock.token,
        amount: p.lock.amount,
        toChainId: p.lock.toChainId,
        refundableAt: p.lock.refundableAt,
        verifier: p.lock.verifier,
        blockNumber: p.lock.blockNumber,
        blockHash: p.lock.blockHash,
      },
      fillAuthSigner: p.fillAuthSigner,
      bondDomain: {
        chainId: p.bondDomain.chainId,
        verifyingContract: p.bondDomain.verifyingContract,
      },
      bidOutput: p.bidOutput,
    },
    phase: e.phase,
  };
}

// SOLVER_STATE_FILE, keyed by lowercased orderId and rewritten whole on every
// change: written to a temp file named for this process's lease, fsynced,
// renamed over the file, then the directory fsynced, so a crash leaves the old
// state or the new one and never half of either, and a power loss after `put`
// returns cannot revert it. Memory follows the disk: `put` and `remove` change
// the in-memory map only for a write that succeeded, so a failed write leaves
// `get`/`has` answering what the disk holds. Only the modelled fields are
// written (`persistable`). A PreparedFill carries bigints, which JSON has no
// spelling for: each is written as `{ "$bigint": "<decimal>" }` and revived on
// load only at the PreparedFill's own bigint fields (`BIGINT_PATHS`).
//
// Exclusive for its lifetime: two processes on one file each rewrite it from
// their own memory and silently erase each other's owed orders, so the
// constructor takes the lease `<path>.lock` (`StateLock`) and throws while
// another process holds it. Every write first checks the lease is still this
// process's; once it is found taken (this process stalled past the lease and
// a successor took over) nothing more is written, `onLeaseLost` is called --
// the script stops bidding on it -- and every later write throws. `close`
// releases the lease; after that nothing is written.
export class FillStateFile {
  private readonly fills = new Map<string, PersistedFill>();
  // Entries on disk that did not decode, written back as they were, and their
  // lowercased orderIds.
  private readonly unreadable: unknown[];
  private readonly held: ReadonlySet<string>;
  private readonly lock: StateLock;

  constructor(
    readonly path: string,
    o: { onLeaseLost?: (reason: string) => void; log?: (msg: string) => void } = {},
  ) {
    const log = o.log ?? say;
    this.lock = StateLock.acquire(`${path}.lock`, o.onLeaseLost ?? (() => {}), log);
    try {
      const { fills, unreadable, held } = parseFillStateFile(path, log);
      for (const entry of fills) this.fills.set(entry.prepared.orderId.toLowerCase(), entry);
      this.unreadable = unreadable;
      this.held = held;
    } catch (err) {
      this.lock.release();
      throw err;
    }
  }

  entries(): PersistedFill[] {
    return [...this.fills.values()];
  }

  has(orderId: string): boolean {
    return this.fills.has(orderId.toLowerCase());
  }

  get(orderId: string): PersistedFill | undefined {
    return this.fills.get(orderId.toLowerCase());
  }

  // An order whose entry on disk did not decode: it may be accepted or filled
  // under some fillId, so no award for it may be accepted.
  holdsUnreadable(orderId: string): boolean {
    return this.held.has(orderId.toLowerCase());
  }

  put(entry: PersistedFill): void {
    const key = entry.prepared.orderId.toLowerCase();
    const before = this.fills.get(key);
    this.fills.set(key, entry);
    try {
      this.write();
    } catch (err) {
      if (before) this.fills.set(key, before);
      else this.fills.delete(key);
      throw err;
    }
  }

  remove(orderId: string): void {
    const key = orderId.toLowerCase();
    const before = this.fills.get(key);
    if (!before) return;
    this.fills.delete(key);
    try {
      this.write();
    } catch (err) {
      this.fills.set(key, before);
      throw err;
    }
  }

  close(): void {
    this.lock.release();
  }

  private write(): void {
    if (this.lock.released) throw new Error(`SOLVER_STATE_FILE ${this.path} is closed`);
    this.lock.assertHeld();
    const text = JSON.stringify(
      { fills: [...this.entries().map(persistable), ...this.unreadable] },
      (_key, value) => (typeof value === "bigint" ? { $bigint: value.toString() } : value),
      2,
    );
    // Named for this lease's token, so no other process's temp file shares
    // it; created exclusively and never through a symlink: whatever sits at
    // that name (this process's own temp file from a write that failed, or
    // something planted) is unlinked first -- unlink never follows a link --
    // and anything re-planted in between fails the open instead of being
    // written through.
    const tmp = `${this.path}.${this.lock.token}.tmp`;
    try {
      unlinkSync(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    writeNewFile(tmp, text);
    renameSync(tmp, this.path);
    // The rename is durable only once the directory entry is.
    const dir = openSync(dirname(resolve(this.path)), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}

// Create `path` -- never an existing file, never through a symlink -- then
// write and fsync it. `writeSync` is one write(2), which on a nearly full
// volume returns a short count rather than ENOSPC: every byte is written, or
// it throws and the caller never renames a truncated file into place.
function writeNewFile(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const bytes = Buffer.from(text, "utf8");
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0)
        throw new Error(`writing ${path}: wrote ${offset} of ${bytes.length} bytes`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// How often the holder renews its lease on `<state>.lock`, and (x3) how long
// an unrenewed lease stands before any starter may take it over. A renewal is
// one small write and rename, so 10s costs nothing; three missed renewals
// (30s) is far past any GC pause or I/O stall a live Node process survives,
// yet bounds how long a SIGKILLed solver's replacement, waiting in-process
// (`openStateFile`), takes before it resumes the fills and claims it owes:
// at most LEASE_STALE_MS after the dead holder's last renewal.
const LEASE_RENEW_MS = 10_000;
const LEASE_STALE_MS = 3 * LEASE_RENEW_MS;

// Another process holds the lease (or took it while this one tried): this
// start may succeed later. The message names the holder; `retryInMs` is when
// to look again -- one renewal interval, or exactly when the lease as read
// goes stale if that is sooner.
export class LeaseHeldError extends Error {
  constructor(
    message: string,
    readonly retryInMs: number,
  ) {
    super(message);
  }
}

interface LockHolder {
  token: string; // per acquisition: the only thing ownership is decided by
  host: string; // host and pid are for the operator reading the lock; never consulted
  pid: number;
  renewedAt: number; // ms since the epoch, by the holder's clock
}

// The state locks this process holds, by resolved path.
const HELD_LOCKS = new Set<string>();

// `<state>.lock` is a lease: {token, host, pid, renewedAt}. It is created with
// link(2) from a fully written temp file, so it exists only whole and exactly
// one of two racing starters creates it; the holder rewrites it (temp file +
// rename) every LEASE_RENEW_MS. A lease not renewed for LEASE_STALE_MS is
// taken over by any starter, whatever host or pid it names -- neither tells
// liveness: containers on host networking share a hostname across pid
// namespaces, and a rescheduled pod's hostname changes -- and any fresher one
// refuses this attempt (`LeaseHeldError`; `openStateFile` waits and retries).
// Takeover renames the lease aside and checks it is the
// very one judged stale (same token, same renewedAt), so of two starters
// racing for one stale lease exactly one wins, and a holder that renewed in
// between keeps it.
//
// The holder checks the lease is still its own before every state write and
// every renewal. Finding it taken (it stalled past LEASE_STALE_MS: SIGSTOP, a
// suspended VM, a hung disk) it stops writing for good and reports it
// (`onLost`). This is not fencing: a write already past its check when a
// successor takes over still lands, and a stalled holder's renewal racing a
// takeover can overwrite the successor's lease -- which that successor then
// finds at its next check and stops. Either way one holder survives.
//
// `renewedAt` is wall-clock: processes sharing the volume from different
// hosts must keep their clocks closer than LEASE_STALE_MS minus the longest
// gap between two of the holder's renewals, or a starter whose clock runs
// ahead takes over a live lease. On schedule that is 20s; a failed renewal
// (retried at the next interval) or a late timer widens the gap, so after one
// failed renewal it is 10s.
// An orchestrator's stop grace period: a draining holder keeps renewing, so a
// replacement started during the drain (a rolling update with surge) waits
// until the old process exits -- releasing the lease at once -- or is
// SIGKILLed at the end of its grace, after which the replacement takes the
// lease over once LEASE_STALE_MS has passed since its last renewal.
class StateLock {
  released = false;
  private lostReason: string | null = null;
  private readonly renewal: NodeJS.Timeout;

  private constructor(
    private readonly path: string,
    private readonly key: string,
    readonly token: string,
    private readonly onLost: (reason: string) => void,
    private readonly log: (msg: string) => void,
  ) {
    this.renewal = setInterval(() => this.renew(), LEASE_RENEW_MS);
    this.renewal.unref?.();
  }

  static acquire(
    path: string,
    onLost: (reason: string) => void,
    log: (msg: string) => void,
  ): StateLock {
    const key = resolve(path);
    if (HELD_LOCKS.has(key))
      throw new Error(`SOLVER_STATE_FILE is in use: this process already holds ${path}`);
    const token = randomUUID();
    const tmp = `${path}.${token}.tmp`;
    writeNewFile(tmp, StateLock.lease(token));
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          linkSync(tmp, path);
          HELD_LOCKS.add(key);
          return new StateLock(path, key, token, onLost, log);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        const holder = readLockHolder(path);
        if (holder === "gone") continue;
        if (holder === "unreadable") {
          throw new Error(
            `SOLVER_STATE_FILE is in use: ${path} names a holder it cannot parse; remove it only once no process uses the file`,
          );
        }
        const silentMs = Date.now() - holder.renewedAt;
        if (silentMs < LEASE_STALE_MS) {
          throw new LeaseHeldError(
            `SOLVER_STATE_FILE is in use: ${path} is the lease of pid ${holder.pid} on ${holder.host}, renewed ${silentMs}ms ago. ` +
              `Two processes on one state file erase each other's owed orders; a lease not renewed for ${LEASE_STALE_MS}ms is taken over`,
            Math.min(LEASE_RENEW_MS, LEASE_STALE_MS - silentMs),
          );
        }
        log(
          `SOLVER_STATE_FILE: taking over ${path} from pid ${holder.pid} on ${holder.host}, not renewed for ${silentMs}ms`,
        );
        takeOverLock(path, holder, `${path}.${token}.stale`);
      }
      throw new LeaseHeldError(
        `SOLVER_STATE_FILE is in use: ${path} changed hands while this process started`,
        LEASE_RENEW_MS,
      );
    } finally {
      unlinkSync(tmp);
    }
  }

  private static lease(token: string): string {
    return JSON.stringify({
      token,
      host: hostname(),
      pid: process.pid,
      renewedAt: Date.now(),
    } satisfies LockHolder);
  }

  // Throws once the lock is not this lease; the first time, stops renewing
  // and reports it.
  assertHeld(): void {
    if (this.lostReason === null) {
      const holder = readLockHolder(this.path);
      if (typeof holder === "object" && holder.token === this.token) return;
      this.lostReason =
        holder === "gone"
          ? `${this.path} was removed`
          : holder === "unreadable"
            ? `${this.path} names a holder it cannot parse`
            : `${this.path} is now the lease of pid ${holder.pid} on ${holder.host}`;
      clearInterval(this.renewal);
      this.onLost(this.lostReason);
    }
    throw new Error(`SOLVER_STATE_FILE lease lost (${this.lostReason}); not writing`);
  }

  private renew(): void {
    try {
      this.assertHeld();
      const tmp = `${this.path}.${this.token}.tmp`;
      try {
        unlinkSync(tmp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      writeNewFile(tmp, StateLock.lease(this.token));
      renameSync(tmp, this.path);
    } catch (err) {
      // A lost lease was reported by `assertHeld`; anything else is retried
      // next interval, the lease standing for LEASE_STALE_MS meanwhile.
      if (this.lostReason === null)
        this.log(`SOLVER_STATE_FILE: renewing ${this.path}: ${errorText(err)}; retrying`);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    clearInterval(this.renewal);
    HELD_LOCKS.delete(this.key);
    const holder = readLockHolder(this.path);
    if (typeof holder === "object" && holder.token === this.token) unlinkSync(this.path);
  }
}

function readLockHolder(path: string): LockHolder | "gone" | "unreadable" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw err;
  }
  let holder: Partial<LockHolder> | null;
  try {
    holder = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  return typeof holder?.token === "string" &&
    typeof holder.host === "string" &&
    Number.isSafeInteger(holder.pid) &&
    Number.isSafeInteger(holder.renewedAt)
    ? (holder as LockHolder)
    : "unreadable";
}

// Move a stale lease aside and confirm it was THAT lease: two starters racing
// for one stale lease would otherwise both remove it, the second removing the
// first's fresh one, and a holder that renewed since it was read would lose a
// live lease. Anything else found aside is put back and the start refused.
function takeOverLock(path: string, stale: LockHolder, aside: string): void {
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const moved = readLockHolder(aside);
  if (
    typeof moved === "object" &&
    moved.token === stale.token &&
    moved.renewedAt === stale.renewedAt
  ) {
    unlinkSync(aside);
    return;
  }
  try {
    linkSync(aside, path);
  } catch (err) {
    // EEXIST: a third starter took it meanwhile; it refuses this start either way.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  unlinkSync(aside);
  throw new LeaseHeldError(
    `SOLVER_STATE_FILE is in use: ${path} was taken or renewed by another process while this one started`,
    LEASE_RENEW_MS,
  );
}
