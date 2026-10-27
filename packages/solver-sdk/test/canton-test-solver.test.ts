// examples/canton-test-solver.ts end to end against a stub venue (a real
// HTTP server speaking Riddler's /solver/* wire for a Canton TestNet award)
// and a stubbed Base Sepolia RPC under viem: register -> bid -> award ->
// operator update id -> canton_update receipt (503, then 422, then 202) ->
// attestation (404, then served) -> the claim transaction, decoded from the
// raw bytes the RPC received.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { ethers } from "ethers";
import { encodeAttestedProof, fillAttestationDigest } from "@xochi/signer";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
} from "viem";
import {
  ATTESTED_FILL_VERIFIER_ABI,
  IntentAnnouncementSchema,
  LockStatus,
  RIDDLER_ESCROW_ABI,
  SOLVER_RFC_VERSION,
  registrationTypedData,
  verifyBid,
  type Bid,
} from "../src/index";
import {
  BASE_SEPOLIA,
  BASE_SEPOLIA_USDC,
  CANTON_MAINNET,
  CANTON_TESTNET,
  assertTestnetOnly,
  loadConfig,
  priceBid,
  runCantonTestSolver,
  type CantonTestSolverConfig,
  type OperatorIo,
} from "../examples/canton-test-solver";

const SOLVER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SOLVER = new ethers.Wallet(SOLVER_KEY).address;
const ATTESTER = new ethers.Wallet(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);
const ESCROW = "0x8F45d6F7Fe17ea91B75EC6A6f009f98bd24fCF66";
const VERIFIER = "0x08ac08C3D4F03901cE1bc5750bDEB6362F1aC3C6";
const BOND = "0xA6902450bC7eEC58Ea19D8a9674796Ce1DD7F1E0";
const ORDER_ID = ("0x" + "ab".repeat(32)) as Hex;
const PARTY = "user_b39488aD::122005c8af01154b4e225f60aaed3899312646e31671cd4b4a2152ef8ad2247a7221";
const CC = "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337";
const GOOD_UPDATE = "1220AbCd782d268e0b6a4ff58198e69f62f81e74774f042185496786bbf936f87710eeb6";
const ESCROW_ABI = parseAbi(RIDDLER_ESCROW_ABI);
const VERIFIER_ABI = parseAbi(ATTESTED_FILL_VERIFIER_ABI);

interface Venue {
  url: string;
  bids: Bid[];
  fills: { auth: string | undefined; body: Record<string, unknown> }[];
  attestationReads: number;
  registered: number;
  close: () => Promise<void>;
}

// The announcement and award as Riddler's `Announcement.to_json/1` and
// `Award.to_json/1` serialize a Canton quote-through order (no fillAuth: a
// Canton grant has none).
function wire(nowMs: number) {
  const nowS = Math.floor(nowMs / 1000);
  const announcement = {
    intentId: "xi_canton_1",
    orderId: ORDER_ID,
    auctionId: "au_canton_1",
    fromChainId: BASE_SEPOLIA,
    toChainId: CANTON_TESTNET,
    fromToken: BASE_SEPOLIA_USDC,
    toToken: CC,
    swapKind: "exact_input",
    settlementPreference: "public",
    minOutput: "120000000000", // 12 CC
    opensAt: nowMs,
    closesAt: nowMs + 60_000,
    exclusiveWindowMs: 5_000,
    fromAmount: "2000000", // 2 USDC
    quoteThrough: true,
    minValidUntilMs: nowMs + 1_860_000,
  };
  const mainnet = {
    ...announcement,
    auctionId: "au_mainnet",
    orderId: "0x" + "cd".repeat(32),
    toChainId: CANTON_MAINNET,
  };
  const award = {
    auctionId: announcement.auctionId,
    intentId: announcement.intentId,
    solverId: SOLVER,
    output: "125000000000", // 12.5 CC: second price, under our 13
    exclusiveUntil: nowMs + 600_000,
    escrow: {
      address: ESCROW,
      intentRef: ORDER_ID,
      fillId: "0x" + "11".repeat(32),
      orderTerms: {
        depositor: "0xb39488aD9877DD84FBF922Ae7617dca8846DCa7b",
        fromChainId: String(BASE_SEPOLIA),
        fromToken: BASE_SEPOLIA_USDC,
        fromAmount: "2000000",
        toChainId: String(CANTON_TESTNET),
        fillDeadline: String(nowS + 1_800),
        escrow: ESCROW,
        destCommitment: "0x" + "22".repeat(32),
      },
      destOpening: {
        recipient: PARTY,
        toToken: CC,
        toAmount: "120000000000",
        blinding: "0x" + "33".repeat(32),
        intentId: announcement.intentId,
      },
      bond: { chainId: String(BASE_SEPOLIA), address: BOND },
      acceptBy: String(nowS + 30),
    },
  };
  return { announcement, mainnet, award };
}

