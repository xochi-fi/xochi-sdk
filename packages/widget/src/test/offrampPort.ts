/**
 * In-memory Send/payment_app runtime for tests and the screenshot harness.
 *
 * S5's real `createPeerOfframpProvider` and S4's real `createRampClient`, over
 * an in-memory maker chain (`MemoryMaker`, the same shape as S5's own test
 * implementation), S2's recorded public quote response for candidate rails,
 * an in-memory protected-mapping storage, and a wallet that records each plan
 * it is asked to sign. No network, no signing, no sleeps. Maker facts and
 * every identifier are synthetic.
 *
 * The clock is `Date.now()`-anchored because S4's client checks offer and
 * estimate freshness against the real clock; `clock.t` can still move ahead.
 */

import { createMemoryRampOperationStore, createRampClient, type RampIntent } from "@xochi/client";
import type { PreparedTransaction } from "@zkp2p/sdk";
import type { Hex } from "viem";
import recorded from "../ramp/peer/fixtures/usd-best-by-platform.json";
import {
  createPeerOfframpProvider,
  MakerSetupRequired,
  peerConfiguration,
  PeerMakerPrivateStore,
  type MakerDepositFacts,
  type MakerMappingStorage,
  type MakerReadiness,
  type MakerReconciliation,
  type MakerUnsignedPlan,
  type MakerWalletAction,
  type PeerMakerIO,
} from "../ramp/peer/index.js";
import type { ProtectedMakerMapping } from "../ramp/peer/protectedMapping.js";
import type { OfframpPort, OfframpRuntime } from "../ramp/offramp/port.js";

const config = peerConfiguration();
/** Synthetic numeric deposit ID (the protected mapping admits only canonical integers). */
export const SYNTHETIC_DEPOSIT_ID = "918273645";

export class MemoryMappingStorage implements MakerMappingStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const tx = (data: Hex): PreparedTransaction => ({
  chainId: 8453,
  to: config.escrow as Hex,
  data,
  value: 0n,
});

/** Deterministic maker chain. Holds only synthetic handles. */
export class MemoryMaker implements PeerMakerIO {
  ready: { -readonly [K in keyof MakerReadiness]: MakerReadiness[K] } = {
    oracleFresh: true,
    requiresIdentityAttestation: false,
    identityAttested: true,
    sellerSetup: "ready",
  };
  hasAllowance = false;
  refuseRegistration = false;
  credential: "verified" | "missing" = "verified";
  registeredAccounts: string[] = [];
  depositPlans = 0;
  withdrawalPlans: { amount: string; full: boolean }[] = [];
  /** Receipt outcome per submitted hash; unknown hashes stay pending. */
  receipts = new Map<string, MakerReconciliation>();
  deposits = 0;
  /** The amount the last prepared deposit plan holds. */
  preparedAmount = "0";
  facts: { -readonly [K in keyof MakerDepositFacts]: MakerDepositFacts[K] } = {
    remaining: "0",
    unmatched: "0",
    filled: "0",
    withdrawn: "0",
    activeIntents: 0,
    closed: false,
  };
  constructor(readonly clock: { t: number }) {}

  /** A wallet broadcast landing on the chain. */
  confirm(hash: string, action: MakerWalletAction, amount = this.preparedAmount) {
    if (action === "approve_usdc") {
      this.hasAllowance = true;
      this.receipts.set(hash.toLowerCase(), { state: "confirmed" });
    } else if (action === "create_deposit") {
      this.deposits++;
      Object.assign(this.facts, { remaining: amount, unmatched: amount });
      this.receipts.set(hash.toLowerCase(), {
        state: "confirmed",
        depositId: SYNTHETIC_DEPOSIT_ID,
      });
    } else this.receipts.set(hash.toLowerCase(), { state: "confirmed" });
  }

