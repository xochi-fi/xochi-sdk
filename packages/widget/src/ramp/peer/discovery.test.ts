import { describe, expect, it, vi } from "vitest";
import { atomic, checkRampOffer, parseRamp, type RampIntent } from "@xochi/client";
import recorded from "./fixtures/usd-best-by-platform.json";
import { boundedPeerRead, fetchPeerCapabilities, peerConfiguration } from "./discovery.js";
import { normalizePeerQuotes } from "./normalization.js";
import { previewPeerOffer } from "./preview.js";
import type { PeerDiscoveryReads } from "./types.js";
const config = peerConfiguration();
const now = Date.parse(recorded.responseObject.quoteExpiresAt) - 20_000;
const wallet = "0x000000000000000000000000000000000000dEaD";
function intent(direction: "onramp" | "offramp" = "onramp"): RampIntent {
  return {
    contract_version: "ramp/1",
    kind: "intent",
    direction,
    fiat: { kind: "fiat", currency: "USD", decimals: 6 },
    crypto: config.settlement,
    exact: { side: "crypto", money: { asset: config.settlement, atomic: atomic("25000000") } },
    recipient: wallet,
  };
}
function fixture() {
  return structuredClone(recorded);
}
function single(raw = fixture(), rail = "wise") {
  return {
    ...raw,
    responseObject: {
      ...raw.responseObject,
      platformQuotes: undefined,
      quotes: raw.responseObject.platformQuotes
        .filter((p) => p.platform === rail)
        .map((p) => p.bestQuote),
    },
  };
}
class RecordedReads implements PeerDiscoveryReads {
  response: unknown = fixture();
  quoteResponse: unknown = single();
  requests: unknown[] = [];
  async bestByPlatform(request: Parameters<PeerDiscoveryReads["bestByPlatform"]>[0]) {
    this.requests.push(request);
    return this.response;
  }
  async quote(request: Parameters<PeerDiscoveryReads["quote"]>[0]) {
    this.requests.push(request);
    return this.quoteResponse;
  }
}
const opts = (reads: PeerDiscoveryReads = new RecordedReads()) => ({ reads, now: () => now });
async function chosen(reads = new RecordedReads()) {
  const r = await fetchPeerCapabilities(intent(), opts(reads));
  return r.offers.find((o) => o.rail.id === "wise")!;
}
function makerEvidence() {
  return {
    observed_at: new Date(now).toISOString(),
    valid_until: new Date(now + 20_000).toISOString(),
    rail: "wise",
    currency: "USD",
    chain_id: "eip155:8453",
    asset_id: config.settlement.asset_id,
    decimals: 6,
    rate: { numerator: "101", denominator: "100" },
    bounds: { minimum: "1000000", maximum: "100000000" },
    fees: [{ code: "maker_fee", atomic: "1000" }],
    credential: "verified",
    wallet,
  };
}
describe("live Peer normalization", () => {
  it("uses recorded exact economics and singleton executable bounds", async () => {
    const r = await fetchPeerCapabilities(intent(), opts());
    expect(r.availability.state).toBe("available");
    expect(r.offers.length).toBeGreaterThan(0);
    for (const offer of r.offers.filter((o) => o.availability.state === "available")) {
      expect(parseRamp(offer).ok).toBe(true);
      expect(checkRampOffer(offer, intent(), config.settlement, now).ok).toBe(true);
      expect(offer.bounds.minimum.atomic).toBe("25000000");
      expect(offer.bounds.maximum.atomic).toBe("25000000");
    }
    expect(r.offers.find((o) => o.rail.id === "venmo")?.availability.state).toBe(
      "temporarily_unavailable",
    );
    expect(r.offers.find((o) => o.rail.id === "monzo")?.availability.state).toBe("not_supported");
    const q = normalizePeerQuotes(single(), intent(), config, now, "wise")[0];
    expect(q.pay.atomic).toBe("25996971");
    expect(q.receive.atomic).toBe("25000000");
    expect(q.fees.map((f) => f.money.atomic)).toEqual(["239777", "0"]);
  });
  it("caps a long provider expiry and preserves amounts beyond JS safe integers", () => {
    const r = single();
    r.responseObject.quoteExpiresAt = new Date(now + 3_600_000).toISOString();
    const q = r.responseObject.quotes[0]!;
    const amount = "9007199254740993";
    q.tokenAmount = amount;
    q.fiatAmount = "9999999999999999";
    q.signalIntentAmount = (BigInt(amount) + BigInt(q.zkp2pFeeAmount)).toString();
    const i = intent();
    i.exact.money.atomic = atomic(amount);
    const normalized = normalizePeerQuotes(r, i, config, now, "wise")[0];
    expect(normalized.receive.atomic).toBe(amount);
    expect(normalized.pay.atomic).toBe("9999999999999999");
    expect(normalized.offer.availability).toEqual({
      state: "available",
      valid_until: new Date(now + 30_000).toISOString(),
    });
    q.fiatAmount += "\n";
    expect(normalizePeerQuotes(r, i, config, now, "wise")).toEqual([]);
  });
  it("sends exact decimal fiat or atomic crypto to the selected SDK API", async () => {
    const reads = new RecordedReads();
    await fetchPeerCapabilities(intent(), opts(reads));
    expect(reads.requests[0]).toMatchObject({
      amount: "25000000",
      isExactFiat: false,
      mode: "eligible",
      quotePreference: "EXCLUSIVE_BUYER_TEE",
      escrowAddresses: [config.escrow],
    });
    const i = intent();
    i.exact = { side: "fiat", money: { asset: i.fiat, atomic: atomic("25996971") } };
    await fetchPeerCapabilities(i, opts(reads));
    expect(reads.requests[1]).toMatchObject({ amount: "25.996971", isExactFiat: true });
  });
  it.each([
    "expired",
    "missing_expiry",
    "wrong_token",
    "wrong_chain",
    "wrong_decimals",
    "wrong_currency",
    "wrong_orchestrator",
    "malformed",
    "empty",
    "duplicate",
  ])("fails closed for %s", async (kind) => {
    const reads = new RecordedReads(),
      r = fixture();
    if (kind === "expired") r.responseObject.quoteExpiresAt = new Date(now).toISOString();
    if (kind === "missing_expiry") r.responseObject.quoteExpiresAt = "";
    if (kind === "wrong_token") r.responseObject.token.token = wallet;
    if (kind === "wrong_chain") r.responseObject.token.chainId = 1;
    if (kind === "wrong_decimals") r.responseObject.token.decimals = 18;
    if (kind === "wrong_currency") r.responseObject.fiat.currencyCode = "EUR";
    if (kind === "wrong_orchestrator") r.responseObject.orchestratorAddress = wallet;
    if (kind === "empty") r.responseObject.platformQuotes = [];
    if (kind === "duplicate")
      r.responseObject.platformQuotes.push(
        r.responseObject.platformQuotes.find((p) => p.platform === "wise")!,
      );
    reads.response = kind === "malformed" ? { message: "must_never_escape" } : r;
    const result = await fetchPeerCapabilities(intent(), opts(reads));
    expect(result.offers).toEqual([]);
    expect(result.availability.state).toBe("availability_unknown");
  });
  it.each(["amount", "fee", "recipient", "rail", "numeric_money", "stake"])(
    "checks quote-level %s",
    (kind) => {
      const r = single();
      const q = r.responseObject.quotes[0]!;
      if (kind === "amount") q.tokenAmount = "25000001";
      if (kind === "fee") q.totalFeeAmount = "0";
      if (kind === "recipient") q.intent.toAddress = "0x0000000000000000000000000000000000000001";
      if (kind === "rail") q.intent.processorName = "venmo";
      if (kind === "numeric_money") (q as unknown as Record<string, unknown>).fiatAmount = 25.9;
      if (kind === "stake") q.disputeProtectionRequiresStake = true;
      const output = normalizePeerQuotes(r, intent(), config, now, "wise");
      expect(output.filter((v) => v.offer.availability.state === "available")).toEqual([]);
    },
  );
  it("does not derive user region eligibility from fiat country metadata", async () => {
    expect((await fetchPeerCapabilities({ ...intent(), region: "US" }, opts())).offers).toEqual([]);
  });
  it("rejects unsupported precision and route composition without network reads", async () => {
    const reads = new RecordedReads();
    expect(
      (
        await fetchPeerCapabilities(
          { ...intent(), fiat: { kind: "fiat", currency: "USD", decimals: 2 } },
          opts(reads),
        )
      ).offers,
    ).toEqual([]);
    expect(reads.requests).toEqual([]);
  });
  it("discards all unrecognized provider fields and maps errors to fixed codes", async () => {
    const reads = new RecordedReads();
    reads.response = { ...fixture(), message: "sensitive_payload", secret: "sensitive_payload" };
    expect(JSON.stringify(await fetchPeerCapabilities(intent(), opts(reads)))).not.toContain(
      "sensitive_payload",
    );
    reads.bestByPlatform = async () => {
      throw new Error("sensitive_payload");
    };
    expect(await fetchPeerCapabilities(intent(), opts(reads))).toEqual({
      offers: [],
      estimates: [],
      availability: { state: "temporarily_unavailable", reason_code: "capabilities_unavailable" },
      code: "capabilities_unavailable",
    });
  });
  it("bounds an unreachable read without real waiting", async () => {
    vi.useFakeTimers();
    try {
      const pending = boundedPeerRead(() => new Promise(() => {}));
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("mobile web gate", () => {
  it("returns a non-executable desktop/app requirement without requesting quotes", async () => {
    const reads = new RecordedReads();
    expect(
      await fetchPeerCapabilities(intent(), { ...opts(reads), mobileWeb: true }),
    ).toMatchObject({
      offers: [],
      availability: {
        state: "setup_required",
        requirement_codes: ["peer_desktop_extension_or_app"],
      },
    });
    expect(reads.requests).toEqual([]);
  });
  it("cannot be overridden by a host flag and invalidates an old desktop offer", async () => {
    const offer = await chosen();
    vi.stubGlobal("navigator", {
      userAgent: "iPhone Mobile",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    try {
      expect(
        (await fetchPeerCapabilities(intent(), { ...opts(), mobileWeb: false })).offers,
      ).toEqual([]);
      expect(await previewPeerOffer(offer, intent(), "op", opts())).toMatchObject({
        ok: false,
        code: "capability_unavailable",
      });
      expect(normalizePeerQuotes(fixture(), intent(), config, now)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("fresh preview", () => {
  it("revalidates via apiGetQuote and creates fresh opaque quote IDs", async () => {
    const reads = new RecordedReads(),
      offer = await chosen(reads);
    const a = await previewPeerOffer(offer, intent(), "operation", opts(reads));
    const b = await previewPeerOffer(offer, intent(), "operation", opts(reads));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.preview.quote_id).not.toBe(b.preview.quote_id);
      expect(a.preview.pay.atomic).toBe("25996971");
      expect(parseRamp(a.preview).ok).toBe(true);
    }
    expect(reads.requests[1]).toMatchObject({
      paymentPlatforms: ["wise"],
      quotesToReturn: 1,
      includeNearbyQuotes: false,
    });
  });
  it("returns a replacement, never accepts a changed revision", async () => {
    const reads = new RecordedReads(),
      offer = await chosen(reads);
    const raw = single();
    raw.responseObject.quotes[0]!.fiatAmount = "26000000";
    reads.quoteResponse = raw;
    const result = await previewPeerOffer(offer, intent(), "operation", opts(reads));
    expect(result).toMatchObject({
      ok: false,
      code: "quote_changed",
      replacement: { pay: { atomic: "26000000" } },
    });
  });
  it("rejects changed rail, amount, asset, recipient, region, expiry and availability", async () => {
    const offer = await chosen();
    for (const changed of [
      { ...offer, rail: { id: "venmo", label: "Venmo" } },
      { ...offer, capability_revision: "changed" },
    ])
      expect((await previewPeerOffer(changed, intent(), "op", opts())).ok).toBe(false);
    for (const i of [
      { ...intent(), recipient: "0x0000000000000000000000000000000000000001" },
      { ...intent(), region: "US" },
      {
        ...intent(),
        exact: {
          side: "crypto" as const,
          money: { asset: config.settlement, atomic: atomic("25000001") },
        },
      },
    ])
      expect((await previewPeerOffer(offer, i, "op", opts())).ok).toBe(false);
    expect(
      await previewPeerOffer(offer, intent(), "op", { ...opts(), now: () => now + 30_000 }),
    ).toMatchObject({ ok: false, code: "quote_expired" });
    const reads = new RecordedReads();
    reads.quoteResponse = single({
      ...fixture(),
      responseObject: { ...fixture().responseObject, platformQuotes: [] },
    });
    expect((await previewPeerOffer(offer, intent(), "op", opts(reads))).ok).toBe(false);
  });
});
describe("maker evidence gate", () => {
  it("never enables maker rails from buyer quotes or the SDK catalog", async () => {
    const r = await fetchPeerCapabilities(intent("offramp"), opts());
    expect(r.offers.length).toBeGreaterThan(0);
    expect(r.offers.every((o) => o.availability.state === "availability_unknown")).toBe(true);
    const reads = new RecordedReads();
    reads.response = {};
    expect((await fetchPeerCapabilities(intent("offramp"), opts(reads))).offers).toEqual([]);
  });
  it("requires fresh net rate, live bounds and bound seller verification", async () => {
    const reads = new RecordedReads();
    const e = makerEvidence();
    const live = {
      ...reads,
      bestByPlatform: reads.bestByPlatform.bind(reads),
      quote: reads.quote.bind(reads),
      makerEvidence: async () => e,
    };
    const r = await fetchPeerCapabilities(intent("offramp"), { ...opts(live), user: wallet });
    expect(
      r.offers.filter((o) => o.availability.state === "available").map((o) => o.rail.id),
    ).toEqual(["wise"]);
    const p = await previewPeerOffer(
      r.offers.find((o) => o.rail.id === "wise"),
      intent("offramp"),
      "maker_op",
      { ...opts(live), user: wallet },
    );
    expect(p).toMatchObject({
      ok: true,
      estimate: true,
      preview: {
        pay: { atomic: "25000000" },
        receive: { atomic: "25250000" },
        fees: [{ code: "maker_fee", money: { atomic: "1000" } }],
      },
    });
  });
  it.each([
    "missing",
    "unknown",
    "stale",
    "future",
    "bounds",
    "rate",
    "wallet",
    "region",
    "absent",
  ])("fails closed for maker %s", async (kind) => {
    const base = new RecordedReads();
    const e = makerEvidence();
    if (kind === "missing" || kind === "unknown") e.credential = kind;
    if (kind === "stale") e.observed_at = new Date(now - 30_000).toISOString();
    if (kind === "future") e.observed_at = new Date(now + 1).toISOString();
    if (kind === "bounds") e.bounds.maximum = "20000000";
    if (kind === "rate") e.rate.denominator = "0";
    if (kind === "wallet") e.wallet = "0x0000000000000000000000000000000000000001";
    const evidence = kind === "region" ? { ...e, region: "US" } : kind === "absent" ? {} : e;
    const reads = {
      bestByPlatform: base.bestByPlatform.bind(base),
      quote: base.quote.bind(base),
      makerEvidence: async () => evidence,
    };
    const r = await fetchPeerCapabilities(intent("offramp"), { ...opts(reads), user: wallet });
    expect(r.offers.every((o) => o.availability.state !== "available")).toBe(true);
    if (kind === "missing")
      expect(r.offers.find((o) => o.rail.id === "wise")?.availability).toEqual({
        state: "setup_required",
        requirement_codes: ["maker_seller_credential"],
      });
  });
});

describe("cancellable discovery and safe estimates", () => {
  it("rejects pre-aborted reads and previews without forwarding the reason", async () => {
    const controller = new AbortController();
    controller.abort("private cancellation detail");
    const reads = new RecordedReads();
    const options = { ...opts(reads), signal: controller.signal };
    await expect(fetchPeerCapabilities(intent(), options)).rejects.toMatchObject({
      name: "AbortError",
      message: "peer_read_aborted",
    });
    await expect(
      previewPeerOffer(await chosen(), intent(), "operation", options),
    ).rejects.toMatchObject({ name: "AbortError", message: "peer_read_aborted" });
    expect(reads.requests).toEqual([]);
  });
  it("cancels an in-flight read even when a custom port ignores its signal", async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    let started!: () => void;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    let networkSignal: AbortSignal | undefined;
    const pending = fetchPeerCapabilities(intent(), {
      ...opts(),
      signal: controller.signal,
      reads: {
        bestByPlatform: (_request, signal) => {
          networkSignal = signal;
          started();
          return new Promise((done) => {
            resolve = done;
          });
        },
        quote: async () => single(),
      },
    });
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "peer_read_aborted",
    });
    expect(networkSignal?.aborted).toBe(true);
    resolve(fixture());
  });
  it("passes cancellation through to the real fetch adapter", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    let networkSignal: AbortSignal | null | undefined;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      networkSignal = init?.signal;
      expect(JSON.parse(init!.body as string).exactTokenAmount).toBe("25000000");
      started();
      return new Promise(() => {});
    });
    try {
      const pending = fetchPeerCapabilities(intent(), {
        now: () => now,
        signal: controller.signal,
      });
      await ready;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(networkSignal?.aborted).toBe(true);
    } finally {
      fetcher.mockRestore();
    }
  });
  it("exposes only fresh allowlisted economics linked to each available offer", async () => {
    const result = await fetchPeerCapabilities(intent(), opts());
    expect(result.estimates.length).toBeGreaterThan(0);
    for (const estimate of result.estimates) {
      const offer = result.offers.find((offer) => offer.offer_id === estimate.offerId)!;
      expect(offer.availability.state).toBe("available");
      expect(estimate.observedAt).toBe(offer.observed_at);
      expect(Date.parse(estimate.validUntil)).toBeGreaterThan(now);
      expect(estimate.receive.atomic).toBe("25000000");
      expect(Object.keys(estimate).sort()).toEqual([
        "fees",
        "observedAt",
        "offerId",
        "pay",
        "receive",
        "validUntil",
      ]);
      expect(estimate.pay.atomic).toMatch(/^(0|[1-9][0-9]*)$/);
      for (const fee of estimate.fees) expect(fee.money.atomic).toMatch(/^(0|[1-9][0-9]*)$/);
    }
    const unknown = await fetchPeerCapabilities(intent("offramp"), opts());
    expect(unknown.estimates).toEqual([]);
    const stale = await fetchPeerCapabilities(intent(), { ...opts(), now: () => now + 100_000 });
    expect(stale.estimates).toEqual([]);
  });
});

it("keeps identical live revisions stable across observation clocks", async () => {
  const reads = new RecordedReads();
  const response = fixture();
  response.responseObject.quoteExpiresAt = new Date(now + 3_600_000).toISOString();
  reads.response = response;
  const first = await fetchPeerCapabilities(intent(), opts(reads));
  const later = await fetchPeerCapabilities(intent(), { ...opts(reads), now: () => now + 1_000 });
  expect(later.offers.map((o) => o.capability_revision)).toEqual(
    first.offers.map((o) => o.capability_revision),
  );
  expect(later.estimates[0].validUntil).not.toBe(first.estimates[0].validUntil);
  for (const field of ["fiatAmount", "conversionRate", "signalIntentAmount"] as const) {
    const changed = structuredClone(response);
    const row = changed.responseObject.platformQuotes.find((p) => p.platform === "wise")!;
    row.bestQuote![field] = (BigInt(row.bestQuote![field]) + 1n).toString();
    reads.response = changed;
    const result = await fetchPeerCapabilities(intent(), opts(reads));
    expect(result.offers.find((o) => o.rail.id === "wise")!.capability_revision).not.toBe(
      first.offers.find((o) => o.rail.id === "wise")!.capability_revision,
    );
  }
  reads.response = structuredClone(response);
  (reads.response as typeof response).responseObject.quoteExpiresAt = new Date(
    now + 3_600_001,
  ).toISOString();
  expect(
    (await fetchPeerCapabilities(intent(), opts(reads))).offers[0].capability_revision,
  ).not.toBe(first.offers[0].capability_revision);
});

it("uses cancellable V3 wire requests for discovery and selected-rail preview", async () => {
  const calls: { url: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init!.body as string), signal: init?.signal });
    return new Response(JSON.stringify(calls.length === 1 ? fixture() : single()), { status: 200 });
  });
  try {
    const result = await fetchPeerCapabilities(intent(), { now: () => now });
    const wise = result.offers.find((offer) => offer.rail.id === "wise")!;
    expect((await previewPeerOffer(wise, intent(), "operation", { now: () => now })).ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.zkp2p.xyz/v3/quote/best-by-platform-exact-token",
      "https://api.zkp2p.xyz/v3/quote/exact-token?quotesToReturn=1",
    ]);
    for (const call of calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.body.exactTokenAmount).toBe("25000000");
      expect(call.body).not.toHaveProperty("amount");
      expect(call.body).not.toHaveProperty("isExactFiat");
      expect(call.body).not.toHaveProperty("quotesToReturn");
    }
    expect(calls[1].body.paymentPlatforms).toEqual(["wise"]);
  } finally {
    fetcher.mockRestore();
  }
});
