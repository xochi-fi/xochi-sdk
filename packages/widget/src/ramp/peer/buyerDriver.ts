import { PEER_ENVIRONMENT } from "../../config.js";
import type { RampIntent, RampPreview } from "@xochi/client";
import {
  apiGetPayeeDetails,
  apiSignIntentV3Raw,
  resolveFiatCurrencyBytes32,
  Zkp2pClient,
  DISPUTE_PROTECTION_POLICY_V2_ABI,
  getContracts,
  parseDeferredPayoutFromLogs,
  type PreparedTransaction,
} from "@zkp2p/sdk";
import {
  erc20Abi,
  formatUnits,
  parseEventLogs,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { z } from "zod";
import { boundedPeerRead, peerConfiguration } from "./discovery.js";
import { digest, normalizePeerQuotes } from "./normalization.js";
import type { PeerDiscoveryOptions } from "./types.js";
import type { PeerBuyerDriver, PeerResumeResult } from "./onramp.js";
import {
  PEER_ATTESTATION_ORIGIN,
  PeerSigningSetupRequired,
  peerRequiresLinkedSession,
} from "./onramp.js";

const buyerEvents = [
  {
    type: "event",
    name: "IntentSignaled",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "escrow", type: "address", indexed: true },
      { name: "depositId", type: "uint256", indexed: true },
      { name: "paymentMethod", type: "bytes32", indexed: false },
      { name: "owner", type: "address", indexed: false },
      { name: "to", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "fiatCurrency", type: "bytes32", indexed: false },
      { name: "conversionRate", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
      { name: "groupId", type: "bytes32", indexed: false },
      { name: "arbitrator", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "IntentFulfilled",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "fundsTransferredTo", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "releasedBy", type: "address", indexed: false },
    ],
  },
] as const;
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const executionQuote = z.object({
  conversionRate: uint,
  signalIntentAmount: uint,
  intent: z.object({
    depositId: z.union([uint, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
    escrowAddress: address,
    payeeDetails: hex32,
    toAddress: address,
    processorName: z.string(),
    fiatCurrencyCode: z.string(),
  }),
});
const urls = {
  production: "https://api.zkp2p.xyz",
  preproduction: "https://api-preprod.zkp2p.xyz",
  staging: "https://api-staging.zkp2p.xyz",
};
interface Binding {
  intent: Pick<RampIntent, "recipient" | "fiat">;
  depositId: bigint;
  amount: bigint;
  expectedNetAmount: bigint;
  conversionRate: bigint;
  paymentMethod: string;
  payeeDetails: string;
  signalBlock: bigint;
  fulfillHash?: Hex;
  held?: { vault: Address; amount: bigint; block: bigint };
}
/** A receipt must contain the exact reviewed USDC amount paid to this recipient. */
export function peerRecipientTransfer(
  logs: Parameters<typeof parseEventLogs>[0]["logs"],
  token: string,
  recipient: string,
  amount: bigint,
  from?: string,
): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs }).some(
    (log) =>
      same(log.address, token) &&
      same(log.args.to, recipient) &&
      log.args.value === amount &&
      (!from || same(log.args.from, from)),
  );
}

