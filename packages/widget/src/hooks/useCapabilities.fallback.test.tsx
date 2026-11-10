// @vitest-environment jsdom

/**
 * A `fallback` envelope carries no solver data, notably no `stealth_chains`.
 * Letting it replace a matrix the hook already holds is what turned a worker
 * capabilities timeout into "L1 only" and dropped Base stealth (xochi#722). A
 * `stale` envelope is the worker's last live matrix and is the solver's answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCapabilities } from "./useCapabilities.js";
import { FALLBACK_CAPABILITIES } from "../lib/capabilities.js";
import { SIMPLE_ACCOUNT_FACTORY, stealthDestinationChains } from "@xochi/client";

const BASE = 8453;

const MATRIX = {
  cross_chain_only: true,
  chains: [
    {
      chain_id: BASE,
      chain_name: "Base",
      vm_type: "evm",
      stealth_factory_address: SIMPLE_ACCOUNT_FACTORY,
    },
    {
      chain_id: 1,
      chain_name: "Ethereum",
      vm_type: "evm",
      stealth_factory_address: SIMPLE_ACCOUNT_FACTORY,
    },
  ],
  tokens: [{ symbol: "USDC", roles: ["origin", "destination"] }],
  conversion_pairs: [],
  stealth_chains: [BASE, 1],
};

/** The worker's static fallback: no solver matrix, so no `stealth_chains`. */
const FALLBACK_WIRE = { ...MATRIX, stealth_chains: undefined };

let serve: () => Promise<Response>;

const envelope =
  (source: "live" | "stale" | "fallback", capabilities: unknown): (() => Promise<Response>) =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify({ source, capabilities }), {
        headers: { "content-type": "application/json" },
      }),
    );

function render() {
  // The hook sets its own retry policy; zero delay keeps a failing read fast.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/capabilities")) {
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }
    return serve();
  });
  return renderHook(() => useCapabilities(), { wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useCapabilities: a fallback envelope never replaces solver data", () => {
  it("keeps the live stealth chains when a refetch answers fallback", async () => {
    // The live read's attestation checks warn on this signer-less matrix.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve = envelope("live", MATRIX);
    const { result } = render();
    await waitFor(() => expect(result.current.source).toBe("live"));
    expect(stealthDestinationChains(result.current.capabilities)).toEqual([BASE, 1]);

    serve = envelope("fallback", FALLBACK_WIRE);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.source).toBe("live");
    expect(result.current.capabilities.stealthChains).toEqual([BASE, 1]);
    expect(stealthDestinationChains(result.current.capabilities)).toEqual([BASE, 1]);
  });

  it("serves a stale envelope as the solver's matrix, Base stealth intact", async () => {
    serve = envelope("stale", MATRIX);
    const { result } = render();
    await waitFor(() => expect(result.current.source).toBe("stale"));
    expect(result.current.isLive).toBe(false);
    expect(stealthDestinationChains(result.current.capabilities)).toEqual([BASE, 1]);
  });

  it("with nothing held, a fallback leaves the static matrix and no stealth chain", async () => {
    serve = envelope("fallback", FALLBACK_WIRE);
    const { result } = render();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.source).toBe("fallback");
    expect(result.current.capabilities).toBe(FALLBACK_CAPABILITIES);
    expect(stealthDestinationChains(result.current.capabilities)).toEqual([]);
  });
});
