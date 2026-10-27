// TESTNET ONLY. An operator-driven test solver for ONE order on the staging
// Canton corridor: Base Sepolia USDC -> Canton TestNet Canton Coin (CC) through
// the M6 escrow (Riddler #1356, runbook docs/operations/guides/canton-testnet-e2e.md).
// It refuses any origin other than Base Sepolia (84532), any destination other
// than Canton TestNet (4149314359), and an RPC that is not Base Sepolia.
//
//   npm run example:canton -w @xochi/solver-sdk                         # bid, wait for the award
//   npm run example:canton -w @xochi/solver-sdk -- --update-id <id>     # id known up front
//   npm run example:canton -w @xochi/solver-sdk -- --resume <award.json>
//
// 1. Register on the venue's SolverBond (SolverSession) and print the standing.
// 2. Long-poll the feed (HttpSolverTransport) and bid a firm SolverBid v2 on
//    each quote-through announcement for the corridor, at CC_PER_USDC, with
//    `validUntilMs >= minValidUntilMs`.
// 3. On this solver's award, print what the operator sends BY HAND from the
//    Metatarz wallet (recipient party, CC amount on the 10-dp grid, deadline),
//    then read the Canton `update_id` (`--update-id`, or stdin).
// 4. POST the `canton_update` fill receipt: 202 attested or deferred; 422
//    `canton_delivery_refused` is permanent for THAT update (paste another);
//    503 is retried after `Retry-After`.
// 5. Poll `GET /solver/attestations/:orderId` until attested, verify it
//    (`verifyAttestation`), and send `claim(orderId, proof)` on the Base
//    Sepolia RiddlerEscrow from SOLVER_PRIVATE_KEY (viem). Print the tx and the
//    lock's final status.
//
// There is no FillAcceptance step: a Canton grant carries no FillAuth (there
// is no RiddlerFiller on Canton), so there is nothing to co-sign or slash.
// The award is written to AWARD_DIR/canton-award-<orderId>.json before the
// delivery prompt; `--resume` picks the run up from there after a crash.
//
// ENVIRONMENT (all checked before the first request):
//   RIDDLER_SOLVER_URL   venue origin; https, or http on loopback only
//   SOLVER_PRIVATE_KEY   0x + 64 hex: the TESTNET external_solver key. Signs the
//                        registration and bids, and sends the claim (needs Base
//                        Sepolia ETH for gas).
//   SOLVER_BOND          SolverBond the key staked on; default the M6.2 testnet bond
//   BOND_CHAIN_ID        default 84532; anything else is refused
//   ORIGIN_RPC_URL       Base Sepolia RPC; default https://sepolia.base.org
//   ORIGIN_ESCROW        the RiddlerEscrow this run trusts; default the M6.2 v2 escrow
//   CC_PER_USDC          firm rate, decimal (e.g. 6.5); unset = bid exactly minOutput
//   MIN_EXCLUSIVE_MS     shortest exclusive window accepted; default 600000 (10 min
//                        for a manual transfer). The receipt must be posted inside it.
//   VALIDITY_MARGIN_MS   bid validUntilMs = minValidUntilMs + this; default 60000
//   ATTESTATION_TIMEOUT_MS  give up polling the attestation after this; default 3600000
//   AWARD_DIR            where the award file is written; default the working directory

import { readFileSync, realpathSync, writeFileSync } from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import { setTimeout as delay } from "timers/promises";
import { pathToFileURL } from "url";
import type { Wallet } from "ethers";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseEventLogs,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  ATTESTED_FILL_VERIFIER_ABI,
  AwardSchema,
  HttpSolverTransport,
  IntentAnnouncementSchema,
  LockStatus,
  MAX_BID_MS,
  RIDDLER_ESCROW_ABI,
  SOLVER_RFC_VERSION,
  VenueVersionSkewError,
  signBid,
  verifyAttestation,
  walletFromKey,
  type Award,
  type BidDraft,
  type FillReceipt,
  type IntentAnnouncement,
} from "../src/index";
import { assertKeyShape, assertVenueUrl, tame } from "./env";

