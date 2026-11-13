/**
 * useCapabilities Hook
 *
 * Fetches the solver capability matrix from the worker API
 * (`GET /api/capabilities`, a proxy of Riddler's `/xochi/capabilities`),
 * parses it once with `@xochi/signer`'s `parseCapabilities`, and exposes that
 * model plus the token lists the trade UI reads (see `lib/capabilities`).
 *
 * Degrade policy: a `stale` envelope (Riddler unreachable, the worker's last
 * live matrix) is the solver's matrix and is served as such, though not as
 * live. A `fallback` envelope carries no solver data -- notably no
 * `stealth_chains` -- so it is an error here: react-query keeps the matrix it
 * already holds instead of replacing it, which is what stops a capabilities
 * blip from dropping Base stealth. With nothing held (loading, or every read
 * failed) the hook serves `FALLBACK_CAPABILITIES`, which reproduces the legacy
 * hardcoded lists -- a solver outage looks like the pre-capabilities UI, never
 * a dead selector -- and leaves the stealth chains unknown. `source` and
 * `isLive` tell the caller which world it is in, and `isLoading` / `isError`
 * tell it WHY it is on the fallback: the fallback carries no conversion pairs,
 * so a caller must not read its absences as the solver's verdict while the
 * real list is still on its way or failed to load. `retry` re-fetches on
 * demand, since the scheduled refetch is 5 minutes out.
 *
 * The same response carries Xochi's server-owned trust launch flags
 * (`features`, xochi#656 / xochi#669). They fail closed: every flag is off
 * while loading, on any error, and when the envelope omits them.
 */

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  attestationSignerConsistency,
  depositAttestationVersionSkew,
  parseCapabilities,
  DEPOSIT_ATTESTATION_VERSION,
  type SolverCapabilities,
} from "@xochi/signer";
import { API_URL, DEPOSIT_ATTESTATION_PIN } from "../config.js";
import { capabilityVmType, destinationTokenSymbols, originTokenSymbols } from "@xochi/client";
import { FALLBACK_CAPABILITIES } from "../lib/capabilities.js";
import { parseTrustFeatures, TRUST_FEATURES_OFF, type TrustFeatureFlags } from "@xochi/client";
import type { CapabilityState } from "@xochi/client";

interface CapabilitiesResponse {
  source: "live" | "stale" | "fallback";
  capabilities: unknown;
  features?: unknown;
}

/**
 * Where the matrix the hook serves came from. `live`: the solver now. `stale`:
 * the worker's last live copy while Riddler is unreachable. `fallback`: no
 * solver matrix on hand, so the stealth chains are unknown.
 */
export type CapabilitiesSource = CapabilitiesResponse["source"];

/**
 * The worker answered, but with its static fallback rather than a solver
 * matrix. Thrown so react-query keeps any matrix it holds; it carries the
 * envelope's trust flags, which are Xochi's own and do not depend on Riddler.
 */
class FallbackServedError extends Error {
  constructor(readonly features: TrustFeatureFlags) {
    super("capabilities unavailable: the worker served its static fallback");
  }
}

/**
 * The served matrix, or null when the trade UI could not render it and should
 * degrade to `FALLBACK_CAPABILITIES`. The signer parses any object, reading a
 * body that says nothing as an empty matrix; a matrix with no token list, or no
 * chain in a VM this widget can trade from, would leave every selector dead.
 * Canton (`cvm`) does not count: it is a destination only.
 */
export function parseWidgetCapabilities(raw: unknown): SolverCapabilities | null {
  const caps = parseCapabilities(raw);
  if (caps === null || !Array.isArray(caps.raw.tokens)) return null;
  return caps.chains.some((chain) => {
    const vm = capabilityVmType(caps, chain.chainId);
    return vm !== null && vm !== "cvm";
  })
    ? caps
    : null;
}

