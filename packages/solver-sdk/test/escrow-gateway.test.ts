// OnchainEscrowGateway prepare -> accept -> fill (SOLVER-RFC §5.3, §7.1), driven
// through its two existing seams: the ethers providers its signers are
// connected to (an in-process chain answering JSON-RPC, below) and the
// `acceptAward` transport. Expected digests come from the vector files and the
// signer's own exports, never from the gateway.
//
// The property under test is fund safety around the FillAcceptance signature:
// everything that can refuse runs before it is signed, and once it is SENT the
// fill is owed whatever the venue answers.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { fillAcceptanceDigest, fillAcceptanceOf, signFillAuth } from "@xochi/signer";

import {
  RIDDLER_ESCROW_ABI,
  RIDDLER_FILLER_ABI,
  EscrowRefusalError,
  OnchainEscrowGateway,
  type Award,
  type EscrowRefusal,
  type FillAcceptanceReceipt,
  type PreparedFill,
} from "../src/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) =>
  JSON.parse(fs.readFileSync(path.resolve(here, "../../spec/conformance", name), "utf8"));
const baseline = load("order-id.json").vectors.find(
  (v: { name: string }) => v.name === "baseline-evm-usdc",
);
const fillId: string = load("fill-salt.json").vectors.find(
  (v: { orderId: string }) => v.orderId === baseline.expected_order_id,
).expected_fill_id;

// PUBLIC Anvil TEST keys. Never fund them.
const SOLVER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // #3
const VENUE_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // #4
const SOLVER = new ethers.Wallet(SOLVER_KEY).address;

const ORIGIN = Number(baseline.terms.fromChainId); // 8453, also the bond chain
const DEST = Number(baseline.terms.toChainId); // 10
const ESCROW = ethers.getAddress(baseline.terms.escrow);
const FILLER = "0x4444444444444444444444444444444444444444";
const BOND = "0x6666666666666666666666666666666666666666";
const VERIFIER = "0x7777777777777777777777777777777777777777";
const TOKEN = ethers.getAddress(baseline.opening.toToken);
const AMOUNT = BigInt(baseline.opening.toAmount);
const DEADLINE = 1_899_990_000;
const REFUNDABLE_AT = 1_900_003_600;
const OPENED_BLOCK = 100;

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ---------------------------------------------------------------------------
// In-process chain: the JSON-RPC a JsonRpcProvider would send to a node.

interface ChainState {
  timestamp: number; // latest block time, both chains
  filled: boolean;
  balance: bigint;
  allowance: bigint;
  fillReverts: boolean;
  claimsPaused: boolean; // RiddlerEscrow on the origin
  claimGas: bigint; // the origin claim signer's native balance
  sent: string[]; // raw transactions broadcast on the destination
}

const escrowIface = new ethers.Interface(RIDDLER_ESCROW_ABI);
const fillerIface = new ethers.Interface(RIDDLER_FILLER_ABI);
const erc20Iface = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const HEAD = 200;
const hashOf = (n: number) => ethers.keccak256(ethers.toBeHex(n, 32));
const hex = (n: number | bigint) => ethers.toQuantity(n);

class Chain extends ethers.JsonRpcProvider {
  constructor(
    private readonly chainId: number,
    private readonly state: ChainState,
  ) {
    super("http://chain.invalid", ethers.Network.from(chainId), {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: -1,
    });
  }

  override async _send(
    payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[],
  ): Promise<ethers.JsonRpcResult[]> {
    const p = Array.isArray(payload) ? payload[0]! : payload;
    try {
      return [{ id: p.id, result: this.answer(p.method, p.params as unknown[]) }];
    } catch (err) {
      const e = err as { rpc?: { code: number; message: string; data?: string } };
      if (e.rpc) return [{ id: p.id, error: e.rpc } as unknown as ethers.JsonRpcResult];
      throw err;
    }
  }