export const BASE_SEPOLIA = 84_532;
export const CANTON_TESTNET = 4_149_314_359;
export const CANTON_MAINNET = 253_340_876;
// Circle's Base Sepolia USDC, 6 dp. Canton Coin is 10 dp on the ledger.
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;
export const CC_DECIMALS = 10;
// The M6.2 testnet deployment (escrow-testnet-run.md, canton-testnet-e2e.md §1-2).
export const DEFAULT_ESCROW = "0x8F45d6F7Fe17ea91B75EC6A6f009f98bd24fCF66";
export const DEFAULT_BOND = "0xA6902450bC7eEC58Ea19D8a9674796Ce1DD7F1E0";
export const DEFAULT_ORIGIN_RPC = "https://sepolia.base.org";

const ZERO_ORDER_ID = "0x" + "00".repeat(32);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ESCROW_ABI = parseAbi(RIDDLER_ESCROW_ABI);
const VERIFIER_ABI = parseAbi(ATTESTED_FILL_VERIFIER_ABI);

export interface Rate {
  num: bigint;
  den: bigint;
  text: string;
}

export interface CantonTestSolverConfig {
  venueUrl: string;
  solverKey: Hex;
  bond: { chainId: number; address: Hex };
  originRpcUrl: string;
  escrow: Hex;
  ccPerUsdc?: Rate; // unset: bid exactly the announced minOutput
  minExclusiveMs: number;
  validityMarginMs: number;
  attestationPollMs: number;
  attestationTimeoutMs: number;
  fillRetries: number; // 503 resubmissions of one receipt
  awardDir: string;
  chainPollMs: number; // viem receipt polling
}