async function fetchCapabilities(): Promise<{
  caps: SolverCapabilities;
  source: "live" | "stale";
  features: TrustFeatureFlags;
}> {
  const res = await fetch(`${API_URL}/api/capabilities`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: CapabilitiesResponse = await res.json();
  if (body.source !== "live" && body.source !== "stale") {
    throw new FallbackServedError(parseTrustFeatures(body.features));
  }
  const parsed = parseWidgetCapabilities(body.capabilities);
  if (parsed === null) throw new Error("unparseable capabilities payload");

  // Defense-in-depth: the build-time pin is authoritative and fail-closed, but a
  // live solver advertising a different deposit-attestation signer would make
  // every deposit route silently unavailable. Warn so it is diagnosable. Only
  // meaningful against a live matrix: a stale one was checked when it was live.
  if (body.source === "live") {
    // Version first, and reported on its own. These two produce the SAME
    // user-visible failure downstream ("signer is not the pinned solver"), and
    // collapsing them is what sent people looking at solver health for a client
    // version problem (#412). A skew explains a signer mismatch, so when both
    // fire the version line is the one to act on.
    const skew = depositAttestationVersionSkew(parsed, DEPOSIT_ATTESTATION_VERSION);
    if (skew) {
      console.warn("[capabilities] deposit-attestation version skew:", skew);
    }

    const check = attestationSignerConsistency(
      DEPOSIT_ATTESTATION_PIN.signer,
      parsed.depositAttestationSigner,
    );
    if (!check.ok) {
      console.warn(
        "[capabilities] deposit-attestation signer mismatch (build-time pin stays authoritative):",
        check.reason,
      );
    }
  }

  return {
    caps: parsed,
    source: body.source,
    features: parseTrustFeatures(body.features),
  };
}

export interface UseCapabilitiesReturn {
  /** Parsed capability matrix (fallback while loading / on error). */
  capabilities: SolverCapabilities;
  /** Token symbols the solver can pull on the origin leg. */
  originTokens: readonly string[];
  /** Token symbols the solver can deliver on the destination leg. */
  destinationTokens: readonly string[];
  /** True when the data came from the live solver, false on stale or fallback. */
  isLive: boolean;
  /**
   * `live` or `stale`: a solver matrix is held, so its stealth chains are the
   * solver's. `fallback`: none is (loading, or every read failed), so
   * `capabilities` is the static fallback and the stealth chains are unknown.
   */
  source: CapabilitiesSource;
  /** Whether the current snapshot is live, stale, fallback metadata, or a failed read. */
  state: CapabilityState;
  /** The first fetch (including react-query's retries) is still in flight. */
  isLoading: boolean;
  /**
   * The latest fetch failed, or answered with the worker's fallback. Any data
   * held is from an earlier success, so this alone does not mean the fallback
   * is served; `source` says that.
   */
  isError: boolean;
  /** A fetch is in flight right now: the first load, a retry or a refetch. */
  isFetching: boolean;
  /** Fetch the matrix again now, rather than on the 5-minute schedule. */
  retry: () => void;
  /** Server-owned trust launch flags; all off until the server says otherwise. */
  features: TrustFeatureFlags;
}

export function useCapabilities(): UseCapabilitiesReturn {
  const { data, error, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["capabilities"],
    queryFn: fetchCapabilities,
    staleTime: 300_000,
    refetchInterval: 300_000,
    // The worker edge-caches its fallback for 60s, so retrying one within
    // seconds only reads the same answer back.
    retry: (failures, err) => !(err instanceof FallbackServedError) && failures < 2,
  });

  const capabilities = data?.caps ?? FALLBACK_CAPABILITIES;
  const source: CapabilitiesSource = data?.source ?? "fallback";
  const isLive = source === "live";
  const state: CapabilityState = data
    ? data.source === "stale" || isError
      ? "stale"
      : "live"
    : isError && !(error instanceof FallbackServedError)
      ? "failed"
      : "fallback";
  // Fail closed on a failed refetch too: react-query keeps the last good `data`
  // beside `isError`, and a flag the server may have since withdrawn must not
  // stay on just because the latest read could not reach it. A fallback
  // envelope is a read that did reach the server, so its flags stand.
  const features = isError
    ? error instanceof FallbackServedError
      ? error.features
      : TRUST_FEATURES_OFF
    : (data?.features ?? TRUST_FEATURES_OFF);
  // The outcome lands in the query state (isError / data), which is what every
  // caller renders from, so the promise carries nothing left to handle.
  const retry = useCallback((): void => {
    void refetch();
  }, [refetch]);

  // Memoize the derived arrays. `capabilities` is a stable reference across renders
  // (react-query returns the same object until it refetches; the fallback is a
  // module constant), so keying on it yields stable `originTokens` /
  // `destinationTokens` etc. Without this every render produced fresh arrays, so
  // any effect/memo depending on them re-ran on every render. Kept apart from the
  // fetch state below, which flips on every scheduled refetch and must not
  // re-derive the lists when the matrix itself did not change.
  const lists = useMemo(
    () => ({
      capabilities,
      originTokens: originTokenSymbols(capabilities),
      destinationTokens: destinationTokenSymbols(capabilities),
    }),
    [capabilities],
  );

  return useMemo(
    () => ({ ...lists, isLive, source, state, isLoading, isError, isFetching, retry, features }),
    [lists, isLive, source, state, isLoading, isError, isFetching, retry, features],
  );
}