/** SDK wallet writes are prepared separately, then submitted through the connected wallet. */
export function createPeerBuyerDriver(
  options: PeerDiscoveryOptions & { wallet: WalletClient; publicClient: PublicClient },
): PeerBuyerDriver {
  const config = peerConfiguration(options);
  const environment = options.environment ?? PEER_ENVIRONMENT;
  const escrowAbi = getContracts(8453, environment).abis.escrowV2;
  if (!escrowAbi) throw new Error("capabilities_unavailable");
  const account = options.wallet.account;
  if (!account || options.publicClient.chain?.id !== 8453) throw new Error("invalid_request");
  const sdk = new Zkp2pClient({
    walletClient: options.wallet,
    chainId: 8453,
    runtimeEnv: environment,
    baseApiUrl: urls[environment],
  });
  const bindings = new Map<string, Binding>();
  async function send(prepared: PreparedTransaction): Promise<Hex> {
    if (
      prepared.chainId !== 8453 ||
      prepared.to.toLowerCase() !== config.orchestrator.toLowerCase() ||
      prepared.value !== 0n ||
      (await options.wallet.getChainId()) !== 8453 ||
      (await options.wallet.getAddresses())[0]?.toLowerCase() !== account!.address.toLowerCase()
    )
      throw new Error("invalid_request");
    return options.wallet.sendTransaction({
      account: account!,
      chain: options.wallet.chain,
      to: prepared.to,
      data: prepared.data,
      value: prepared.value,
    });
  }
  async function confirmed(hash: Hex) {
    const receipt = await options.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
    });
    if (receipt.status !== "success") throw new Error("provider_declined");
    return receipt;
  }
  function same(a: string, b: string) {
    return a.toLowerCase() === b.toLowerCase();
  }
  function paid(
    logs: Parameters<typeof parseEventLogs>[0]["logs"],
    recipient: string,
    amount: bigint,
    from?: string,
  ) {
    return peerRecipientTransfer(logs, config.settlement.asset_id, recipient, amount, from);
  }

  return {
    async quote(intent, offer, signal) {
      if (!same(intent.recipient, account.address)) throw new Error("invalid_request");
      const request = {
        fiatCurrency: intent.fiat.currency,
        user: account.address,
        recipient: intent.recipient,
        destinationChainId: 8453,
        destinationToken: config.settlement.asset_id,
        escrowAddresses: [config.escrow],
        amount:
          intent.exact.side === "fiat"
            ? formatUnits(BigInt(intent.exact.money.atomic), intent.fiat.decimals)
            : intent.exact.money.atomic,
        isExactFiat: intent.exact.side === "fiat",
        mode: "eligible" as const,
        quotePreference: "EXCLUSIVE_BUYER_TEE" as const,
        paymentPlatforms: [offer.rail.id],
        quotesToReturn: 1,
        includeNearbyQuotes: false,
      };
      const raw = await boundedPeerRead(async (readSignal) => {
        if (options.reads) return options.reads.quote(request, readSignal);
        const { amount, isExactFiat, quotesToReturn, ...body } = request;
        const response = await fetch(
          `${urls[environment]}/v3/quote/${isExactFiat ? "exact-fiat" : "exact-token"}?quotesToReturn=${quotesToReturn}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: readSignal,
            body: JSON.stringify({
              ...body,
              [isExactFiat ? "exactFiatAmount" : "exactTokenAmount"]: amount,
            }),
          },
        );
        if (!response.ok) throw new Error("capabilities_unavailable");
        return response.json();
      }, signal);
      const normalized = normalizePeerQuotes(
        raw,
        intent,
        config,
        (options.now ?? Date.now)(),
        offer.rail.id,
      )[0];
      if (
        !normalized ||
        normalized.offer.availability.state !== "available" ||
        normalized.offer.capability_revision !== offer.capability_revision
      )
        throw new Error("quote_changed");
      const rows = z
        .object({ responseObject: z.object({ quotes: z.array(executionQuote).length(1) }) })
        .parse(raw).responseObject.quotes;
      const q = rows[0];
      if (
        !same(q.intent.escrowAddress, config.escrow) ||
        !same(q.intent.toAddress, intent.recipient) ||
        q.intent.processorName !== offer.rail.id
      )
        throw new Error("quote_changed");
      const preview: RampPreview = {
        contract_version: "ramp/1",
        kind: "preview",
        operation_id: crypto.randomUUID(),
        quote_id: crypto.randomUUID(),
        offer_id: offer.offer_id,
        capability_revision: offer.capability_revision,
        request_digest: digest(intent),
        pay: normalized.pay,
        receive: normalized.receive,
        fees: normalized.fees,
        expires_at: normalized.offer.availability.valid_until,
        leg_order: ["peer"],
        disclosures: normalized.offer.disclosures,
      };
      return {
        preview,
        paymentRecipient: "",
        async signal() {
          if (Date.parse(preview.expires_at) <= (options.now ?? Date.now)())
            throw new Error("quote_expired");
          const signed = await apiSignIntentV3Raw(
            {
              processorName: offer.rail.id,
              payeeDetails: q.intent.payeeDetails,
              depositId: String(q.intent.depositId),
              amount: q.signalIntentAmount,
              toAddress: intent.recipient as Address,
              paymentMethod: config.rails[offer.rail.id].paymentMethodHash as Hex,
              fiatCurrency: resolveFiatCurrencyBytes32(intent.fiat.currency),
              conversionRate: q.conversionRate,
              chainId: "8453",
              orchestratorAddress: config.orchestrator as Address,
              escrowAddress: config.escrow as Address,
              callerAddress: account.address,
              referralFees: [],
            },
            { baseApiUrl: urls[environment], timeoutMs: 10_000 },
          ).catch((error: unknown) => {
            if (peerRequiresLinkedSession(error)) throw new PeerSigningSetupRequired();
            throw new Error("provider_declined");
          });
          if (signed.gating !== "curator-signed") throw new Error("provider_declined");
          const response = signed.response;
          const expiry = response.intentData?.signatureExpiration ?? response.signatureExpiration;
          if (
            !response.offchainId ||
            response.offchainId.length > 512 ||
            !expiry ||
            !/^[1-9][0-9]*$/.test(expiry) ||
            !response.intentData?.payerCommitment ||
            (response.referralFees?.length ?? response.intentData?.referralFees?.length ?? 0) !== 0
          )
            throw new Error("quote_changed");
          const tx = await sdk.signalIntent.prepare({
            gatingServiceSignature: response.signedIntent,
            signatureExpiration: expiry,
            payerCommitment: response.intentData.payerCommitment as Hex,
            depositId: BigInt(q.intent.depositId),
            amount: q.signalIntentAmount,
            toAddress: intent.recipient as Address,
            processorName: offer.rail.id,
            payeeDetails: q.intent.payeeDetails,
            fiatCurrencyCode: intent.fiat.currency,
            conversionRate: q.conversionRate,
            escrowAddress: config.escrow as Address,
            orchestratorAddress: config.orchestrator as Address,
          });
          // Gating/prepare can take time: expiry is checked again before the wallet prompt.
          if (Date.parse(preview.expires_at) <= (options.now ?? Date.now)())
            throw new Error("quote_expired");
          const receipt = await confirmed(await send(tx));
          const events = parseEventLogs({
            abi: buyerEvents,
            eventName: "IntentSignaled",
            logs: receipt.logs,
          });
          const event = events.find(
            (log) =>
              same(log.address, config.orchestrator) &&
              same(log.args.owner, account.address) &&
              same(log.args.to, intent.recipient) &&
              same(log.args.escrow, config.escrow) &&
              log.args.depositId === BigInt(q.intent.depositId) &&
              log.args.amount === BigInt(q.signalIntentAmount) &&
              log.args.conversionRate === BigInt(q.conversionRate) &&
              same(log.args.paymentMethod, config.rails[offer.rail.id].paymentMethodHash) &&
              same(log.args.fiatCurrency, resolveFiatCurrencyBytes32(intent.fiat.currency)),
          );
          if (!event) throw new Error("peer_in_doubt");
          const intentExpiry = await options.publicClient.readContract({
            address: config.escrow as Address,
            abi: escrowAbi!,
            functionName: "intentExpirationPeriod",
            blockNumber: receipt.blockNumber,
          });
          bindings.set(event.args.intentHash, {
            intent,
            depositId: BigInt(q.intent.depositId),
            amount: BigInt(q.signalIntentAmount),
            expectedNetAmount: BigInt(preview.receive.atomic),
            conversionRate: BigInt(q.conversionRate),
            paymentMethod: event.args.paymentMethod,
            payeeDetails: q.intent.payeeDetails,
            signalBlock: receipt.blockNumber,
          });
          return {
            intentHash: event.args.intentHash,
            expiresAt: Number(event.args.timestamp + BigInt(intentExpiry as bigint)) * 1000,
            paymentRecipient: response.offchainId,
            signaledAt: Number(event.args.timestamp) * 1000,
          };
        },
      };
    },
    async resume(lookup) {
      // Read-only: indexer and chain reads by the public owner address. The intent
      // hash is re-derived here and never persisted by the widget.
      if (!same(lookup.wallet, account.address)) return undefined;
      const rail = config.rails[lookup.rail];
      if (!rail) return undefined;
      const currency = resolveFiatCurrencyBytes32(lookup.currency);
      const rows = (await sdk.indexer.getOwnerIntents(account.address)).filter(
        (row) =>
          same(row.owner, account.address) &&
          same(row.toAddress, lookup.wallet) &&
          same(row.orchestratorAddress, config.orchestrator) &&
          !!row.paymentMethodHash &&
          same(row.paymentMethodHash, rail.paymentMethodHash) &&
          same(row.fiatCurrency, currency) &&
          /^[0-9]{1,20}$/.test(row.signalTimestamp) &&
          Number(row.signalTimestamp) * 1000 >= lookup.approvedAfter - 120_000,
      );
      // Ambiguity is never resolved by guessing: two candidates stay in doubt.
      if (rows.length !== 1) return undefined;
      const row = rows[0];
      const hash = row.intentHash as Hex;
      if (row.status === "PRUNED") return { kind: "expired" };
      if (row.status === "FULFILLED") {
        if (!row.fulfillTxHash || !/^0x[0-9a-fA-F]{64}$/.test(row.fulfillTxHash)) return undefined;
        bindings.set(hash, {
          intent: {
            recipient: lookup.wallet,
            fiat: { kind: "fiat", currency: lookup.currency, decimals: 6 },
          },
          depositId: BigInt(row.depositId),
          amount: BigInt(row.amount),
          expectedNetAmount: BigInt(lookup.receiveAtomic),
          conversionRate: BigInt(row.conversionRate),
          paymentMethod: rail.paymentMethodHash,
          payeeDetails: "",
          signalBlock: 0n,
          fulfillHash: row.fulfillTxHash as Hex,
        });
        return { kind: "fulfilled", intentHash: hash };
      }
      if (row.status !== "SIGNALED") return undefined;
      const live = (await sdk.getIntent(hash)).intent;
      if (
        !same(live.owner, account.address) ||
        !same(live.to, lookup.wallet) ||
        !same(live.escrow, config.escrow) ||
        !same(live.paymentMethod, rail.paymentMethodHash) ||
        !same(live.fiatCurrency, currency) ||
        !live.payeeId
      )
        return undefined;
      const period = await options.publicClient.readContract({
        address: config.escrow as Address,
        abi: escrowAbi!,
        functionName: "intentExpirationPeriod",
      });
      bindings.set(hash, {
        intent: {
          recipient: lookup.wallet,
          fiat: { kind: "fiat", currency: lookup.currency, decimals: 6 },
        },
        depositId: live.depositId,
        amount: live.amount,
        expectedNetAmount: BigInt(lookup.receiveAtomic),
        conversionRate: live.conversionRate,
        paymentMethod: live.paymentMethod,
        payeeDetails: live.payeeId,
        signalBlock: 0n,
      });
      // The payee handle is re-read for this session's instructions and capture
      // matching only; it stays in provider memory.
      const payee = await apiGetPayeeDetails(
        { hashedOnchainId: live.payeeId, processorName: lookup.rail },
        urls[environment],
        10_000,
      ).catch(() => undefined);
      const offchainId = payee?.responseObject?.offchainId;
      const result: PeerResumeResult = {
        kind: "active",
        intentHash: hash,
        signaledAt: Number(live.timestamp) * 1000,
        expiresAt: Number(live.timestamp + BigInt(period as bigint)) * 1000,
        ...(typeof offchainId === "string" && offchainId.length > 0 && offchainId.length <= 512
          ? { paymentRecipient: offchainId }
          : {}),
      };
      return result;
    },
    async fulfill(hash, proof) {
      const binding = bindings.get(hash);
      if (!binding) throw new Error("invalid_request");
      const live = (await sdk.getIntent(hash as Hex)).intent;
      if (
        !same(live.owner, account.address) ||
        !same(live.to, binding.intent.recipient) ||
        !same(live.escrow, config.escrow) ||
        live.depositId !== binding.depositId ||
        live.amount !== binding.amount ||
        live.conversionRate !== binding.conversionRate ||
        !same(live.paymentMethod, binding.paymentMethod) ||
        !same(live.fiatCurrency, resolveFiatCurrencyBytes32(binding.intent.fiat.currency)) ||
        (live.payeeId !== undefined && !same(live.payeeId, binding.payeeDetails))
      )
        throw new Error("proof_failed");
      const tx = await sdk.fulfillIntent.prepare({
        intentHash: hash as Hex,
        proof,
        orchestratorAddress: config.orchestrator as Address,
        attestationServiceUrl: PEER_ATTESTATION_ORIGIN,
        attestationServiceFallbackUrls: [],
      });
      binding.fulfillHash = await send(tx);
      await confirmed(binding.fulfillHash);
    },
    async status(hash) {
      const binding = bindings.get(hash);
      if (!binding) return "unknown";
      if (!binding.fulfillHash) return "pending";
      const receipt = await confirmed(binding.fulfillHash);
      const fulfilled = parseEventLogs({
        abi: buyerEvents,
        eventName: "IntentFulfilled",
        logs: receipt.logs,
      }).find((log) => same(log.address, config.orchestrator) && same(log.args.intentHash, hash));
      if (!fulfilled || fulfilled.args.amount !== binding.expectedNetAmount) return "unknown";
      const deferred = parseDeferredPayoutFromLogs(
        receipt.logs,
        hash as Hex,
        config.orchestrator as Address,
      );
      if (!deferred)
        return same(fulfilled.args.fundsTransferredTo, binding.intent.recipient) &&
          paid(receipt.logs, binding.intent.recipient, fulfilled.args.amount)
          ? "paid"
          : "unknown";
      if (!same(deferred.recipient, binding.intent.recipient)) return "unknown";
      binding.held = { vault: deferred.vault, amount: deferred.amount, block: receipt.blockNumber };
      const payout = await sdk.getPayoutStatus(hash as Hex);
      if (payout.state === "HELD" || payout.state === "CLAIMABLE") return "held";
      // RELEASED alone is ambiguous: a successful dispute closes the same lock.
      if (payout.state !== "RELEASED") return "held";
      const policy = getContracts(8453, environment).addresses.disputeProtectionPolicyV2;
      if (!policy) return "unknown";
      const event = DISPUTE_PROTECTION_POLICY_V2_ABI.find(
        (item) => item.type === "event" && item.name === "ProtectionReleased",
      ) as AbiEvent;
      const logs = await options.publicClient.getLogs({
        address: policy,
        event,
        args: { intentHash: hash as Hex },
        fromBlock: receipt.blockNumber,
        toBlock: "latest",
      });
      for (const log of logs) {
        if (!log.transactionHash) continue;
        const released = await confirmed(log.transactionHash);
        if (paid(released.logs, binding.intent.recipient, deferred.amount, deferred.vault))
          return "released";
      }
      return "unknown";
    },
  };
}