  private block(tag: unknown) {
    const n =
      tag === "latest" || tag === "pending"
        ? HEAD
        : tag === "safe" || tag === "finalized"
          ? HEAD - 10
          : Number(tag);
    return {
      number: hex(n),
      hash: hashOf(n),
      parentHash: hashOf(n - 1),
      timestamp: hex(this.state.timestamp),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: hex(30_000_000),
      gasUsed: "0x0",
      miner: ethers.ZeroAddress,
      extraData: "0x",
      baseFeePerGas: hex(1_000_000_000),
      transactions: [],
    };
  }

  private answer(method: string, params: unknown[]): unknown {
    const s = this.state;
    switch (method) {
      case "eth_chainId":
        return hex(this.chainId);
      case "eth_blockNumber":
        return hex(HEAD);
      case "eth_getBlockByNumber":
        return this.block(params[0]);
      case "eth_getLogs": {
        const f = params[0] as { address: string; topics: string[] };
        if (this.chainId !== ORIGIN || f.address.toLowerCase() !== ESCROW.toLowerCase()) return [];
        if (f.topics[1]?.toLowerCase() !== baseline.expected_order_id) return [];
        const log = escrowIface.encodeEventLog("Opened", [
          baseline.expected_order_id,
          baseline.terms.depositor,
          baseline.terms.fromToken,
          BigInt(baseline.terms.fromAmount),
          BigInt(baseline.terms.toChainId),
          BigInt(REFUNDABLE_AT),
        ]);
        return [
          {
            address: ESCROW,
            topics: log.topics,
            data: log.data,
            blockNumber: hex(OPENED_BLOCK),
            blockHash: hashOf(OPENED_BLOCK),
            transactionHash: hashOf(1),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ];
      }
      case "eth_call":
        return this.answerCall(params[0] as { to: string; data: string });
      case "eth_getBalance":
        return hex(s.claimGas);
      case "eth_estimateGas":
        return hex(100_000);
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return hex(1_000_000_000);
      case "eth_getTransactionCount":
        return hex(s.sent.length);
      case "eth_sendRawTransaction": {
        const raw = params[0] as string;
        s.sent.push(raw);
        return ethers.keccak256(raw);
      }
      case "eth_getTransactionReceipt": {
        const raw = s.sent.find((r) => ethers.keccak256(r) === params[0]);
        if (!raw) return null;
        const tx = ethers.Transaction.from(raw);
        return {
          transactionHash: tx.hash,
          transactionIndex: "0x0",
          blockHash: hashOf(HEAD),
          blockNumber: hex(HEAD),
          from: tx.from,
          to: tx.to,
          contractAddress: null,
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          gasUsed: hex(50_000),
          cumulativeGasUsed: hex(50_000),
          effectiveGasPrice: hex(1_000_000_000),
          type: "0x2",
          status: "0x1",
        };
      }
      default:
        throw new Error(`chain ${this.chainId}: unexpected ${method}`);
    }
  }

  private answerCall({ to, data }: { to: string; data: string }): string {
    const s = this.state;
    const target = to.toLowerCase();
    if (target === ESCROW.toLowerCase()) {
      if (data.startsWith(escrowIface.getFunction("claimsPaused")!.selector)) {
        return escrowIface.encodeFunctionResult("claimsPaused", [s.claimsPaused]);
      }
      return escrowIface.encodeFunctionResult("locks", [
        baseline.terms.depositor,
        REFUNDABLE_AT,
        0,
        1, // Open
        baseline.terms.fromToken,
        BigInt(baseline.terms.toChainId),
        VERIFIER,
        BigInt(baseline.terms.fromAmount),
      ]);
    }
    if (target === FILLER.toLowerCase()) {
      const fn = fillerIface.parseTransaction({ data })!;
      if (fn.name === "filled") return fillerIface.encodeFunctionResult("filled", [s.filled]);
      if (fn.name === "isFillAuthorizer") {
        return fillerIface.encodeFunctionResult("isFillAuthorizer", [
          fn.args[0] === new ethers.Wallet(VENUE_KEY).address,
        ]);
      }
      if (fn.name === "fill") {
        if (s.fillReverts) {
          throw Object.assign(new Error("revert"), {
            rpc: {
              code: 3,
              message: "execution reverted",
              data: fillerIface.encodeErrorResult("ShortDelivery", [1, 0]),
            },
          });
        }
        return "0x";
      }
    }
    if (target === TOKEN.toLowerCase()) {
      const fn = erc20Iface.parseTransaction({ data })!;
      if (fn.name === "balanceOf") return erc20Iface.encodeFunctionResult("balanceOf", [s.balance]);
      if (fn.name === "allowance")
        return erc20Iface.encodeFunctionResult("allowance", [s.allowance]);
    }
    throw new Error(`unexpected eth_call to ${to}`);
  }
}

// ---------------------------------------------------------------------------
// The venue's accept endpoint.

type Venue = (
  auctionId: string,
  body: { orderId: string; signature: string },
  signal?: AbortSignal,
) => Promise<FillAcceptanceReceipt>;

const honest: Venue = async (auctionId, body) => ({
  ...body,
  auctionId,
  acceptedAt: DEADLINE - 500,
});

let state: ChainState;
let posts: { orderId: string; signature: string }[];
let warnings: string[];

function gatewayWith(
  venue: Venue,
  extra: Partial<ConstructorParameters<typeof OnchainEscrowGateway>[0]> = {},
) {
  const origin = new Chain(ORIGIN, state);
  const dest = new Chain(DEST, state);
  return new OnchainEscrowGateway({
    origins: { [ORIGIN]: { signer: new ethers.Wallet(SOLVER_KEY, origin), escrow: ESCROW } },
    destinations: {
      [DEST]: { signer: new ethers.Wallet(SOLVER_KEY, dest), fillerContract: FILLER },
    },
    bond: { signer: new ethers.Wallet(SOLVER_KEY, origin), address: BOND },
    acceptances: {
      acceptAward: (auctionId, body, signal) => {
        posts.push(body);
        return venue(auctionId, body, signal);
      },
    },
    now: () => state.timestamp * 1000,
    finalityPollMs: 1,
    onWarning: (m) => warnings.push(m),
    ...extra,
  });
}

async function awardWith(
  over: { amount?: bigint; bond?: string; acceptBy?: number } = {},
): Promise<Award> {
  const fillAuth = {
    fillId,
    filler: SOLVER,
    to: baseline.opening.recipient,
    token: baseline.opening.toToken,
    amount: (over.amount ?? AMOUNT).toString(),
    deadline: String(DEADLINE),
  };
  const signature = await signFillAuth(
    new ethers.Wallet(VENUE_KEY),
    { chainId: DEST, verifyingContract: FILLER },
    fillAuth,
  );
  return {
    auctionId: "auc-1",
    intentId: baseline.opening.intentId,
    solverId: SOLVER,
    output: fillAuth.amount,
    exclusiveUntil: DEADLINE * 1000,
    escrow: {
      address: ESCROW,
      intentRef: baseline.expected_order_id,
      fillId,
      destOpening: { ...baseline.opening },
      fillAuth: { ...fillAuth, chainId: String(DEST), fillerContract: FILLER, signature },
      orderTerms: { ...baseline.terms, destCommitment: baseline.expected_dest_commitment },
      bond: { chainId: String(ORIGIN), address: over.bond ?? BOND },
      // Out of the way unless a test is about the acceptance window.
      acceptBy: String(over.acceptBy ?? DEADLINE),
    },
  };
}

const bidFor = (output: bigint = AMOUNT) => ({
  auctionId: "auc-1",
  orderId: baseline.expected_order_id,
  output: output.toString(),
});

async function prepared(
  gw: OnchainEscrowGateway,
  bidOutput?: bigint,
  amount?: bigint,
): Promise<PreparedFill> {
  return gw.prepare(await awardWith({ amount }), { bid: bidFor(bidOutput), originChainId: ORIGIN });
}

async function refusal(p: Promise<unknown>): Promise<EscrowRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EscrowRefusalError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal, got none");
}

