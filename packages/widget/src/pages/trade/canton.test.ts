/**
 * The Canton Coin destination (xochi-sdk#116): the launch gate, the party
 * recipient sent byte for byte, public only, the refused-quote copy, the
 * escrow status mapping (a gateway completion is never a delivery), the refund
 * gate and the explorer links. Flag-dependent checks assert the relationship
 * to `CANTON_DESTINATION_LIVE` and exercise both values through the gate's
 * parameter, never the flag's current value.
 */

import { describe, expect, it } from "vitest";
import {
  CANTON_COIN_MAINNET,
  CANTON_MAINNET_CHAIN_ID,
  parseCapabilities,
  resolveRouteModel,
  type EscrowLock,
  type EscrowStatusData,
  type SolverCapabilities,
} from "@xochi/client";
import { CANTON_DESTINATION_LIVE, TOKENS, chainEnabledForRole } from "./config.js";
import {
  cantonDecline,
  cantonEscrowView,
  cantonRecipientCheck,
  cantonUpdateUrl,
  isOfferedChainId,
} from "./canton.js";
import { embedOffer, explainEmbedDefaults } from "./embedParams.js";
import { parseEmbedParams } from "@xochi/widget-lib";
import { swapExplorerLinks } from "../../lib/explorerLinks.js";
import { planResume } from "./resumeSwap.js";
import type { SwapActivityItem } from "../../types/activity.js";

const CANTON = CANTON_MAINNET_CHAIN_ID;
const BASE = 8453;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PARTY = "Alice_0x9F::1220e610231e7aef0de077733b3afb8a413f6784c8f2bb5c6607d311d3ddad2c3f4d";
const FILL_DEADLINE = 1_790_000_000;
const REFUNDABLE_AT = FILL_DEADLINE + 14_400;

const MATRIX = ((): SolverCapabilities => {
  const caps = parseCapabilities({
    chains: [
      { chain_id: BASE, chain_name: "Base", vm_type: "evm" },
      { chain_id: CANTON, chain_name: "Canton", vm_type: "cvm", address_format: "canton_party" },
    ],
    tokens: [
      { symbol: "USDC", decimals: 6, roles: ["origin"], addresses: { [BASE]: USDC_BASE } },
      {
        symbol: "CC",
        decimals: 10,
        roles: ["destination"],
        addresses: { [CANTON]: CANTON_COIN_MAINNET },
      },
    ],
    routes: [
      {
        origin: { chain_id: BASE, token: "USDC" },
        destination: { kind: "chain", chain_id: CANTON, token: "CC" },
        privacy_modes: ["public", "stealth", "shielded"],
      },
    ],
    stealth_chains: [BASE, CANTON],
  });
  if (caps === null) throw new Error("matrix did not parse");
  return caps;
})();

const model = (cantonLive: boolean) =>
  resolveRouteModel(MATRIX, "live", {
    chainEnabledForRole: (chainId, role) => chainEnabledForRole(chainId, role, cantonLive),
    presentationTokens: TOKENS,
  });

const escrow = (over: Partial<EscrowStatusData> = {}): EscrowStatusData => ({
  address: "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb",
  orderId: `0x${"ab".repeat(32)}`,
  fillDeadline: FILL_DEADLINE,
  wireStatus: "executing",
  cantonUpdateId: null,
  ...over,
});
const lock = (status: EscrowLock["status"]): EscrowLock => ({
  status,
  depositor: "0x1111111111111111111111111111111111111111",
  refundableAt: REFUNDABLE_AT,
  token: USDC_BASE,
  amount: 25_000_000n,
  toChainId: BigInt(CANTON),
});

