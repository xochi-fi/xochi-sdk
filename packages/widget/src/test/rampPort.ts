/**
 * In-memory Peer discovery for tests and the screenshot harness: S2's real
 * `fetchPeerCapabilities` over the recorded public USD/Base USDC response
 * (ramp/peer/fixtures), with a settable clock. No network.
 *
 * The recording quotes 25 USDC to the public burn address; `recordedReads`
 * rewrites the quote recipient to the account under test, and can mark rails
 * as needing Peer stake (setup_required). Maker evidence is synthetic, as in
 * S2's own tests: no live maker capability has been recorded.
 */

import type { RampIntent } from "@xochi/client";
import recorded from "../ramp/peer/fixtures/usd-best-by-platform.json";
import { fetchPeerCapabilities, peerConfiguration } from "../ramp/peer/index.js";
import type { PeerDiscoveryReads } from "../ramp/peer/index.js";
import type { RampDiscoveryPort } from "../ramp/availability/useRampDiscovery.js";

export const RECORDED_AMOUNT = "25";
export const RECORDED_AT = Date.parse(recorded.responseObject.quoteExpiresAt) - 20_000;

export interface Clock {
  t: number;
}

export interface RecordedOptions {
  account: string;
  /** Rails whose recorded quote requires Peer dispute stake. */
  stakeRails?: readonly string[];
  /** Offramp rails with synthetic, verified maker evidence. */
  makerRails?: readonly string[];
  clock: Clock;
}

export function recordedReads({
  account,
  stakeRails = [],
  makerRails = [],
  clock,
}: RecordedOptions): PeerDiscoveryReads {
  const settlement = peerConfiguration().settlement;
  return {
    async bestByPlatform() {
      const raw = structuredClone(recorded);
      for (const p of raw.responseObject.platformQuotes) {
        if (!p.bestQuote) continue;
        p.bestQuote.intent.toAddress = account;
        if (stakeRails.includes(p.platform)) p.bestQuote.disputeProtectionRequiresStake = true;
      }
      return raw;
    },
    async quote() {
      throw new Error("not recorded");
    },
    async makerEvidence(intent: RampIntent, rail: string) {
      if (!makerRails.includes(rail)) return undefined;
      return {
        observed_at: new Date(clock.t).toISOString(),
        valid_until: new Date(clock.t + 20_000).toISOString(),
        rail,
        currency: intent.fiat.currency,
        chain_id: "eip155:8453",
        asset_id: settlement.asset_id,
        decimals: 6,
        rate: { numerator: "99", denominator: "100" },
        bounds: { minimum: "1000000", maximum: "1000000000" },
        fees: [],
        credential: "verified",
        wallet: account,
      };
    },
  };
}

/** A discovery port over `reads`; `calls` records each discovery's exact amount. */
export function recordedPort(
  options: RecordedOptions,
  reads: PeerDiscoveryReads = recordedReads(options),
): RampDiscoveryPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    discover(intent, user) {
      calls.push(intent.exact.money.atomic);
      return fetchPeerCapabilities(intent, { user, reads, now: () => options.clock.t });
    },
    settlement: () => peerConfiguration().settlement,
    now: () => options.clock.t,
    debounceMs: 0,
  };
}