// What the operator sees and types. Injectable so the test drives it.
export interface OperatorIo {
  say(line: string): void;
  // One line from the operator, or undefined at end of input.
  ask(prompt: string): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CantonTestSolverDeps {
  io: OperatorIo;
  // Overrides the Base Sepolia RPC transport (tests stub viem here).
  originTransport?: Transport;
  signal?: AbortSignal;
}

export interface RunOptions {
  updateId?: string; // the Canton update id, when known before the award
  resume?: string; // an award file a previous run wrote
}

// The order this solver won and must deliver on Canton TestNet.
export interface CantonDelivery {
  orderId: Hex;
  auctionId: string;
  intentId: string;
  escrow: Hex;
  recipient: string; // Canton party, verbatim (case-sensitive)
  instrument: string; // the CC instrument admin, verbatim
  amountUnits: bigint; // CC base units (10 dp) the attester requires at least
  fillDeadline: number; // unix seconds: the delivery's record time must be <= this
  exclusiveUntilMs: number; // receipt intake closes here
}

export interface CantonTestSolverResult {
  delivery: CantonDelivery;
  updateId: string;
  claimTx: Hex;
  lockStatus: number;
}

interface AwardFile {
  announcement: IntentAnnouncement;
  bid: { output: string; validUntilMs: number; minExclusiveMs: number };
  award: Award;
}

// ---------------------------------------------------------------------------
// Configuration and the testnet guard

export function parseRate(text: string): Rate {
  const m = /^(\d{1,12})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) throw new Error(`CC_PER_USDC must be a positive decimal (e.g. 6.5); got ${tame(text)}`);
  const frac = m[2] ?? "";
  const den = 10n ** BigInt(frac.length);
  const num = BigInt(m[1]! + frac);
  if (num === 0n) throw new Error("CC_PER_USDC must be positive");
  return { num, den, text: text.trim() };
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw.trim()))) {
    throw new Error(`${name} must be a non-negative integer; got ${tame(raw)}`);
  }
  return Number(raw.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CantonTestSolverConfig {
  const venueUrl = env.RIDDLER_SOLVER_URL;
  if (!venueUrl) throw new Error("RIDDLER_SOLVER_URL is required (the venue origin)");
  const solverKey = env.SOLVER_PRIVATE_KEY;
  if (!solverKey)
    throw new Error("SOLVER_PRIVATE_KEY is required (the TESTNET external_solver key)");
  assertKeyShape("SOLVER_PRIVATE_KEY", solverKey);
  const bondAddress = env.SOLVER_BOND || DEFAULT_BOND;
  const escrow = env.ORIGIN_ESCROW || DEFAULT_ESCROW;
  if (!ADDRESS.test(bondAddress))
    throw new Error(`SOLVER_BOND is not an address: ${tame(bondAddress)}`);
  if (!ADDRESS.test(escrow)) throw new Error(`ORIGIN_ESCROW is not an address: ${tame(escrow)}`);
  const cfg: CantonTestSolverConfig = {
    venueUrl,
    solverKey: solverKey as Hex,
    bond: { chainId: envNumber(env, "BOND_CHAIN_ID", BASE_SEPOLIA), address: bondAddress as Hex },
    originRpcUrl: env.ORIGIN_RPC_URL || DEFAULT_ORIGIN_RPC,
    escrow: escrow as Hex,
    ccPerUsdc: env.CC_PER_USDC ? parseRate(env.CC_PER_USDC) : undefined,
    minExclusiveMs: envNumber(env, "MIN_EXCLUSIVE_MS", 600_000),
    validityMarginMs: envNumber(env, "VALIDITY_MARGIN_MS", 60_000),
    attestationPollMs: 15_000,
    attestationTimeoutMs: envNumber(env, "ATTESTATION_TIMEOUT_MS", 3_600_000),
    fillRetries: 12,
    awardDir: env.AWARD_DIR || process.cwd(),
    chainPollMs: 4_000,
  };
  assertTestnetOnly(cfg);
  return cfg;
}

// Static half of the guard: every chain id this run touches is a testnet, and
// the origin RPC is not named as a mainnet endpoint. The live half is
// `assertOriginIsBaseSepolia`, which asks the RPC itself.
export function assertTestnetOnly(cfg: CantonTestSolverConfig): void {
  if (cfg.bond.chainId !== BASE_SEPOLIA) {
    throw new Error(
      `TESTNET ONLY: the bond must be on Base Sepolia (${BASE_SEPOLIA}); got BOND_CHAIN_ID=${cfg.bond.chainId}`,
    );
  }
  let rpc: URL;
  try {
    rpc = new URL(cfg.originRpcUrl);
  } catch {
    throw new Error(`ORIGIN_RPC_URL is not a URL: ${tame(cfg.originRpcUrl)}`);
  }
  if (/mainnet/i.test(rpc.href)) {
    throw new Error(`TESTNET ONLY: ORIGIN_RPC_URL names a mainnet endpoint (${tame(rpc.host)})`);
  }
}

export async function assertOriginIsBaseSepolia(
  getChainId: () => Promise<number>,
  url: string,
): Promise<void> {
  const chainId = await getChainId();
  if (chainId !== BASE_SEPOLIA) {
    throw new Error(
      `TESTNET ONLY: ORIGIN_RPC_URL ${tame(url)} answers chain ${chainId}, not Base Sepolia (${BASE_SEPOLIA})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pricing

// A firm bid for a corridor announcement, or the reason this script passes.
export function priceBid(
  a: IntentAnnouncement,
  cfg: Pick<CantonTestSolverConfig, "ccPerUsdc" | "minExclusiveMs" | "validityMarginMs">,
): BidDraft | { pass: string } {
  if (a.toChainId === CANTON_MAINNET) return { pass: "Canton MainNet destination (TESTNET ONLY)" };
  if (a.fromChainId !== BASE_SEPOLIA)
    return { pass: `origin ${a.fromChainId} is not Base Sepolia` };
  if (a.toChainId !== CANTON_TESTNET)
    return { pass: `destination ${a.toChainId} is not Canton TestNet` };
  if (a.quoteThrough !== true || a.minValidUntilMs === undefined)
    return { pass: "not a quote-through announcement" };
  if (a.orderId === ZERO_ORDER_ID) return { pass: "no escrow order" };
  const usdc = a.fromToken.toLowerCase();
  if (usdc !== BASE_SEPOLIA_USDC.toLowerCase() && usdc !== "usdc")
    return { pass: `origin token ${tame(a.fromToken)} is not Base Sepolia USDC` };
  if (a.swapKind !== "exact_input" || a.fromAmount === undefined)
    return { pass: "not exact_input" };

  const floor = BigInt(a.minOutput);
  const output = cfg.ccPerUsdc
    ? (BigInt(a.fromAmount) * cfg.ccPerUsdc.num * 10n ** BigInt(CC_DECIMALS - USDC_DECIMALS)) /
      cfg.ccPerUsdc.den
    : floor;
  if (output < floor) {
    return {
      pass: `our price ${formatCc(output)} CC is below the floor ${formatCc(floor)} CC`,
    };
  }
  const validUntilMs = a.minValidUntilMs + cfg.validityMarginMs;
  if (validUntilMs > MAX_BID_MS) return { pass: "minValidUntilMs is out of range" };
  return { output: output.toString(), validUntilMs, minExclusiveMs: cfg.minExclusiveMs };
}

// CC base units on the ledger's 10-dp grid, every digit shown.
export function formatCc(units: bigint): string {
  const scale = 10n ** BigInt(CC_DECIMALS);
  return `${units / scale}.${(units % scale).toString().padStart(CC_DECIMALS, "0")}`;
}

// ---------------------------------------------------------------------------
// The award

// Everything the delivery depends on, checked against what this script bid.
// The venue's word is bounded by our own: the escrow pays at most our output,
// so a larger `output` here is refused rather than delivered.
export function deliveryFor(
  award: Award,
  announcement: IntentAnnouncement,
  bidOutput: string,
  escrow: string,
): CantonDelivery {
  const fail = (why: string): never => {
    throw new Error(`refusing award ${tame(award.auctionId)}: ${why}`);
  };
  const e = award.escrow ?? fail("no escrow envelope");
  const opening = e.destOpening ?? fail("no destOpening (recipient party and CC floor)");
  const terms = e.orderTerms ?? fail("no orderTerms");
  if (award.auctionId !== announcement.auctionId) fail("auctionId differs from the bid's");
  if (award.intentId !== announcement.intentId) fail("intentId differs from the bid's");
  if (e.intentRef.toLowerCase() !== announcement.orderId) fail("orderId differs from the bid's");
  if (e.address.toLowerCase() !== escrow.toLowerCase())
    fail(`escrow ${tame(e.address)} is not ORIGIN_ESCROW ${escrow}`);
  if (terms.escrow.toLowerCase() !== escrow.toLowerCase()) fail("orderTerms name another escrow");
  if (terms.fromChainId !== String(BASE_SEPOLIA)) fail(`origin chain ${terms.fromChainId}`);
  if (terms.toChainId !== String(CANTON_TESTNET))
    fail(`destination chain ${terms.toChainId} (TESTNET ONLY)`);
  if (opening.toToken !== announcement.toToken)
    fail(`instrument ${tame(opening.toToken)} is not the announced ${tame(announcement.toToken)}`);
  if (e.fillAuth?.signature)
    fail("it carries a signed FillAuth: this is not a Canton award, use escrow-solver.ts");
  const output = BigInt(award.output);
  if (output > BigInt(bidOutput)) fail(`output ${award.output} exceeds our bid ${bidOutput}`);
  const floor = BigInt(opening.toAmount);
  return {
    orderId: announcement.orderId as Hex,
    auctionId: award.auctionId,
    intentId: award.intentId,
    escrow: e.address as Hex,
    recipient: opening.recipient,
    instrument: opening.toToken,
    // The attester requires max(grant amount, committed floor); the grant is
    // the settled `output` (second price).
    amountUnits: output > floor ? output : floor,
    fillDeadline: Number(terms.fillDeadline),
    exclusiveUntilMs: award.exclusiveUntil,
  };
}

function printDelivery(io: OperatorIo, d: CantonDelivery): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  const lastCall = Math.min(d.exclusiveUntilMs, d.fillDeadline * 1000);
  const minutes = Math.floor((lastCall - io.now()) / 60_000);
  io.say("");
  io.say("================ SEND BY HAND (Metatarz wallet, Canton TestNet) ================");
  io.say(`  recipient party : ${d.recipient}`);
  io.say(`  amount          : ${formatCc(d.amountUnits)} CC  (${d.amountUnits} base units, 10 dp)`);
  io.say(`  instrument      : ${d.instrument}`);
  io.say(`  deadline        : ${iso(lastCall)}  (~${minutes} min from now)`);
  io.say(`                    delivery record time <= fillDeadline ${iso(d.fillDeadline * 1000)},`);
  io.say(`                    receipt posted before exclusiveUntil ${iso(d.exclusiveUntilMs)}`);
  io.say(`  order           : ${d.orderId}  intent ${tame(d.intentId)}`);
  io.say("  Copy the party byte for byte (it is case-sensitive). Send at least the amount.");
  io.say("================================================================================");
}

// The update id travels verbatim: never trimmed, case-folded or re-encoded
// (SOLVER-RFC §6). A pasted value with surrounding whitespace is refused here
// instead of being "fixed", which is what the venue would answer 400.
async function askUpdateId(io: OperatorIo, prompt: string): Promise<string> {
  for (;;) {
    const line = await io.ask(prompt);
    if (line === undefined) throw new Error("no Canton update id given (end of input)");
    if (line.length === 0) continue;
    if (line !== line.trim()) {
      io.say("  the update id has leading/trailing whitespace; paste it exactly");
      continue;
    }
    return line;
  }
}

// ---------------------------------------------------------------------------
// The fill receipt (POST /solver/fills)

export type FillAnswer = { status: "accepted" } | { status: "refused"; reason: string };

// One `canton_update` receipt, with the venue's three answers: 202 attested
// or deferred (the escrow node retries a deferral itself); 422
// `canton_delivery_refused`, permanent for this update (`details.reason`
// names the failed check); 503, nothing recorded, resubmitted after
// `Retry-After`. A 401 re-registers once (the session expired or rotated).
export async function postFillReceipt(
  transport: HttpSolverTransport,
  venueUrl: string,
  receipt: FillReceipt,
  io: OperatorIo,
  retries: number,
): Promise<FillAnswer> {
  const url = `${venueUrl.replace(/\/$/, "")}/solver/fills`;
  const send = async (token: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(receipt),
      signal: AbortSignal.timeout(15_000),
    });
  for (let attempt = 1; ; attempt++) {
    const token = await transport.session.token();
    let res = await send(token);
    if (res.status === 401) {
      await res.body?.cancel();
      transport.session.invalidate(token);
      res = await send(await transport.session.token());
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      details?: { reason?: unknown; retry_after?: unknown };
    };
    const what = `${res.status} ${body.error ?? ""}: ${tame(body.message ?? "", 240)}`;
    if (res.status === 202) {
      io.say(
        "fill receipt 202: recorded -- attested now, or deferred and retried by the escrow node",
      );
      return { status: "accepted" };
    }
    if (res.status === 422 && body.error === "canton_delivery_refused") {
      const reason = String(body.details?.reason ?? "unspecified");
      io.say(
        `fill receipt 422 canton_delivery_refused (${tame(reason)}): permanent for this update`,
      );
      return { status: "refused", reason };
    }
    if (res.status === 503 && attempt <= retries) {
      const header = Number(res.headers.get("retry-after"));
      const detail = Number(body.details?.retry_after);
      const waitS = Number.isFinite(header) && header > 0 ? header : detail > 0 ? detail : 5;
      io.say(
        `fill receipt ${what} -- nothing recorded; resubmitting in ${waitS}s (${attempt}/${retries})`,
      );
      await io.sleep(waitS * 1000);
      continue;
    }
    throw new Error(`fill receipt refused: ${what}`);
  }
}

// ---------------------------------------------------------------------------
// The run

export async function runCantonTestSolver(
  cfg: CantonTestSolverConfig,
  deps: CantonTestSolverDeps,
  opts: RunOptions = {},
): Promise<CantonTestSolverResult> {
  const { io } = deps;
  assertTestnetOnly(cfg);
  assertVenueUrl(cfg.venueUrl, io.say);
  const originTransport = deps.originTransport ?? http(cfg.originRpcUrl);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: originTransport,
    pollingInterval: cfg.chainPollMs,
  });
  await assertOriginIsBaseSepolia(() => publicClient.getChainId(), cfg.originRpcUrl);

  const solverWallet = walletFromKey(cfg.solverKey);
  const solverId = solverWallet.address;
  io.say(`TESTNET ONLY  solver ${solverId}  venue ${tame(cfg.venueUrl)}`);
  const transport = new HttpSolverTransport({
    baseUrl: cfg.venueUrl,
    solverKey: cfg.solverKey,
    bond: cfg.bond,
    onFeedGap: (gap) =>
      io.say(`feed gap: dropped ${gap.dropped}, reset ${gap.reset} -- intents were missed`),
  });

  const caps = await transport.getCapabilities(deps.signal);
  if (caps.rfcVersion !== SOLVER_RFC_VERSION) throw new VenueVersionSkewError(caps.rfcVersion);
  const advertised = caps.admission?.bond;
  if (!advertised) throw new Error("the venue advertises no SolverBond: registration is closed");
  if (
    advertised.chainId !== cfg.bond.chainId ||
    advertised.address.toLowerCase() !== cfg.bond.address.toLowerCase()
  ) {
    throw new Error(
      `the venue's bond is ${advertised.address} on ${advertised.chainId}, not SOLVER_BOND ${cfg.bond.address}`,
    );
  }
  const listed = caps.quoteThrough?.corridors?.some(
    (c) => c.fromChainId === BASE_SEPOLIA && c.toChainId === CANTON_TESTNET,
  );
  if (!listed) io.say("WARNING the venue lists no quote-through corridor 84532 -> 4149314359");

  const reg = await transport.register(deps.signal);
  const r = reg.reputation;
  io.say(
    `registered: eligible ${r.eligible}, probation ${r.probation}, bond $${r.bondUsd}, ` +
      `exposure $${r.inFlightUsd}/$${r.exposureCapUsd}, fills ${r.fillSuccessRate}, ` +
      `no-shows ${r.noShowRate}; session until ${new Date(reg.expiresAtMs).toISOString()}`,
  );
  if (!r.eligible) throw new Error("the venue does not admit this solver (eligible: false)");

  const won = opts.resume
    ? readAwardFile(opts.resume)
    : await bidUntilAwarded(cfg, deps, transport, solverWallet);
  const delivery = deliveryFor(won.award, won.announcement, won.bid.output, cfg.escrow);
  if (!opts.resume) writeAwardFile(cfg.awardDir, delivery.orderId, won, io);

  // The lock must be open on the escrow this run trusts, for this corridor.
  const lock = await readLock(publicClient, cfg.escrow, delivery.orderId);
  if (lock.status !== LockStatus.Open) {
    throw new Error(
      `lock ${delivery.orderId} is not Open on ${cfg.escrow} (status ${lock.status})`,
    );
  }
  if (lock.toChainId !== BigInt(CANTON_TESTNET))
    throw new Error(`lock delivers to chain ${lock.toChainId}, not Canton TestNet (TESTNET ONLY)`);

  printDelivery(io, delivery);
  let updateId = opts.updateId ?? (await askUpdateId(io, "Canton update_id of the transfer: "));
  for (;;) {
    const receipt: FillReceipt = {
      auctionId: delivery.auctionId,
      intentId: delivery.intentId,
      solverId,
      proof: { kind: "canton_update", updateId },
    };
    const answer = await postFillReceipt(transport, cfg.venueUrl, receipt, io, cfg.fillRetries);
    if (answer.status === "accepted") break;
    if (opts.updateId !== undefined) {
      throw new Error(`the venue refused update ${tame(updateId)}: ${tame(answer.reason)}`);
    }
    updateId = await askUpdateId(io, "Paste ANOTHER update_id for this order (Ctrl-C to stop): ");
  }

  // Attestation: 404 means "not yet" (and "not yours"); poll until it lands,
  // the lock's claim margin, or the timeout.
  const deadlineMs = Math.min(
    io.now() + cfg.attestationTimeoutMs,
    Number(lock.refundableAt) * 1000 - 60_000,
  );
  let wire = await transport.getAttestation(delivery.orderId, deps.signal);
  while (!wire) {
    if (io.now() >= deadlineMs) {
      throw new Error(
        `no attestation for ${delivery.orderId} by ${new Date(deadlineMs).toISOString()}; ` +
          "re-run with --resume to keep waiting (the lock refunds at refundableAt)",
      );
    }
    io.say("attestation not yet served; polling");
    await io.sleep(cfg.attestationPollMs);
    wire = await transport.getAttestation(delivery.orderId, deps.signal);
  }
  const { proof, attester } = verifyAttestation(wire, {
    orderId: delivery.orderId,
    payee: solverId,
    originChainId: BASE_SEPOLIA,
    verifier: lock.verifier,
  });
  const active = await publicClient.readContract({
    address: lock.verifier,
    abi: VERIFIER_ABI,
    functionName: "isAttester",
    args: [attester as Hex],
  });
  if (!active)
    throw new Error(`attestation signer ${attester} is not an attester on ${lock.verifier}`);
  io.say(`attested by ${attester} for payee ${wire.payee}`);

  const claimsPaused = await publicClient.readContract({
    address: cfg.escrow,
    abi: ESCROW_ABI,
    functionName: "claimsPaused",
  });
  if (claimsPaused) throw new Error("claims are paused on the escrow; re-run with --resume later");

  const account = privateKeyToAccount(cfg.solverKey);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: originTransport,
  });
  const { request } = await publicClient.simulateContract({
    account,
    address: cfg.escrow,
    abi: ESCROW_ABI,
    functionName: "claim",
    args: [delivery.orderId, proof],
  });
  const claimTx = await walletClient.writeContract(request);
  io.say(`claim sent: ${claimTx}`);
  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTx });
  const claimed = parseEventLogs({ abi: ESCROW_ABI, eventName: "Claimed", logs: txReceipt.logs });
  const after = await readLock(publicClient, cfg.escrow, delivery.orderId);
  io.say(
    `claim ${txReceipt.status} in block ${txReceipt.blockNumber}; lock status ` +
      (Object.entries(LockStatus).find(([, v]) => v === after.status)?.[0] ?? after.status) +
      (claimed[0]
        ? `; Claimed payee ${claimed[0].args.payee} payout ${claimed[0].args.payout} fee ${claimed[0].args.fee}`
        : ""),
  );
  if (txReceipt.status !== "success") throw new Error(`claim ${claimTx} reverted`);
  return { delivery, updateId, claimTx, lockStatus: after.status };
}