function attestation() {
  const signature = ATTESTER.signingKey.sign(
    fillAttestationDigest({ chainId: BASE_SEPOLIA, verifyingContract: VERIFIER }, ORDER_ID, SOLVER),
  ).serialized;
  return {
    orderId: ORDER_ID,
    payee: SOLVER,
    signature,
    proof: encodeAttestedProof(SOLVER, signature),
    verifier: VERIFIER,
    chainId: String(BASE_SEPOLIA),
  };
}

async function startVenue(nowMs: number): Promise<Venue> {
  const { announcement, mainnet, award } = wire(nowMs);
  const token = "session-tok-1";
  const venue = {
    bids: [] as Bid[],
    fills: [] as Venue["fills"],
    attestationReads: 0,
    registered: 0,
  };
  const json = (res: http.ServerResponse, status: number, body: unknown, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://venue");
    const authed = req.headers.authorization === `Bearer ${token}`;
    if (req.method === "GET" && url.pathname === "/solver/capabilities") {
      return json(res, 200, {
        rfcVersion: SOLVER_RFC_VERSION,
        phase: "P1",
        admission: {
          model: "bonded_permissionless",
          panelSize: 1,
          bond: { chainId: BASE_SEPOLIA, address: BOND },
        },
        quoteThrough: {
          settleRule: "second_price",
          quoteTtlSeconds: 60,
          corridors: [{ fromChainId: BASE_SEPOLIA, toChainId: CANTON_TESTNET }],
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/solver/register") {
      const body = JSON.parse(raw);
      const { domain, types, message } = registrationTypedData(body);
      if (ethers.verifyTypedData(domain, types, message, body.signature) !== SOLVER)
        return json(res, 403, { error: "forbidden", message: "signature" });
      venue.registered++;
      return json(res, 200, {
        solverId: SOLVER,
        sessionToken: token,
        expiresAtMs: Date.now() + 3_600_000,
        reputation: {
          solverId: SOLVER,
          fillSuccessRate: 0,
          noShowRate: 0,
          medianLatencyMs: null,
          volumeUsd: 0,
          bondUsd: 12,
          probation: true,
          eligible: true,
          exposureCapUsd: 10,
          inFlightUsd: 0,
        },
      });
    }
    if (!authed) return json(res, 401, { error: "unauthorized", message: "register" });
    if (req.method === "GET" && url.pathname === "/solver/intents/stream") {
      const since = url.searchParams.get("since");
      if (since === "0") {
        return json(res, 200, {
          events: [
            { type: "announcement", announcement: mainnet },
            { type: "announcement", announcement },
          ],
          cursor: "1",
          dropped: 0,
          reset: false,
        });
      }
      // The award is published only once the lock is final; here, once bid.
      const events = venue.bids.length > 0 ? [{ type: "award", award }] : [];
      return json(res, 200, { events, cursor: "2", dropped: 0, reset: false });
    }
    if (req.method === "POST" && url.pathname === "/solver/bids") {
      venue.bids.push(JSON.parse(raw));
      return json(res, 202, { accepted: true });
    }
    if (req.method === "POST" && url.pathname === "/solver/fills") {
      const body = JSON.parse(raw);
      venue.fills.push({ auth: req.headers.authorization, body });
      if (venue.fills.length === 1) {
        return json(
          res,
          503,
          {
            error: "service_unavailable",
            message: "Fill attester unreachable; resubmit the receipt",
            details: { retry_after: 5 },
          },
          { "retry-after": "5" },
        );
      }
      if (body.proof.updateId !== GOOD_UPDATE) {
        return json(res, 422, {
          error: "canton_delivery_refused",
          message: "The Canton delivery does not prove this fill",
          details: { reason: "short_amount" },
        });
      }
      return json(res, 202, { accepted: true });
    }
    if (req.method === "GET" && url.pathname === `/solver/attestations/${ORDER_ID}`) {
      venue.attestationReads++;
      if (venue.attestationReads === 1)
        return json(res, 404, { error: "attestation_not_found", message: "not yet" });
      return json(res, 200, attestation());
    }
    json(res, 404, { error: "not_found", message: req.url });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return Object.assign(venue, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

// A Base Sepolia JSON-RPC under viem's `custom` transport: the escrow's lock,
// the verifier's attester set, gas, and the claim's raw bytes and receipt.
function stubChain(nowMs: number, chainId = BASE_SEPOLIA) {
  const state = {
    status: LockStatus.Open as number,
    raw: [] as Hex[],
    calls: [] as string[],
  };
  const refundableAt = BigInt(Math.floor(nowMs / 1000) + 7_200);
  const block = {
    number: "0x11",
    hash: "0x" + "44".repeat(32),
    parentHash: "0x" + "45".repeat(32),
    timestamp: "0x" + Math.floor(nowMs / 1000).toString(16),
    baseFeePerGas: "0x3b9aca00",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    transactions: [],
  };
  const call = ({ to, data }: { to: Hex; data: Hex }): Hex => {
    if (to.toLowerCase() === VERIFIER.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: VERIFIER_ABI, data });
      state.calls.push(`verifier.${functionName}`);
      if (functionName !== "isAttester") throw new Error(`unexpected ${functionName}`);
      return encodeFunctionResult({
        abi: VERIFIER_ABI,
        functionName,
        result: (args[0] as string).toLowerCase() === ATTESTER.address.toLowerCase(),
      });
    }
    if (to.toLowerCase() !== ESCROW.toLowerCase()) throw new Error(`eth_call to ${to}`);
    const { functionName } = decodeFunctionData({ abi: ESCROW_ABI, data });
    state.calls.push(`escrow.${functionName}`);
    switch (functionName) {
      case "locks":
        return encodeFunctionResult({
          abi: ESCROW_ABI,
          functionName,
          result: [
            "0xb39488aD9877DD84FBF922Ae7617dca8846DCa7b",
            refundableAt,
            10,
            state.status,
            BASE_SEPOLIA_USDC,
            BigInt(CANTON_TESTNET),
            VERIFIER,
            2_000_000n,
          ],
        });
      case "claimsPaused":
        return encodeFunctionResult({ abi: ESCROW_ABI, functionName, result: false });
      case "claim":
        return encodeFunctionResult({ abi: ESCROW_ABI, functionName, result: SOLVER as Hex });
      default:
        throw new Error(`unexpected escrow.${functionName}`);
    }
  };
  const receipt = (hash: Hex) => ({
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: block.hash,
    blockNumber: block.number,
    from: SOLVER,
    to: ESCROW,
    cumulativeGasUsed: "0x1d4c0",
    gasUsed: "0x1d4c0",
    effectiveGasPrice: "0x3b9aca00",
    contractAddress: null,
    logsBloom: "0x" + "00".repeat(256),
    status: "0x1",
    type: "0x2",
    logs: [
      {
        address: ESCROW,
        topics: encodeEventTopics({
          abi: ESCROW_ABI,
          eventName: "Claimed",
          args: { orderId: ORDER_ID, payee: SOLVER as Hex },
        }),
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1_998_000n, 2_000n]),
        blockHash: block.hash,
        blockNumber: block.number,
        transactionHash: hash,
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      },
    ],
  });
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_chainId":
          return "0x" + chainId.toString(16);
        case "eth_call":
          return call(p[0] as { to: Hex; data: Hex });
        case "eth_estimateGas":
          return "0x30000";
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_getBlockByNumber":
          return block;
        case "eth_blockNumber":
          return block.number;
        case "eth_maxPriorityFeePerGas":
          return "0x1";
        case "eth_gasPrice":
          return "0x3b9aca00";
        case "eth_sendRawTransaction": {
          const raw = p[0] as Hex;
          state.raw.push(raw);
          state.status = LockStatus.Claimed;
          return keccak256(raw);
        }
        case "eth_getTransactionReceipt":
          return state.raw.some((raw) => keccak256(raw) === p[0]) ? receipt(p[0] as Hex) : null;
        default:
          throw new Error(`unstubbed RPC ${method}`);
      }
    },
  });
  return { transport, state };
}