describe("launch gate", () => {
  it("is off by default and offers Canton as a destination only with it on", () => {
    expect(chainEnabledForRole(CANTON, "destination")).toBe(CANTON_DESTINATION_LIVE);
    expect(chainEnabledForRole(CANTON, "destination", true)).toBe(true);
    expect(chainEnabledForRole(CANTON, "destination", false)).toBe(false);
    expect(chainEnabledForRole(CANTON, "origin", true)).toBe(false);
  });

  it("selects Canton only when the flag is on and the matrix advertises it", () => {
    expect(model(true).destinationChainIds).toContain(CANTON);
    expect(model(false).destinationChainIds).not.toContain(CANTON);
    expect(model(true).originChainIds).not.toContain(CANTON);
    const unadvertised = parseCapabilities({
      chains: [{ chain_id: BASE, chain_name: "Base", vm_type: "evm" }],
      tokens: [],
      routes: [],
    });
    if (unadvertised === null) throw new Error("matrix did not parse");
    expect(
      resolveRouteModel(unadvertised, "live", {
        chainEnabledForRole: (chainId, role) => chainEnabledForRole(chainId, role, true),
        presentationTokens: TOKENS,
      }).destinationChainIds,
    ).not.toContain(CANTON);
  });

  it.skipIf(CANTON_DESTINATION_LIVE)(
    "with the flag off, embed params never open on Canton even when the matrix advertises it",
    () => {
      const parsed = parseEmbedParams(`toChain=${CANTON}&toChains=${CANTON}`);
      const { defaults, ignored } = explainEmbedDefaults(parsed, embedOffer(MATRIX, true));
      expect(defaults.toChainId).not.toBe(CANTON);
      expect(defaults.toChains).toBeNull();
      expect(ignored.toChains).toBeDefined();
    },
  );

  it("offers Canton Coin only, public only", () => {
    const live = model(true);
    const cc = live.destinationTokens.get(CANTON);
    expect(cc?.map((token) => token.address)).toEqual([CANTON_COIN_MAINNET]);
    const usdc = live.originTokens.get(BASE)?.[0];
    if (!usdc || !cc?.[0]) throw new Error("route inventory missing");
    expect(
      live.resolve(
        { chainId: BASE, token: usdc },
        { kind: "chain", chainId: CANTON, token: cc[0] },
      ),
    ).toEqual({ status: "available", privacyModes: ["public"] });
  });

  it("refuses Canton for resume and local activity while the flag is off", () => {
    expect(isOfferedChainId(CANTON)).toBe(CANTON_DESTINATION_LIVE);
    expect(isOfferedChainId(CANTON, false)).toBe(false);
    expect(isOfferedChainId(CANTON, true)).toBe(true);
    expect(isOfferedChainId(BASE, false)).toBe(true);
    for (const facade of [31337, 30337]) expect(isOfferedChainId(facade, true)).toBe(false);
  });

  it("never resumes an order with a Canton origin, and Canton only with the flag on", () => {
    const record = (fromChainId: number, toChainId: number) =>
      ({
        id: "xi_1",
        type: "swap",
        status: "active",
        intentStatus: "settling",
        timestamp: 0,
        data: {
          fromChainId,
          toChainId,
          fromToken: fromChainId === CANTON ? CANTON_COIN_MAINNET : USDC_BASE,
          toToken: toChainId === CANTON ? CANTON_COIN_MAINNET : USDC_BASE,
          fromAmount: "25000000",
          toAmount: null,
          tier: "standard",
          feeRate: 0.2,
          txHash: null,
          isCrossChain: true,
        },
      }) as unknown as SwapActivityItem;
    expect(planResume(record(BASE, CANTON)) !== null).toBe(CANTON_DESTINATION_LIVE);
    expect(planResume(record(CANTON, BASE))).toBeNull();
  });
});

describe("recipient party", () => {
  it("accepts a party exactly as typed, case and 0x hint preserved", () => {
    expect(cantonRecipientCheck(PARTY)).toEqual({ valid: true });
  });

  it("refuses rather than repairs a padded paste", () => {
    for (const typed of [` ${PARTY}`, `${PARTY}\n`]) {
      expect(cantonRecipientCheck(typed)).toEqual({
        valid: false,
        error: "Remove the spaces around the party id. It is sent exactly as typed.",
      });
    }
  });

  it("refuses an EVM address, a case-folded fingerprint and an empty field", () => {
    for (const typed of [
      "0x1111111111111111111111111111111111111111",
      PARTY.replace("::1220e6", "::1220E6"),
      "",
    ]) {
      expect(cantonRecipientCheck(typed).valid).toBe(false);
    }
  });
});