// Bid on every corridor announcement until this solver's award arrives. Own
// loop rather than `SolverClient.run`: the run ends at the first award, and
// the fill is a human transfer, not a `Solver.fill`.
async function bidUntilAwarded(
  cfg: CantonTestSolverConfig,
  deps: CantonTestSolverDeps,
  transport: HttpSolverTransport,
  wallet: Wallet,
): Promise<AwardFile> {
  const { io } = deps;
  const bids = new Map<string, Omit<AwardFile, "award">>();
  io.say("listening for quote-through announcements 84532 -> 4149314359");
  for await (const event of transport.events(deps.signal)) {
    if (event.type === "announcement") {
      const a = event.announcement;
      if (io.now() >= a.closesAt) continue;
      const draft = priceBid(a, cfg);
      if ("pass" in draft) {
        io.say(`pass ${tame(a.auctionId)}: ${draft.pass}`);
        continue;
      }
      const bid = await signBid(wallet, a, draft);
      // One refused bid (a closed window, a busy engine) is that auction lost,
      // not the run: report it and keep listening.
      try {
        await transport.submitBid(bid);
      } catch (err) {
        io.say(`bid  ${tame(a.auctionId)} refused: ${tame(String(err), 240)}`);
        continue;
      }
      bids.set(a.auctionId, { announcement: a, bid: draft });
      io.say(
        `bid  ${tame(a.auctionId)}: ${formatCc(BigInt(draft.output))} CC for ` +
          `${formatUnits(BigInt(a.fromAmount ?? "0"), USDC_DECIMALS)} USDC ` +
          `(floor ${formatCc(BigInt(a.minOutput))}), ` +
          `valid until ${new Date(draft.validUntilMs).toISOString()}`,
      );
      continue;
    }
    const award = event.award;
    if (award.solverId.toLowerCase() !== wallet.address.toLowerCase()) continue;
    const ours = bids.get(award.auctionId);
    if (!ours) {
      io.say(`award ${tame(award.auctionId)} for a bid this process did not place; ignored`);
      continue;
    }
    io.say(`AWARD ${tame(award.auctionId)}: output ${formatCc(BigInt(award.output))} CC`);
    return { ...ours, award };
  }
  throw new Error("the feed ended before an award arrived");
}

