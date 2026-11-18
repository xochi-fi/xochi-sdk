import { atomic, type RampIntent } from "@xochi/client";
import type { PreparedTransaction, Zkp2pClient } from "@zkp2p/sdk";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import {
  boundedPeerRead,
  checkPeerAbort,
  PeerReadAborted,
  peerConfiguration,
} from "./discovery.js";
import {
  MakerSetupRequired,
  MakerWithdrawalBlocked,
  type PeerMakerIO,
  type MakerReadiness,
} from "./offramp.js";
import type { PeerDiscoveryOptions } from "./types.js";

/** Only unsigned SDK methods are admitted; no wallet client, key, send or signature method. */
export type UnsignedMakerSDK = Pick<
  Zkp2pClient,
  "registerPayeeDetails" | "prepareCreateDeposit"
> & {
  removeFunds: Pick<Zkp2pClient["removeFunds"], "prepare">;
  withdrawDeposit: Pick<Zkp2pClient["withdrawDeposit"], "prepare">;
};
export interface MakerExecutionTerms {
  /** Current provider/protocol bounds and price, independently of buyer quotes. */
  minimum: string;
  maximum: string;
  conversionRate: string;
  validUntil: string;
}
/**
 * Construct the SDK-backed write preparation port. The application's trusted read layer supplies
 * authoritative chain/indexer reconciliation and oracle/account reads. Missing reads fail closed;
 * no packaged catalog, guessed seller status or buyer price is substituted for maker evidence.
 */
export function createSDKMakerIO(options: {
  sdk: UnsignedMakerSDK;
  discovery?: PeerDiscoveryOptions;
  reads: Pick<PeerMakerIO, "readiness" | "allowance" | "reconcile" | "deposit">;
  executionTerms(
    intent: RampIntent,
    rail: string,
    signal?: AbortSignal,
  ): Promise<MakerExecutionTerms & { capabilityRevision: string }>;
}): PeerMakerIO {
  const config = peerConfiguration(options.discovery);
  const now = options.discovery?.now ?? Date.now;
  const escrow = config.escrow as Address;
  const token = config.settlement.asset_id as Address;
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PeerReadAborted) throw error;
      // Read only an explicit bounded discriminator, never the raw message or response body.
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const explicitRefusal =
        error instanceof Error &&
        /(?:seller autopilot|seller credential|identity attestation).*(?:required|must be enabled)|(?:requires?|must enable|must link).*(?:seller autopilot|seller credential|identity attestation)/i.test(
          error.message,
        );
      if (
        explicitRefusal ||
        code === "SELLER_AUTOPILOT_REQUIRED" ||
        code === "SELLER_CREDENTIAL_REQUIRED" ||
        code === "IDENTITY_ATTESTATION_REQUIRED"
      )
        throw new MakerSetupRequired();
      if (code === "ACTIVE_INTENT_BLOCKS_WITHDRAWAL") throw new MakerWithdrawalBlocked();
      throw new Error("provider_declined");
    }
  }
  return {
    ...options.reads,
    async readiness(intent, rail, signal): Promise<MakerReadiness> {
      const ready = await boundedPeerRead(
        (bound) => options.reads.readiness(intent, rail, bound),
        signal,
      );
      checkPeerAbort(signal);
      // The identity requirement is independently documented even when catalog metadata omits it.
      return {
        ...ready,
        requiresIdentityAttestation:
          ready.requiresIdentityAttestation || ["wise", "paypal", "alipay"].includes(rail),
      };
    },
    registerOwnPayee(rail, ownAccount) {
      return guarded(async () => {
        // The SDK posts to /v2/makers/create; response and original account stay in this port.
        const registered = await options.sdk.registerPayeeDetails({
          processorNames: [rail],
          payeeData: [{ offchainId: ownAccount }],
        });
        if (
          registered.hashedOnchainIds.length !== 1 ||
          !/^0x[0-9a-fA-F]{64}$/.test(registered.hashedOnchainIds[0])
        )
          throw new Error("provider_declined");
        return registered.hashedOnchainIds[0];
      });
    },
    async prepareApproval(amount): Promise<PreparedTransaction> {
      return {
        chainId: 8453,
        to: token,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [escrow, BigInt(atomic(amount))],
        }),
      };
    },
    prepareDeposit(input, signal) {
      checkPeerAbort(signal);
      return guarded(async () => {
        const terms = await boundedPeerRead(
          (bound) => options.executionTerms(input.intent, input.rail, bound),
          signal,
        );
        checkPeerAbort(signal);
        const amount = BigInt(atomic(input.amount));
        const min = BigInt(atomic(terms.minimum)),
          max = BigInt(atomic(terms.maximum));
        const rate = BigInt(atomic(terms.conversionRate));
        if (
          terms.capabilityRevision !== input.capabilityRevision ||
          min === 0n ||
          min > max ||
          amount < min ||
          amount > max ||
          rate === 0n ||
          Date.parse(terms.validUntil) <= now() ||
          !Number.isFinite(Date.parse(terms.validUntil))
        )
          throw new Error("capability_unavailable");
        const result = await options.sdk.prepareCreateDeposit({
          token,
          escrowAddress: escrow,
          amount,
          intentAmountRange: { min, max: max < amount ? max : amount },
          processorNames: [input.rail],
          payeeDetailsHashes: [input.payeeHash],
          // The SDK manual-rate path encodes this as the floor with a zero adapter.
          conversionRates: [
            [{ currency: input.intent.fiat.currency, conversionRate: terms.conversionRate }],
          ],
          retainOnEmpty: false,
        });
        checkPeerAbort(signal);
        return result.prepared;
      });
    },
    prepareWithdrawal(depositId, amount, full) {
      return guarded(() =>
        full
          ? options.sdk.withdrawDeposit.prepare({
              depositId: BigInt(atomic(depositId)),
              escrowAddress: escrow,
            })
          : options.sdk.removeFunds.prepare({
              depositId: BigInt(atomic(depositId)),
              amount: BigInt(atomic(amount)),
              escrowAddress: escrow,
            }),
      );
    },
  };
}
