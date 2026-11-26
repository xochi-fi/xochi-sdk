import { checkRampOffer, parseRamp, type RampErrorCode, type RampPreview } from "@xochi/client";
import { digest, PEER_FRESHNESS_MS } from "./normalization.js";
import { checkPeerAbort, PeerReadAborted, peerConfiguration, readPeerQuotes } from "./discovery.js";
import type { PeerDiscoveryOptions } from "./types.js";
export type PeerPreviewResult =
  | { ok: true; preview: RampPreview; estimate: boolean }
  | { ok: false; code: RampErrorCode; replacement?: RampPreview; estimate?: boolean };
/** Always re-read. A replacement quote must be reviewed before it is accepted. */
export async function previewPeerOffer(
  offer: unknown,
  intent: unknown,
  operationId: string,
  options: PeerDiscoveryOptions = {},
): Promise<PeerPreviewResult> {
  try {
    checkPeerAbort(options.signal);
    const now = (options.now ?? Date.now)(),
      config = peerConfiguration(options);
    const check = checkRampOffer(offer, intent, config.settlement, now);
    if (!check.ok) return check;
    if (Date.parse(check.offer.observed_at) < now - PEER_FRESHNESS_MS)
      return { ok: false, code: "quote_expired" };
    // The public offer ID binds the complete request, including region, recipient and rail.
    if (check.offer.offer_id !== digest([check.intent, check.offer.rail.id]))
      return { ok: false, code: "quote_changed" };
    const fresh = await readPeerQuotes(check.intent, options, check.offer.rail.id);
    const assessedAt = (options.now ?? Date.now)();
    const original = checkRampOffer(check.offer, check.intent, config.settlement, assessedAt);
    if (!original.ok) return original;
    const quote = fresh.quotes.find((q) => q.offer.rail.id === check.offer.rail.id);
    if (!quote || !checkRampOffer(quote.offer, check.intent, config.settlement, assessedAt).ok)
      return { ok: false, code: fresh.result.code ?? "capability_unavailable" };
    const availability = quote.offer.availability;
    if (availability.state !== "available") return { ok: false, code: "capability_unavailable" };
    const preview: RampPreview = {
      contract_version: "ramp/1",
      kind: "preview",
      operation_id: operationId,
      quote_id: crypto.randomUUID(),
      offer_id: quote.offer.offer_id,
      capability_revision: quote.offer.capability_revision,
      request_digest: digest(check.intent),
      pay: quote.pay,
      receive: quote.receive,
      fees: quote.fees,
      expires_at: availability.valid_until,
      leg_order: ["peer"],
      disclosures: quote.offer.disclosures,
    };
    if (!parseRamp(preview).ok) return { ok: false, code: "invalid_request" };
    if (check.offer.capability_revision !== quote.offer.capability_revision)
      return {
        ok: false,
        code: "quote_changed",
        replacement: preview,
        estimate: check.intent.direction === "offramp",
      };
    return { ok: true, preview, estimate: check.intent.direction === "offramp" };
  } catch (error) {
    checkPeerAbort(options.signal);
    if (error instanceof PeerReadAborted) throw error;
    return { ok: false, code: "capability_unavailable" };
  }
}