function writeAwardFile(dir: string, orderId: string, won: AwardFile, io: OperatorIo): void {
  const file = path.join(dir, `canton-award-${orderId}.json`);
  writeFileSync(file, JSON.stringify(won, null, 2) + "\n", { mode: 0o600 });
  io.say(`award saved to ${file} (resume with --resume ${file})`);
}

function readAwardFile(file: string): AwardFile {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AwardFile>;
  if (!raw.bid || typeof raw.bid.output !== "string") throw new Error(`${file}: no bid`);
  return {
    announcement: IntentAnnouncementSchema.parse(raw.announcement),
    award: AwardSchema.parse(raw.award),
    bid: raw.bid,
  };
}

interface LockView {
  status: number;
  toChainId: bigint;
  verifier: Hex;
  refundableAt: bigint;
}

async function readLock(
  client: PublicClient<Transport, typeof baseSepolia>,
  escrow: Hex,
  orderId: Hex,
): Promise<LockView> {
  const [, refundableAt, , status, , toChainId, verifier] = await client.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "locks",
    args: [orderId],
  });
  return { status, toChainId, verifier, refundableAt };
}

// ---------------------------------------------------------------------------
// CLI

export function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--update-id" && value !== undefined) {
      opts.updateId = value;
      i++;
    } else if (arg === "--resume" && value !== undefined) {
      opts.resume = value;
      i++;
    } else {
      throw new Error(`unknown argument ${tame(arg ?? "")}; see the header of this file`);
    }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: OperatorIo = {
    say: (line) => console.log(line),
    ask: async (prompt) => {
      try {
        return await rl.question(prompt);
      } catch {
        return undefined; // stdin closed
      }
    },
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
  };
  try {
    const result = await runCantonTestSolver(
      loadConfig(),
      { io },
      parseArgs(process.argv.slice(2)),
    );
    io.say(`done: order ${result.delivery.orderId} claimed in ${result.claimTx}`);
    rl.close();
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    rl.close();
    process.exit(1);
  }
}