  async rebuild(mapping: ProtectedMakerMapping, pendingWithdrawalHash?: string) {
    const known = mapping.creationTxHash && this.receipts.get(mapping.creationTxHash.toLowerCase());
    if (
      !known ||
      known.state !== "confirmed" ||
      (BigInt(mapping.legRevision) % 2n === 1n && !pendingWithdrawalHash)
    )
      return { state: "pending" as const };
    const total =
      BigInt(this.facts.remaining) + BigInt(this.facts.filled) + BigInt(this.facts.withdrawn);
    return { state: "confirmed" as const, depositId: SYNTHETIC_DEPOSIT_ID, amount: String(total) };
  }
  async readiness() {
    return { ...this.ready };
  }
  async registerOwnPayee(_rail: string, account: string) {
    if (this.refuseRegistration) throw new MakerSetupRequired();
    this.registeredAccounts.push(account);
    this.credential = "verified";
    return "synthetic_payee_hash";
  }
  async allowance() {
    return this.hasAllowance;
  }
  async prepareApproval() {
    return tx("0x095ea7b3");
  }
  async prepareDeposit(input: { amount: string }) {
    this.depositPlans++;
    this.preparedAmount = input.amount;
    return tx("0x0c0ffee0");
  }
  async reconcile(hash: string) {
    return this.receipts.get(hash.toLowerCase()) ?? { state: "pending" as const };
  }
  async deposit() {
    return { ...this.facts };
  }
  async prepareWithdrawal(_id: string, amount: string, full: boolean) {
    this.withdrawalPlans.push({ amount, full });
    return tx("0xdeadbeef");
  }
  evidence(intent: RampIntent, rail: string, wallet: string) {
    return {
      observed_at: new Date(this.clock.t).toISOString(),
      valid_until: new Date(this.clock.t + 20_000).toISOString(),
      rail,
      currency: intent.fiat.currency,
      chain_id: "eip155:8453",
      asset_id: config.settlement.asset_id,
      decimals: 6,
      rate: { numerator: "99", denominator: "100" },
      bounds: { minimum: "1000000", maximum: "1000000000" },
      fees: [],
      credential: this.credential,
      wallet,
    };
  }
}

export interface WalletCall {
  action: MakerWalletAction;
  account: string;
  to: string;
  data: string;
}

export interface TestOfframpPort extends OfframpPort {
  maker: MemoryMaker;
  storage: MemoryMappingStorage;
  /** Plans the wallet was asked to sign, in order. */
  signed: WalletCall[];
  /** What the next wallet prompt does. */
  walletAnswer: "approve" | "reject" | "lost";
  /** Whether a signed transaction lands on the chain at once. */
  autoConfirm: boolean;
  chain: number;
  /** The deployment canary cap the port reports. */
  cap?: string;
  /** The last hash the wallet broadcast, even when the page never learned it. */
  lastHash?: Hex;
  /** A fresh runtime over the same chain and storage: a page reload. */
  reload(): void;
}

export function memoryOfframpPort(options: {
  account: string;
  makerRails?: readonly string[];
  maker?: MemoryMaker;
  storage?: MemoryMappingStorage;
}): TestOfframpPort {
  const clock = { t: Date.now() };
  const maker = options.maker ?? new MemoryMaker(clock);
  const storage = options.storage ?? new MemoryMappingStorage();
  const makerRails = options.makerRails ?? ["wise", "revolut"];
  let runtime: OfframpRuntime | undefined;
  let txCount = 0;

  function build(account: string): OfframpRuntime {
    const now = () => Math.max(Date.now(), maker.clock.t);
    const provider = createPeerOfframpProvider({
      io: maker,
      store: new PeerMakerPrivateStore(),
      storage,
      discovery: {
        user: account,
        now,
        reads: {
          bestByPlatform: async () => {
            const raw = structuredClone(recorded);
            raw.responseObject.quoteExpiresAt = new Date(now() + 20_000).toISOString();
            for (const p of raw.responseObject.platformQuotes)
              if (p.bestQuote) p.bestQuote.intent.toAddress = account;
            return raw;
          },
          quote: async () => structuredClone(recorded),
          makerEvidence: async (intent: RampIntent, rail: string) =>
            makerRails.includes(rail) ? maker.evidence(intent, rail, account) : undefined,
        },
      },
    });
    return {
      provider,
      client: createRampClient({ peer: provider, store: createMemoryRampOperationStore() }),
    };
  }

  const port: TestOfframpPort = {
    maker,
    storage,
    signed: [],
    walletAnswer: "approve",
    autoConfirm: true,
    chain: 8453,
    reload() {
      runtime = undefined;
    },
    async runtime(account) {
      runtime ??= build(account);
      return runtime;
    },
    wallet: {
      chainId: () => port.chain,
      async switchToBase() {
        port.chain = 8453;
      },
      async send(plan: MakerUnsignedPlan) {
        if (port.walletAnswer === "reject") throw new Error("User rejected the request.");
        port.signed.push({
          action: plan.action,
          account: plan.account,
          to: plan.transaction.to,
          data: plan.transaction.data,
        });
        const hash = `0x${(++txCount).toString(16).padStart(64, "a")}` as Hex;
        port.lastHash = hash;
        if (port.autoConfirm) maker.confirm(hash, plan.action);
        if (port.walletAnswer === "lost") throw new Error("connection lost");
        return hash;
      },
      async wait() {},
    },
    settlement: () => config.settlement,
    escrow: () => config.escrow,
    canaryCap: () => port.cap,
    now: () => Math.max(Date.now(), maker.clock.t),
    debounceMs: 0,
    pollMs: 0,
  };
  return port;
}