// The acceptance this solver must sign, built from the vectors' own helper.
const expectedDigest = () =>
  fillAcceptanceDigest(
    { chainId: ORIGIN, verifyingContract: BOND },
    fillAcceptanceOf(
      { orderId: baseline.expected_order_id, originChainId: ORIGIN, escrow: ESCROW },
      { chainId: DEST, verifyingContract: FILLER },
      {
        fillId,
        filler: SOLVER,
        to: baseline.opening.recipient,
        token: baseline.opening.toToken,
        amount: AMOUNT,
        deadline: DEADLINE,
      },
    ),
  );

// A second valid signature of ours over `digest`: what a non-deterministic
// signer (random k) would have produced, i.e. an earlier acceptance the venue
// kept as first writer. ECDSA with a fixed k, kG from `computePublicKey`.
function altSignature(digest: string, key: string): string {
  const d = BigInt(key);
  const k = 0x1234567890abcdefn;
  const point = ethers.getBytes(ethers.SigningKey.computePublicKey(ethers.toBeHex(k, 32), false));
  const r = BigInt(ethers.hexlify(point.slice(1, 33))) % SECP256K1_N;
  const yOdd = (point[64]! & 1) === 1;
  const inv = (a: bigint): bigint => {
    let [t, newT, rr, newR]: bigint[] = [
      0n,
      1n,
      SECP256K1_N,
      ((a % SECP256K1_N) + SECP256K1_N) % SECP256K1_N,
    ];
    while (newR !== 0n) {
      const q: bigint = rr! / newR!;
      [t, newT] = [newT!, t! - q * newT!];
      [rr, newR] = [newR!, rr! - q * newR!];
    }
    return ((t! % SECP256K1_N) + SECP256K1_N) % SECP256K1_N;
  };
  let s = (inv(k) * (BigInt(digest) + r * d)) % SECP256K1_N;
  let odd = yOdd;
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s;
    odd = !odd;
  }
  return ethers
    .concat([ethers.toBeHex(r, 32), ethers.toBeHex(s, 32), new Uint8Array([odd ? 28 : 27])])
    .toLowerCase();
}