describe("refused Canton quotes", () => {
  it("words recipient_not_preapproved as what to do, with a re-quote", () => {
    const decline = cantonDecline("recipient_not_preapproved");
    expect(decline?.title).toBe("This party can't receive Canton Coin yet");
    expect(decline?.detail).toMatch(/transfer preapproval/);
    expect(decline?.detail).toMatch(/Nothing was locked/);
    expect(decline?.requote).toBe(true);
  });

  it("covers every permanent escrow refusal and leaves the rest generic", () => {
    for (const category of [
      "recipient_is_solver",
      "canton_solver_requires_escrow",
      "canton_destination_not_live",
      "escrow_refused",
    ]) {
      expect(cantonDecline(category)).not.toBeNull();
    }
    for (const category of ["no_liquidity", "amount_too_large", undefined]) {
      expect(cantonDecline(category)).toBeNull();
    }
  });
});

describe("escrow status to UI", () => {
  const at = (nowSec: number, e: EscrowStatusData | null, l: EscrowLock | null = null) =>
    cantonEscrowView({ escrow: e, lock: l, nowSec });

  it.each([
    ["pending", null, "awaiting_open"],
    ["executing", null, "awaiting_delivery"],
    ["executing", "1220ab::upd", "delivered"],
    ["completed", "1220ab::upd", "claimed"],
    ["refund_pending", null, "refundable"],
    ["refunded", null, "refunded"],
    ["expired", null, "expired"],
  ] as const)("%s (update %s) reads %s", (wireStatus, cantonUpdateId, want) => {
    expect(at(FILL_DEADLINE, escrow({ wireStatus, cantonUpdateId })).progress).toBe(want);
  });

  it("never reads delivered or claimed from a completed status without an attestation", () => {
    expect(at(FILL_DEADLINE, escrow({ wireStatus: "completed" })).progress).toBe("unknown");
    expect(at(FILL_DEADLINE, null).progress).toBe("unknown");
    expect(at(FILL_DEADLINE, escrow({ wireStatus: "settling" })).progress).toBe(
      "awaiting_delivery",
    );
  });

  it("takes claimed and refunded from the lock, and an open lock as locked", () => {
    expect(at(FILL_DEADLINE, escrow({ wireStatus: "completed" }), lock("claimed")).progress).toBe(
      "claimed",
    );
    expect(at(REFUNDABLE_AT, escrow(), lock("refunded")).progress).toBe("refunded");
    expect(at(FILL_DEADLINE, escrow({ wireStatus: "pending" }), lock("open")).progress).toBe(
      "awaiting_delivery",
    );
  });

  it("opens the refund only at refundableAt with the lock still open", () => {
    const before = at(REFUNDABLE_AT - 1, escrow(), lock("open"));
    expect(before).toMatchObject({ progress: "awaiting_delivery", refundOpen: false });
    expect(before.refundableAt).toBe(REFUNDABLE_AT);
    expect(at(REFUNDABLE_AT, escrow(), lock("open"))).toMatchObject({
      progress: "refundable",
      refundOpen: true,
    });
    // The venue's refund_pending with no lock read yet: refundable, but not sendable.
    expect(at(REFUNDABLE_AT, escrow({ wireStatus: "refund_pending" }))).toMatchObject({
      progress: "refundable",
      refundOpen: false,
    });
    expect(at(REFUNDABLE_AT, escrow(), lock("claimed")).refundOpen).toBe(false);
  });
});

describe("explorer links", () => {
  it("links the attested update on ccview and the lock on Basescan", () => {
    expect(cantonUpdateUrl("1220ab::Upd")).toBe("https://ccview.io/updates/1220ab%3A%3AUpd");
    const lockTx = `0x${"cd".repeat(32)}`;
    expect(
      swapExplorerLinks({
        fromChainId: BASE,
        toChainId: CANTON,
        txHash: lockTx,
        settlementTxHash: `0x${"ef".repeat(32)}`,
        settlementChainId: CANTON,
        cantonUpdateId: "1220ab::Upd",
      }),
    ).toEqual({
      source: `https://basescan.org/tx/${lockTx}`,
      destination: "https://ccview.io/updates/1220ab%3A%3AUpd",
    });
  });

  it("links no Canton delivery before Riddler attests one", () => {
    expect(
      swapExplorerLinks({
        fromChainId: BASE,
        toChainId: CANTON,
        txHash: null,
        settlementTxHash: `0x${"ef".repeat(32)}`,
        settlementChainId: CANTON,
      }).destination,
    ).toBeNull();
  });
});
