import { atomic, type RampIntent } from "@xochi/client";
import { getContracts, type PreparedTransaction } from "@zkp2p/sdk";
import {
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { z } from "zod";
import { digest } from "./normalization.js";
import { peerConfiguration } from "./discovery.js";
import type {
  MakerDepositFacts,
  MakerReadiness,
  MakerReconciliation,
  PeerMakerIO,
} from "./offramp.js";
import type { MakerExecutionTerms } from "./sdkMaker.js";
import type { ProtectedMakerMapping } from "./protectedMapping.js";
import type { PeerDiscoveryOptions } from "./types.js";

export interface MakerChainTransaction {
  chainId?: number;
  from: string;
  to: string | null;
  input: Hex;
  value: bigint;
}
export interface MakerChainReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  transactionHash: Hex;
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
}
export type MakerPublicClient = Pick<
  PublicClient,
  "getChainId" | "getBlockNumber" | "readContract" | "call"
> & {
  getTransaction(input: { hash: Hex }): Promise<MakerChainTransaction>;
  getTransactionReceipt(input: { hash: Hex }): Promise<MakerChainReceipt>;
};
const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const indexedDeposit = z.object({
  depositId: uint,
  chainId: z.union([z.literal(8453), z.literal("8453")]),
  escrowAddress: addr,
  depositor: addr,
  token: addr,
  remainingDeposits: uint,
  outstandingIntentAmount: uint,
  totalAmountTaken: uint,
  totalWithdrawn: uint,
  blockNumber: uint,
  status: z.enum(["ACTIVE", "CLOSED", "WITHDRAWN"]),
});
const tupleDeposit = z.object({
  depositor: addr,
  token: addr,
  remainingDeposits: z.bigint().nonnegative(),
  outstandingIntentAmount: z.bigint().nonnegative(),
  intentAmountRange: z.object({ min: z.bigint().nonnegative(), max: z.bigint().nonnegative() }),
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const zero = "0x0000000000000000000000000000000000000000";
function broken(): never {
  throw new Error("capability_unavailable");
}
const DEPOSIT_QUERY = `query MakerDeposit($id: String!) {
 Deposit_by_pk(id: $id) { depositId chainId escrowAddress depositor token remainingDeposits outstandingIntentAmount totalAmountTaken totalWithdrawn blockNumber status }
 Intent(where: {depositId: {_eq: $id}}, limit: 1001) { intentHash amount status releasedAmount orchestratorAddress }
 DepositFundActivity(where: {depositId: {_eq: $id}}, limit: 1001) { activityType amount blockNumber }
}`;
const TEMPLATE_QUERY = `query MakerTemplate($method: String!, $currency: String!) {
 DepositPaymentMethod(where: {paymentMethodHash: {_ilike: $method}, active: {_eq: true}}, limit: 32) { depositId depositIdOnContract paymentMethodHash }
 MethodCurrency(where: {paymentMethodHash: {_ilike: $method}, currencyCode: {_ilike: $currency}}, limit: 32) { depositId depositIdOnContract }
}`;
/** No automatic retries/sleeps: Retry-After prevents subsequent requests until its deadline. */
export function createMakerIndexer(options: {
  environment?: PeerDiscoveryOptions["environment"];
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const endpoint =
    options.environment === "staging"
      ? "https://indexer-staging.zkp2p.xyz/v1/graphql"
      : "https://indexer.zkp2p.xyz/v1/graphql";
  let blockedUntil = 0;
  const now = options.now ?? Date.now;
  return async (query: string, variables: Record<string, string>): Promise<unknown> => {
    if (now() < blockedUntil) broken();
    try {
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
        credentials: "omit",
        redirect: "error",
      });
      if (response.status === 429) {
        const after = response.headers.get("Retry-After");
        const seconds = after && /^\d+$/.test(after) ? Number(after) : undefined;
        const date = after ? Date.parse(after) : NaN;
        blockedUntil = Math.max(
          now() + 1000,
          seconds !== undefined && Number.isSafeInteger(seconds)
            ? now() + seconds * 1000
            : Number.isFinite(date)
              ? date
              : now() + 30_000,
        );
        broken();
      }
      if (!response.ok) broken();
      const body = z
        .object({ data: z.record(z.string(), z.unknown()), errors: z.unknown().optional() })
        .parse(await response.json());
      if (body.errors !== undefined) broken();
      return body.data;
    } catch {
      broken();
    }
  };
}
export function createDefaultMakerReads(options: {
  publicClient: MakerPublicClient;
  wallet: string;
  environment?: PeerDiscoveryOptions["environment"];
  fetch?: typeof fetch;
  now?: () => number;
  /** Provider-private registration success, not caller UI metadata. */
  registered(rail: string): boolean;
}) {
  const config = peerConfiguration({ environment: options.environment });
  const contracts = getContracts(8453, options.environment ?? "production");
  const escrow = config.escrow as Address,
    orchestrator = config.orchestrator as Address;
  const escrowAbi: Abi = contracts.abis.escrowV2 ?? broken();
  const orchestratorAbi: Abi = contracts.abis.orchestratorV4 ?? broken();
  if (!escrowAbi || !orchestratorAbi) broken();
  const now = options.now ?? Date.now;
  const query = createMakerIndexer(options);
  async function block() {
    if ((await options.publicClient.getChainId()) !== 8453) broken();
    return options.publicClient.getBlockNumber();
  }
  async function read(
    address: Address,
    abi: Abi,
    name: string,
    args: readonly unknown[],
    blockNumber: bigint,
  ): Promise<unknown> {
    return options.publicClient.readContract({
      address,
      abi,
      functionName: name,
      args,
      blockNumber,
    });
  }
  const escrowRead = (name: string, args: readonly unknown[], height: bigint) =>
    read(escrow, escrowAbi, name, args, height);
  async function terms(intent: RampIntent, rail: string): Promise<MakerExecutionTerms> {
    try {
      if (
        intent.direction !== "offramp" ||
        intent.route ||
        intent.region !== undefined ||
        intent.fiat.currency !== "USD" ||
        !same(intent.recipient, options.wallet) ||
        !Object.hasOwn(config.rails, rail)
      )
        broken();
      const height = await block();
      const [paused, orchestratorPaused, balance] = await Promise.all([
        escrowRead("paused", [], height),
        read(orchestrator, orchestratorAbi, "paused", [], height),
        read(
          config.settlement.asset_id as Address,
          erc20Abi,
          "balanceOf",
          [options.wallet],
          height,
        ),
      ]);
      if (
        paused !== false ||
        orchestratorPaused !== false ||
        typeof balance !== "bigint" ||
        balance <= 0n
      )
        broken();
      const data = z
        .object({
          DepositPaymentMethod: z
            .array(
              z.object({
                depositId: z.string(),
                depositIdOnContract: uint,
                paymentMethodHash: hex32,
              }),
            )
            .max(32),
          MethodCurrency: z
            .array(z.object({ depositId: z.string(), depositIdOnContract: uint }))
            .max(32),
        })
        .parse(
          await query(TEMPLATE_QUERY, {
            method: config.rails[rail].paymentMethodHash.toLowerCase(),
            currency: config.currencyHash.toLowerCase(),
          }),
        );
      const candidate = data.DepositPaymentMethod.find(
        (p) =>
          p.depositId.toLowerCase() ===
            `8453_${config.escrow.toLowerCase()}_${p.depositIdOnContract}` &&
          data.MethodCurrency.some((c) => c.depositId === p.depositId),
      );
      if (!candidate) broken();
      const id = BigInt(candidate.depositIdOnContract),
        method = config.rails[rail].paymentMethodHash;
      const [raw, active, listed, rate, oracleRaw, floorRaw] = await Promise.all([
        escrowRead("getDeposit", [id], height),
        escrowRead("getDepositPaymentMethodActive", [id, method], height),
        escrowRead("getDepositCurrencyListed", [id, method, config.currencyHash], height),
        // ARM's effective-rate read reverts/returns unusable data on a stale oracle feed.
        escrowRead("getEffectiveRate", [id, method, config.currencyHash], height),
        escrowRead("getDepositOracleRateConfig", [id, method, config.currencyHash], height),
        escrowRead("getDepositCurrencyMinRate", [id, method, config.currencyHash], height),
      ]);
      const source = tupleDeposit.parse(raw);
      const oracle = z
        .object({
          adapter: addr,
          adapterConfig: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
          spreadBps: z.number().int().min(-32768).max(32767),
          maxStaleness: z.number().int().min(0).max(4294967295),
        })
        .parse(oracleRaw);
      if (typeof floorRaw !== "bigint" || floorRaw < 0n) broken();
      if (
        !same(source.token, config.settlement.asset_id) ||
        active !== true ||
        listed !== true ||
        typeof rate !== "bigint" ||
        rate <= 0n
      )
        broken();
      // Live template intent ranges deliberately narrow our new order policy, not a claim
      // about platform-wide bounds. The actual prepared deposit is simulated before handoff.
      const maximum =
        source.intentAmountRange.max < balance ? source.intentAmountRange.max : balance;
      if (source.intentAmountRange.min <= 0n || maximum < source.intentAmountRange.min) broken();
      return {
        minimum: atomic(source.intentAmountRange.min),
        maximum: atomic(maximum),
        conversionRate: atomic(rate),
        ...(!same(oracle.adapter, zero)
          ? {
              oracle: {
                ...oracle,
                adapter: oracle.adapter as Address,
                adapterConfig: oracle.adapterConfig as Hex,
                floor: atomic(floorRaw),
              },
            }
          : {}),
        validUntil: new Date(now() + 20_000).toISOString(),
      };
    } catch {
      broken();
    }
  }
  async function receipt(hash: string, owner: string, expected?: PreparedTransaction) {
    const height = await block();
    const [tx, result] = await Promise.all([
      options.publicClient.getTransaction({ hash: hash as Hex }),
      options.publicClient.getTransactionReceipt({ hash: hash as Hex }),
    ]);
    if (
      !same(tx.from, owner) ||
      !tx.to ||
      tx.chainId !== 8453 ||
      result.blockNumber > height ||
      result.transactionHash.toLowerCase() !== hash.toLowerCase()
    )
      broken();
    if (
      expected &&
      (!same(tx.to, expected.to) ||
        tx.input.toLowerCase() !== expected.data.toLowerCase() ||
        tx.value !== expected.value ||
        expected.chainId !== 8453)
    )
      broken();
    return { tx, result };
  }
  function creationId(
    logs: Awaited<ReturnType<MakerPublicClient["getTransactionReceipt"]>>["logs"],
    owner: string,
  ): { depositId: string; amount: string } {
    const found: { depositId: string; amount: string }[] = [];
    for (const log of logs) {
      if (!same(log.address, escrow)) continue;
      try {
        const decoded = decodeEventLog({
          abi: escrowAbi,
          eventName: "DepositReceived",
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
        });
        const args = z
          .object({
            depositId: z.bigint().nonnegative(),
            depositor: addr,
            token: addr,
            amount: z.bigint().positive(),
          })
          .parse(decoded.args);
        if (same(args.depositor, owner) && same(args.token, config.settlement.asset_id))
          found.push({ depositId: atomic(args.depositId), amount: atomic(args.amount) });
      } catch {
        /* Other escrow event. */
      }
    }
    if (found.length !== 1) broken();
    return found[0];
  }
  const reads: Pick<PeerMakerIO, "readiness" | "allowance" | "deposit" | "reconcile"> = {
    async readiness(intent, rail): Promise<MakerReadiness> {
      await terms(intent, rail);
      return {
        oracleFresh: true,
        requiresIdentityAttestation: ["wise", "paypal", "alipay"].includes(rail),
        identityAttested: false,
        // Registration alone does not prove Seller Autopilot eligibility. Until a
        // public authoritative readiness source resolves these rails, keep setup closed.
        sellerSetup:
          options.registered(rail) && !["venmo", "cashapp", "paypal", "xmoney"].includes(rail)
            ? "ready"
            : "required",
      };
    },
    async allowance(owner, amount) {
      try {
        const value = await read(
          config.settlement.asset_id as Address,
          erc20Abi,
          "allowance",
          [owner, escrow],
          await block(),
        );
        return typeof value === "bigint" && value >= BigInt(atomic(amount));
      } catch {
        broken();
      }
    },
    async reconcile(hash, action, owner, expected): Promise<MakerReconciliation> {
      try {
        const { result } = await receipt(hash, owner, expected);
        if (result.status === "reverted") return { state: "reverted" };
        return action === "create_deposit"
          ? { state: "confirmed", ...creationId(result.logs, owner) }
          : { state: "confirmed" };
      } catch {
        return { state: "pending" };
      }
    },
    async deposit(depositId, owner): Promise<MakerDepositFacts> {
      try {
        const id = atomic(depositId),
          height = await block();
        const composite = `8453_${escrow.toLowerCase()}_${id}`;
        const data = z
          .object({
            Deposit_by_pk: indexedDeposit,
            Intent: z
              .array(
                z.object({
                  intentHash: hex32,
                  amount: uint,
                  status: z.string(),
                  releasedAmount: uint.nullable(),
                  orchestratorAddress: addr,
                }),
              )
              .max(1000),
            DepositFundActivity: z
              .array(z.object({ activityType: z.string(), amount: uint, blockNumber: uint }))
              .max(1000),
          })
          .parse(await query(DEPOSIT_QUERY, { id: composite }));
        const index = data.Deposit_by_pk;
        if (
          index.depositId !== id ||
          !same(index.escrowAddress, escrow) ||
          !same(index.depositor, owner) ||
          !same(index.token, config.settlement.asset_id) ||
          BigInt(index.blockNumber) > height
        )
          broken();
        const [raw, rawHashes] = await Promise.all([
          escrowRead("getDeposit", [BigInt(id)], height),
          escrowRead("getDepositIntentHashes", [BigInt(id)], height),
        ]);
        const chain = tupleDeposit.parse(raw),
          hashes = z.array(hex32).max(1000).parse(rawHashes);
        const remaining = chain.remainingDeposits,
          outstanding = chain.outstandingIntentAmount;
        // A closed deposit may clear its owner/token tuple. Its confirmed creation receipt
        // and the indexer still establish owner/asset; balances must agree exactly.
        if (
          (!same(chain.depositor, owner) &&
            !(same(chain.depositor, zero) && index.status !== "ACTIVE")) ||
          (!same(chain.token, config.settlement.asset_id) &&
            !(same(chain.token, zero) && index.status !== "ACTIVE")) ||
          remaining !== BigInt(index.remainingDeposits) ||
          outstanding !== BigInt(index.outstandingIntentAmount)
        )
          broken();
        let unmatched = remaining;
        if (remaining > 0n) {
          const viewerAddress = contracts.addresses.protocolViewerV4,
            viewerAbi = contracts.abis.protocolViewerV4;
          if (!viewerAddress || !viewerAbi) broken();
          const viewer = z
            .object({
              depositId: z.bigint().nonnegative(),
              availableLiquidity: z.bigint().nonnegative(),
              deposit: tupleDeposit,
            })
            .parse(
              await read(
                viewerAddress as Address,
                viewerAbi,
                "getDeposit",
                [escrow, BigInt(id)],
                height,
              ),
            );
          if (
            viewer.depositId !== BigInt(id) ||
            viewer.deposit.remainingDeposits !== remaining ||
            viewer.deposit.outstandingIntentAmount !== outstanding ||
            viewer.availableLiquidity > remaining
          )
            broken();
          unmatched = viewer.availableLiquidity;
        }
        const active = data.Intent.filter((i) => i.status === "SIGNALED");
        if (
          new Set(active.map((i) => i.intentHash.toLowerCase())).size !== hashes.length ||
          !hashes.every((h) => active.some((i) => same(i.intentHash, h)))
        )
          broken();
        let activeAmount = 0n;
        for (const item of active) {
          if (!same(item.orchestratorAddress, orchestrator)) broken();
          const intent = z
            .object({
              escrow: addr,
              depositId: z.bigint().nonnegative(),
              amount: z.bigint().nonnegative(),
            })
            .parse(
              await read(orchestrator, orchestratorAbi, "getIntent", [item.intentHash], height),
            );
          if (
            !same(intent.escrow, escrow) ||
            intent.depositId !== BigInt(id) ||
            intent.amount !== BigInt(item.amount)
          )
            broken();
          activeAmount += intent.amount;
        }
        if (activeAmount !== outstanding) broken();
        const filled = data.Intent.filter((i) => i.status === "FULFILLED").reduce((n, i) => {
          if (i.releasedAmount === null) broken();
          return n + BigInt(i.releasedAmount);
        }, 0n);
        const withdrawn = data.DepositFundActivity.filter(
          (a) => a.activityType === "WITHDRAWN" || a.activityType === "CLOSED",
        ).reduce((n, a) => {
          if (BigInt(a.blockNumber) > height) broken();
          return n + BigInt(a.amount);
        }, 0n);
        if (filled !== BigInt(index.totalAmountTaken) || withdrawn !== BigInt(index.totalWithdrawn))
          broken();
        return {
          remaining: atomic(remaining + outstanding),
          unmatched: atomic(unmatched),
          filled: atomic(filled),
          withdrawn: atomic(withdrawn),
          activeIntents: active.length,
          closed: index.status !== "ACTIVE",
        };
      } catch {
        throw new Error("peer_in_doubt");
      }
    },
  };
  return {
    reads,
    executionTerms: terms,
    async makerEvidence(intent: RampIntent, rail: string) {
      const value = await terms(intent, rail);
      const ready = await reads.readiness(intent, rail);
      return {
        observed_at: new Date(now()).toISOString(),
        valid_until: value.validUntil,
        rail,
        currency: "USD",
        chain_id: "eip155:8453",
        asset_id: config.settlement.asset_id,
        decimals: 6,
        ...(intent.region ? { region: intent.region } : {}),
        rate: { numerator: value.conversionRate, denominator: "1000000000000000000" },
        bounds: { minimum: value.minimum, maximum: value.maximum },
        fees: [],
        pricing_revision: digest([
          value.oracle ?? "manual",
          value.conversionRate,
          value.minimum,
          value.maximum,
        ]),
        credential:
          ready.sellerSetup === "ready" && !ready.requiresIdentityAttestation
            ? "verified"
            : "missing",
        wallet: options.wallet,
      };
    },
    async rebuild(mapping: ProtectedMakerMapping, pendingWithdrawalHash?: string) {
      if (!mapping.creationTxHash) return { state: "pending" as const };
      if (mapping.depositId !== null && BigInt(mapping.legRevision) % 2n === 1n) {
        if (!pendingWithdrawalHash) return { state: "pending" as const };
        try {
          const { tx, result } = await receipt(pendingWithdrawalHash, options.wallet);
          if (
            !tx.to ||
            !same(tx.to, escrow) ||
            tx.value !== 0n ||
            !["success", "reverted"].includes(result.status)
          )
            broken();
          const decoded = decodeFunctionData({ abi: escrowAbi, data: tx.input });
          if (
            !["removeFunds", "withdrawDeposit"].includes(decoded.functionName) ||
            !decoded.args ||
            BigInt(String(decoded.args[0])) !== BigInt(mapping.depositId)
          )
            broken();
        } catch {
          return { state: "pending" as const };
        }
      }
      try {
        const { tx, result } = await receipt(mapping.creationTxHash, options.wallet);
        if (!tx.to || !same(tx.to, escrow) || tx.value !== 0n || result.status !== "success")
          return { state: "pending" as const };
        if (decodeFunctionData({ abi: escrowAbi, data: tx.input }).functionName !== "createDeposit")
          broken();
        const creation = creationId(result.logs, options.wallet);
        if (mapping.depositId !== null && mapping.depositId !== creation.depositId) broken();
        return { state: "confirmed" as const, ...creation };
      } catch {
        return { state: "pending" as const };
      }
    },
  };
}