beforeEach(() => {
  state = {
    timestamp: DEADLINE - 600,
    filled: false,
    balance: AMOUNT,
    allowance: AMOUNT,
    fillReverts: false,
    claimsPaused: false,
    claimGas: 10n ** 18n,
    sent: [],
  };
  posts = [];
  warnings = [];
});

// ---------------------------------------------------------------------------

describe("OnchainEscrowGateway prepare -> accept -> fill", () => {
  it("signs the acceptance of exactly this FillAuth, posts it, then fills once", async () => {
    const gw = gatewayWith(honest);
    const p = await prepared(gw);
    const accepted = await gw.accept(p);

    expect(accepted.digest).toBe(expectedDigest());
    expect(posts).toEqual([{ orderId: baseline.expected_order_id, signature: accepted.signature }]);
    expect(ethers.recoverAddress(expectedDigest(), posts[0]!.signature)).toBe(SOLVER);
    expect(accepted.receipt).toEqual({
      status: "recorded",
      signature: accepted.signature,
      acceptedAt: DEADLINE - 500,
    });

    expect((await gw.fill(p)).status).toBe("confirmed");
    expect(state.sent).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("refuses to fill a FillAuth accept was never called for", async () => {
    const gw = gatewayWith(honest);
    expect(await refusal(gw.fill(await prepared(gw)))).toBe("not_accepted");
    expect(state.sent).toHaveLength(0);
  });

  it("refuses an award naming a bond other than the configured one, before reading the origin", async () => {
    const gw = gatewayWith(honest);
    const award = await awardWith({ bond: "0x9999999999999999999999999999999999999999" });
    expect(await refusal(gw.prepare(award, { bid: bidFor(), originChainId: ORIGIN }))).toBe(
      "bond_mismatch",
    );
  });

  it("refuses an award for an order or auction other than the bid it signed", async () => {
    const gw = gatewayWith(honest);
    const award = await awardWith();
    const otherOrder = { ...bidFor(), orderId: "0x" + "ab".repeat(32) };
    expect(await refusal(gw.prepare(award, { bid: otherOrder, originChainId: ORIGIN }))).toBe(
      "announcement_mismatch",
    );
  });

  // The required bid is the ceiling from `prepare` on, before any waiting.
  it("refuses a FillAuth amount above its own bid output, signing and sending nothing", async () => {
    const gw = gatewayWith(honest);
    expect(await refusal(prepared(gw, AMOUNT - 1n))).toBe("fill_auth_mismatch");
    expect(posts).toEqual([]);
    expect(state.sent).toEqual([]);
  });

  it.each([
    ["already filled", (s: ChainState): void => void (s.filled = true), "already_filled"],
    [
      "short inventory",
      (s: ChainState): void => void (s.balance = AMOUNT - 1n),
      "insufficient_inventory",
    ],
    [
      "short allowance",
      (s: ChainState): void => void (s.allowance = AMOUNT - 1n),
      "insufficient_allowance",
    ],
    [
      "fill would revert",
      (s: ChainState): void => void (s.fillReverts = true),
      "simulation_failed",
    ],
  ] as const)(
    "refuses before signing when the fill preflight fails: %s",
    async (_label, breakIt, code) => {
      const gw = gatewayWith(honest);
      const p = await prepared(gw);
      breakIt(state);
      expect(await refusal(gw.accept(p))).toBe(code);
      expect(posts).toEqual([]);
      expect(state.sent).toEqual([]);
    },
  );

  it("refuses before signing when the accept would land after the venue's acceptBy", async () => {
    const gw = gatewayWith(honest, { acceptBudgetSec: 15 });
    const acceptBy = state.timestamp + 30;
    const award = await awardWith({ acceptBy });
    const p = await gw.prepare(award, { bid: bidFor(), originChainId: ORIGIN });
    state.timestamp = acceptBy - 15 + 1;
    expect(await refusal(gw.accept(p))).toBe("accept_window_closed");
    expect(posts).toEqual([]);
    expect(await refusal(gw.fill(p))).toBe("not_accepted");
    state.timestamp = acceptBy - 15;
    expect((await gw.accept(p)).receipt.status).toBe("recorded");
  });

  it("an award without acceptBy is malformed: there is no window to accept inside", async () => {
    const gw = gatewayWith(honest);
    const award = await awardWith();
    delete award.escrow!.acceptBy;
    expect(await refusal(gw.prepare(award, { bid: bidFor(), originChainId: ORIGIN }))).toBe(
      "malformed_award",
    );
  });

  it("refuses to sign without headroom for the accept round-trip on top of the fill budget", async () => {
    const gw = gatewayWith(honest, { fillInclusionSec: 60, acceptBudgetSec: 15 });
    const p = await prepared(gw);
    state.timestamp = DEADLINE - 60 - 15 + 1; // the fill alone would still fit
    expect(await refusal(gw.accept(p))).toBe("auth_expired");
    expect(posts).toEqual([]);
    state.timestamp = DEADLINE - 60 - 15;
    expect((await gw.accept(p)).receipt.status).toBe("recorded");
  });

  describe("once the acceptance is sent the fill is owed, whatever the venue answers", () => {
    it.each<[string, Venue, "mismatch" | "unacknowledged"]>([
      [
        "a 5xx",
        async () => Promise.reject(new Error("solver accept 503: unavailable")),
        "unacknowledged",
      ],
      [
        "a 200 for another auction",
        async (_a, body) => ({ ...body, auctionId: "auc-other", acceptedAt: 1 }),
        "mismatch",
      ],
      [
        "a 200 holding someone else's signature",
        async (auctionId, body) => ({
          ...body,
          auctionId,
          signature: altSignature(expectedDigest(), VENUE_KEY),
          acceptedAt: 1,
        }),
        "mismatch",
      ],
      [
        "no answer at all",
        // Executor form: this package's TS lib predates Promise.withResolvers.
        (_a, _b, signal) =>
          new Promise<FillAcceptanceReceipt>((_, reject) =>
            signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          ),
        "unacknowledged",
      ],
    ])("%s", async (_label, venue, status) => {
      const gw = gatewayWith(venue, { acceptTimeoutMs: 50 });
      const p = await prepared(gw);
      const accepted = await gw.accept(p);
      expect(accepted.receipt.status).toBe(status);
      expect(posts).toHaveLength(1);
      expect(warnings.some((w) => w.includes(status))).toBe(true);
      expect((await gw.fill(p)).status).toBe("confirmed");
    });

    it("an earlier first-writer signature of ours counts as recorded", async () => {
      const earlier = altSignature(expectedDigest(), SOLVER_KEY);
      const gw = gatewayWith(async (auctionId, body) => ({
        ...body,
        auctionId,
        signature: earlier,
        acceptedAt: 7,
      }));
      const p = await prepared(gw);
      const accepted = await gw.accept(p);
      expect(accepted.signature).not.toBe(earlier);
      expect(accepted.receipt).toEqual({ status: "recorded", signature: earlier, acceptedAt: 7 });
      expect((await gw.fill(p)).status).toBe("confirmed");
    });

    it("a short inclusion budget after acceptance is a warning, and the fill is still sent", async () => {
      const gw = gatewayWith(honest, { fillInclusionSec: 60 });
      const p = await prepared(gw);
      await gw.accept(p);
      state.timestamp = DEADLINE - 10;
      expect((await gw.fill(p)).status).toBe("confirmed");
      expect(warnings.some((w) => w.includes("short budget"))).toBe(true);
    });

    it("refuses only once destination time is past the deadline", async () => {
      const gw = gatewayWith(honest);
      const p = await prepared(gw);
      await gw.accept(p);
      state.timestamp = DEADLINE + 1;
      expect(await refusal(gw.fill(p))).toBe("auth_expired");
      expect(state.sent).toEqual([]);
    });

    it("accept again re-posts the same signature without re-running the preflight", async () => {
      const gw = gatewayWith(async () => Promise.reject(new Error("down")));
      const p = await prepared(gw);
      const first = await gw.accept(p);
      state.balance = 0n; // would refuse a fresh accept
      const again = await gw.accept(p);
      expect(again.signature).toBe(first.signature);
      expect(posts.map((b) => b.signature)).toEqual([first.signature, first.signature]);
    });

    it("refuses a second FillAuth for an accepted fillId, in accept and in fill", async () => {
      const gw = gatewayWith(honest);
      const p = await prepared(gw, AMOUNT + 1_000n);
      const first = await gw.accept(p);
      // Same fillId, re-issued by the venue with another amount (within the bid).
      const other = await prepared(gw, AMOUNT + 1_000n, AMOUNT + 1_000n);
      expect(other.fillId).toBe(p.fillId);
      expect(await refusal(gw.accept(other))).toBe("fill_auth_mismatch");
      expect(posts.map((b) => b.signature)).toEqual([first.signature]);
      expect(await refusal(gw.fill(other))).toBe("fill_auth_mismatch");
      expect(state.sent).toEqual([]);
      expect((await gw.fill(p)).status).toBe("confirmed");
    });

    it("fill refuses an accepted FillAuth whose amount exceeds the solver's bid", async () => {
      const gw = gatewayWith(honest);
      const p = await prepared(gw);
      await gw.accept(p);
      expect(await refusal(gw.fill({ ...p, bidOutput: AMOUNT - 1n }))).toBe("fill_auth_mismatch");
      expect(state.sent).toEqual([]);
    });

    it("a restarted gateway resumes: the same deterministic signature, no preflight refusal", async () => {
      const acceptBy = state.timestamp + 30;
      const before = gatewayWith(honest);
      const first = await before.accept(
        await before.prepare(await awardWith({ acceptBy }), {
          bid: bidFor(),
          originChainId: ORIGIN,
        }),
      );
      state.timestamp = DEADLINE - 30; // past acceptBy and inside the accept budget now
      const restarted = gatewayWith(honest);
      const p = await restarted.prepare(await awardWith({ acceptBy }), {
        bid: bidFor(),
        originChainId: ORIGIN,
      });
      expect(await refusal(restarted.accept(p))).toBe("accept_window_closed");
      const resumed = await restarted.accept(p, { resume: true });
      expect(resumed.signature).toBe(first.signature);
      expect((await restarted.fill(p)).status).toBe("confirmed");
    });
  });
});