function operator(answers: string[]) {
  const said: string[] = [];
  const prompts: string[] = [];
  const slept: number[] = [];
  const io: OperatorIo = {
    say: (line) => said.push(line),
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => Date.now(),
  };
  return { io, said, prompts, slept };
}

let venue: Venue | undefined;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canton-test-solver-"));
});

afterEach(async () => {
  await venue?.close();
  venue = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function config(url: string): CantonTestSolverConfig {
  return {
    ...loadConfig({
      RIDDLER_SOLVER_URL: url,
      SOLVER_PRIVATE_KEY: SOLVER_KEY,
      CC_PER_USDC: "6.5",
      AWARD_DIR: dir,
    }),
    chainPollMs: 5,
    attestationPollMs: 1,
  };
}

describe("canton-test-solver end to end", () => {
  it("registers, bids, posts the receipt through 503 and 422, and claims", async () => {
    const nowMs = Date.now();
    venue = await startVenue(nowMs);
    const chain = stubChain(nowMs);
    // The first id is refused 422; a padded paste is refused locally.
    const op = operator(["upd-short", ` ${GOOD_UPDATE}`, GOOD_UPDATE]);

    const result = await runCantonTestSolver(config(venue.url), {
      io: op.io,
      originTransport: chain.transport,
    });

    // Registration and one bid: the Canton TestNet order, at 6.5 CC/USDC.
    expect(venue.registered).toBe(1);
    expect(venue.bids).toHaveLength(1);
    const [bid] = venue.bids;
    expect(verifyBid(bid!)).toBe(true);
    expect(bid).toMatchObject({
      auctionId: "au_canton_1",
      orderId: ORDER_ID,
      solverId: SOLVER,
      output: "130000000000",
      validUntilMs: nowMs + 1_860_000 + 60_000,
      minExclusiveMs: 600_000,
    });
    expect(op.said.some((l) => l.includes('"au_mainnet"') && l.includes("MainNet"))).toBe(true);

    // What the operator is told to send: the party verbatim, 12.5 CC on the grid.
    const out = op.said.join("\n");
    expect(out).toContain(`recipient party : ${PARTY}`);
    expect(out).toContain("amount          : 12.5000000000 CC  (125000000000 base units, 10 dp)");
    expect(out).toContain(`instrument      : ${CC}`);
    expect(out).toContain(new Date(nowMs + 600_000).toISOString());
    expect(fs.existsSync(path.join(dir, `canton-award-${ORDER_ID}.json`))).toBe(true);

    // Receipts: 503 (retried after Retry-After), 422 (operator re-pastes), 202.
    expect(venue.fills.map((f) => f.body.proof)).toEqual([
      { kind: "canton_update", updateId: "upd-short" },
      { kind: "canton_update", updateId: "upd-short" },
      { kind: "canton_update", updateId: GOOD_UPDATE },
    ]);
    expect(venue.fills[2]!.body).toMatchObject({
      auctionId: "au_canton_1",
      intentId: "xi_canton_1",
      solverId: SOLVER,
    });
    expect(venue.fills.every((f) => f.auth === "Bearer session-tok-1")).toBe(true);
    expect(op.slept).toContain(5_000);
    expect(out).toContain("canton_delivery_refused");
    expect(out).toContain("leading/trailing whitespace");
    expect(venue.attestationReads).toBe(2);

    // The claim: one raw tx from the solver, to the escrow, on Base Sepolia,
    // claim(orderId, abi.encode(payee, attestation signature)).
    expect(chain.state.raw).toHaveLength(1);
    const raw = chain.state.raw[0]! as TransactionSerialized;
    const tx = parseTransaction(raw);
    expect(tx.chainId).toBe(BASE_SEPOLIA);
    expect(tx.to?.toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(SOLVER);
    const decoded = decodeFunctionData({ abi: ESCROW_ABI, data: tx.data! });
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([ORDER_ID, encodeAttestedProof(SOLVER, attestation().signature)]);
    expect(chain.state.calls).toContain("verifier.isAttester");
    expect(result).toMatchObject({
      updateId: GOOD_UPDATE,
      claimTx: keccak256(raw),
      lockStatus: LockStatus.Claimed,
    });
    expect(out).toContain("lock status Claimed");
  });

  it("refuses an RPC that is not Base Sepolia before talking to the venue", async () => {
    const nowMs = Date.now();
    venue = await startVenue(nowMs);
    const chain = stubChain(nowMs, 8453);
    await expect(
      runCantonTestSolver(config(venue.url), {
        io: operator([]).io,
        originTransport: chain.transport,
      }),
    ).rejects.toThrow(/TESTNET ONLY.*chain 8453/);
    expect(venue.registered).toBe(0);
  });
});

describe("canton-test-solver testnet guard", () => {
  const env = {
    RIDDLER_SOLVER_URL: "https://riddler-stg.example",
    SOLVER_PRIVATE_KEY: SOLVER_KEY,
  };

  it("refuses a non-testnet bond chain or a mainnet RPC", () => {
    expect(() => loadConfig({ ...env, BOND_CHAIN_ID: "8453" })).toThrow(/TESTNET ONLY/);
    expect(() =>
      loadConfig({ ...env, ORIGIN_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/x" }),
    ).toThrow(/TESTNET ONLY/);
    expect(() =>
      assertTestnetOnly({ ...loadConfig(env), originRpcUrl: "https://mainnet.base.org" }),
    ).toThrow(/TESTNET ONLY/);
  });

  it("passes every announcement off the corridor and bids at least the floor", () => {
    const { announcement } = wire(Date.now());
    const cfg = { minExclusiveMs: 600_000, validityMarginMs: 0 };
    const a = IntentAnnouncementSchema.parse(announcement);
    expect(priceBid({ ...a, toChainId: CANTON_MAINNET }, cfg)).toHaveProperty("pass");
    expect(priceBid({ ...a, fromChainId: 8453 }, cfg)).toHaveProperty("pass");
    expect(priceBid({ ...a, fromToken: "0x" + "99".repeat(20) }, cfg)).toHaveProperty("pass");
    // Without CC_PER_USDC the bid is exactly the public reserve.
    expect(priceBid(a, cfg)).toMatchObject({
      output: "120000000000",
      validUntilMs: a.minValidUntilMs,
    });
  });
});
