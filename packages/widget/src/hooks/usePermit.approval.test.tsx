/// <reference lib="esnext.promise" />
// @vitest-environment jsdom

/**
 * usePermit approves only the canonical Permit2 contract (SPEC §2.3), and its
 * approval state and `ensureApproval` come from ONE allowance read.
 *
 * A served pull whose domain names any other contract must be refused, never
 * approved, even though @xochi/client already refuses such a quote at ingest.
 * The payment copy says "no gas needed" only
 * when `approval` is `covered`, and `ensureApproval` sends the gasful
 * `approve(Permit2)` only when a refetch of that same read is short. These run
 * the hook against a one-wallet Base whose allowance moves when an approve is
 * sent, so the copy is seen flipping from the chain, not from a flag.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { WagmiProvider, createConfig, type Config } from "wagmi";
import { base, mainnet } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import { connect, disconnect } from "@wagmi/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { custom, decodeFunctionData, erc20Abi, maxUint256, numberToHex, toHex } from "viem";
import { PERMIT2_ADDRESS } from "@xochi/signer";
import { usePermit, type UsePermitReturn, type UsePermitParams } from "./usePermit.js";
import type { Eip712TypedData } from "../types/intent.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
/** WETH on Base: no ERC-3009, so the pull is Permit2 either way. */
const TOKEN = "0x4200000000000000000000000000000000000006";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const AMOUNT = 1_000_000_000_000_000_000n;
const TX_HASH = `0x${"ab".repeat(32)}` as const;
const FOREIGN = `0x${"66".repeat(20)}`;
/** Where the mock connector forwards the wallet's own requests (the approve). */
const RPC = "http://permit-chain.invalid/rpc";

const permit2Pull = (domain: Eip712TypedData["domain"], token = TOKEN): Eip712TypedData => ({
  domain,
  types: { PermitWitnessTransferFrom: [{ name: "spender", type: "address" }] },
  primaryType: "PermitWitnessTransferFrom",
  message: { permitted: { token, amount: AMOUNT.toString() } },
});

const VERSIONED = permit2Pull({
  name: "Permit2",
  version: "1",
  chainId: base.id,
  verifyingContract: PERMIT2_ADDRESS,
});

const permitParams = (overrides: Partial<UsePermitParams> = {}): UsePermitParams => ({
  token: TOKEN,
  chainId: base.id,
  pullAuthorization: VERSIONED,
  amount: AMOUNT.toString(),
  approvalContext: "quote-1",
  ...overrides,
});

/** The `data` of the one call object in an `eth_call` / `eth_sendTransaction`. */
const callData = (params: unknown): `0x${string}` => {
  const tx: unknown = Array.isArray(params) ? params[0] : undefined;
  if (tx && typeof tx === "object" && "data" in tx && typeof tx.data === "string") {
    return tx.data as `0x${string}`;
  }
  throw new Error("permit chain: call without data");
};

/**
 * A Base with one wallet and one token. `allowance` is what the token reports
 * for (wallet, spender); an `approve` moves it, unless the chain is set to
 * revert approvals, in which case the receipt says so and nothing moves.
 * Records the spender of every `allowance` read and every `approve` sent.
 */
function permitChain(
  initial: bigint,
  { reverts = false, zeroFirst = false, chainId = base.id as number, token = TOKEN } = {},
) {
  const state = {
    allowance: initial,
    reportedAllowance: null as bigint | null,
    reads: [] as string[],
    approvals: [] as Array<{ spender: string; value: bigint }>,
    readGate: null as Promise<void> | null,
    receiptGate: null as Promise<void> | null,
  };
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case "eth_chainId":
        return numberToHex(chainId);
      case "eth_accounts":
      case "eth_requestAccounts":
        return [WALLET];
      case "eth_getCode":
        return "0x";
      case "eth_blockNumber":
        return "0x2";
      case "eth_call": {
        const call = decodeFunctionData({ abi: erc20Abi, data: callData(params) });
        if (call.functionName !== "allowance")
          throw new Error(`permit chain: ${call.functionName}`);
        state.reads.push(call.args[1]);
        if (state.readGate) await state.readGate;
        return toHex(state.reportedAllowance ?? state.allowance, { size: 32 });
      }
      case "eth_sendTransaction": {
        const call = decodeFunctionData({ abi: erc20Abi, data: callData(params) });
        if (call.functionName !== "approve") throw new Error(`permit chain: ${call.functionName}`);
        const [spender, value] = call.args;
        state.approvals.push({ spender, value });
        if (zeroFirst && state.allowance > 0n && value > 0n) {
          throw new Error("zero-first token: reset the non-zero allowance before approving");
        }
        if (!reverts) state.allowance = value;
        return toHex(BigInt(state.approvals.length), { size: 32 });
      }
      case "eth_getTransactionReceipt": {
        if (state.receiptGate) await state.receiptGate;
        return {
          blockHash: `0x${"cd".repeat(32)}`,
          blockNumber: "0x2",
          contractAddress: null,
          cumulativeGasUsed: "0xb5d4",
          effectiveGasPrice: "0x1",
          from: WALLET,
          gasUsed: "0xb5d4",
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: reverts ? "0x0" : "0x1",
          to: token,
          transactionHash: Array.isArray(params) ? params[0] : TX_HASH,
          transactionIndex: "0x0",
          type: "0x2",
        };
      }
      default:
        throw new Error(`permit chain: no RPC for ${method}`);
    }
  };
  // The mock connector sends the wallet's own requests to the chain's RPC URL
  // over `fetch`, past the config's transports; answer them from the same chain.
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const rpc = body && typeof body === "object" ? body : {};
    const method = "method" in rpc && typeof rpc.method === "string" ? rpc.method : "";
    const id = "id" in rpc ? rpc.id : 0;
    const payload = await request({ method, params: "params" in rpc ? rpc.params : undefined })
      .then((result) => ({ jsonrpc: "2.0", id, result }))
      .catch((err: Error) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: err.message },
      }));
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
  });
  const config: Config = createConfig({
    chains: [
      { ...base, rpcUrls: { default: { http: [RPC] } } },
      { ...mainnet, rpcUrls: { default: { http: [RPC] } } },
    ],
    connectors: [mock({ accounts: [WALLET], features: { reconnect: true } })],
    storage: null,
    transports: { [base.id]: custom({ request }), [mainnet.id]: custom({ request }) },
    batch: { multicall: false },
  });
  return { state, config };
}

async function renderPermit(
  config: Config,
  params: UsePermitParams = permitParams(),
  reactStrictMode = false,
) {
  await connect(config, { connector: config.connectors[0], chainId: params.chainId });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  return renderHook((params: UsePermitParams) => usePermit(params), {
    wrapper,
    initialProps: params,
    reactStrictMode,
  });
}

async function approve(result: { current: UsePermitReturn }) {
  let approved: boolean | undefined;
  await act(async () => {
    approved = await result.current.ensureApproval(AMOUNT);
  });
  return approved;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePermit approves only the canonical Permit2", () => {
  it("approves the canonical Permit2 for a served domain with no version", async () => {
    // Permit2's EIP-712 domain has no `version` (spec 0.11.0, client 0.1.6).
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(
      config,
      permitParams({
        pullAuthorization: permit2Pull({
          name: "Permit2",
          chainId: base.id,
          verifyingContract: PERMIT2_ADDRESS,
        }),
      }),
    );
    await waitFor(() => expect(result.current.approval).toBe("required"));

    expect(await approve(result)).toBe(true);
    expect(new Set(state.reads)).toEqual(new Set([PERMIT2_ADDRESS]));
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
  });

  it("refuses a served domain that names another contract, sending nothing", async () => {
    const errors = vi.spyOn(console, "error");
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(
      config,
      permitParams({
        pullAuthorization: permit2Pull({
          name: "Permit2",
          chainId: base.id,
          verifyingContract: FOREIGN,
        }),
      }),
    );

    expect(await approve(result)).toBe(false);
    expect(state.reads).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(result.current.approval).toBe("unknown");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("[usePermit] Refusing to approve"));
  });
});

describe("usePermit approval state", () => {
  it("flips to covered from the chain once the approval mines", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    await waitFor(() => expect(result.current.approval).toBe("required"));

    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
    await waitFor(() => expect(result.current.approval).toBe("covered"));
  });

  it("sends nothing when the allowance the copy shows already covers the amount", async () => {
    const { state, config } = permitChain(AMOUNT);
    const { result } = await renderPermit(config);
    await waitFor(() => expect(result.current.approval).toBe("covered"));

    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([]);
  });

  it("aborts on a reverted approval and keeps saying gas is needed", async () => {
    const errors = vi.spyOn(console, "error");
    const { state, config } = permitChain(0n, { reverts: true });
    const { result } = await renderPermit(config);
    await waitFor(() => expect(result.current.approval).toBe("required"));

    expect(await approve(result)).toBe(false);
    expect(state.approvals).toHaveLength(1);
    expect(result.current.approval).toBe("required");
    expect(errors).toHaveBeenCalledWith("[usePermit] Permit2 approval failed:", expect.any(Error));
  });
});

describe("Permit2 exact-by-default policy", () => {
  it("sends the machine's raw integer, not the rounded display or quoted amount", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    const machineAmount = AMOUNT + 123n;
    await act(async () => {
      expect(await result.current.ensureApproval(machineAmount)).toBe(true);
    });
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: machineAmount }]);
  });

  it("sends maxUint256 only after opt-in, then consumes that consent", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    expect(result.current.unlimitedApproval).toBe(false);
    act(() => result.current.setUnlimitedApproval(true));
    expect(result.current.unlimitedApproval).toBe(true);
    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: maxUint256 }]);
    expect(result.current.unlimitedApproval).toBe(false);
    // A later swap has spent the allowance. The same mounted hook must not
    // reuse a previous ceremony's choice.
    state.allowance = 0n;
    expect(await approve(result)).toBe(true);
    expect(state.approvals[1]).toEqual({ spender: PERMIT2_ADDRESS, value: AMOUNT });
  });

  it("does not extend consent to a different machine amount", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    act(() => result.current.setUnlimitedApproval(true));
    const machineAmount = AMOUNT + 1n;
    await act(async () => {
      expect(await result.current.ensureApproval(machineAmount)).toBe(true);
    });
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: machineAmount }]);
  });

  it.each([
    ["amount", { amount: (AMOUNT + 1n).toString() }],
    ["token", { token: FOREIGN }],
    ["chain", { chainId: mainnet.id }],
    ["quote", { approvalContext: "quote-2" }],
    ["disabled origin", { enabled: false }],
  ] satisfies Array<[string, Partial<UsePermitParams>]>)(
    "clears consent on %s changes, including when returning to the old context",
    async (_name, changed) => {
      const { state, config } = permitChain(0n);
      const { result, rerender } = await renderPermit(config);
      act(() => result.current.setUnlimitedApproval(true));
      rerender(permitParams(changed));
      expect(result.current.unlimitedApproval).toBe(false);
      rerender(permitParams());
      expect(result.current.unlimitedApproval).toBe(false);
      expect(await approve(result)).toBe(true);
      expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
    },
  );

  it("clears consent when the owner disconnects and reconnects", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    act(() => result.current.setUnlimitedApproval(true));
    await act(async () => {
      await disconnect(config);
    });
    expect(result.current.unlimitedApproval).toBe(false);
    await act(async () => {
      await connect(config, { connector: config.connectors[0], chainId: base.id });
    });
    expect(result.current.unlimitedApproval).toBe(false);
    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
  });

  it("clears consent on reset", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    act(() => result.current.setUnlimitedApproval(true));
    act(() => result.current.reset());
    expect(result.current.unlimitedApproval).toBe(false);
    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
  });

  it("does not reuse consent after a reverted approval", async () => {
    const { state, config } = permitChain(0n, { reverts: true });
    const { result } = await renderPermit(config);
    act(() => result.current.setUnlimitedApproval(true));
    expect(await approve(result)).toBe(false);
    expect(result.current.unlimitedApproval).toBe(false);
    expect(await approve(result)).toBe(false);
    expect(state.approvals).toEqual([
      { spender: PERMIT2_ADDRESS, value: maxUint256 },
      { spender: PERMIT2_ADDRESS, value: AMOUNT },
    ]);
  });

  it.each([AMOUNT, maxUint256])(
    "leaves sufficient existing allowance %s unchanged, even with opt-in",
    async (allowance) => {
      const { state, config } = permitChain(allowance);
      const { result } = await renderPermit(config);
      await waitFor(() => expect(result.current.approval).toBe("covered"));
      expect(await approve(result)).toBe(true);
      act(() => result.current.setUnlimitedApproval(true));
      expect(await approve(result)).toBe(true);
      expect(state.allowance).toBe(allowance);
      expect(state.approvals).toEqual([]);
      expect(result.current.unlimitedApproval).toBe(false);
    },
  );

  it("isolates consent between mounted hook instances", async () => {
    const first = permitChain(0n);
    const { result: firstResult, unmount } = await renderPermit(first.config);
    act(() => firstResult.current.setUnlimitedApproval(true));
    unmount();
    const second = permitChain(0n);
    const { result } = await renderPermit(second.config);
    expect(result.current.unlimitedApproval).toBe(false);
    expect(await approve(result)).toBe(true);
    expect(second.state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
  });

  it("does not send an approval after reset while an allowance read was pending", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config);
    await waitFor(() => expect(result.current.approval).toBe("required"));
    const { promise, resolve: releaseRead } = Promise.withResolvers<void>();
    state.readGate = promise;
    act(() => result.current.setUnlimitedApproval(true));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ensureApproval(AMOUNT);
    });
    act(() => result.current.reset());
    let approved: boolean | undefined;
    await act(async () => {
      releaseRead();
      approved = await pending;
    });
    expect(approved).toBe(false);
    expect(state.approvals).toEqual([]);
    expect(result.current.unlimitedApproval).toBe(false);
  });

  it("approves normally after StrictMode replays mount effects", async () => {
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(config, permitParams(), true);
    await waitFor(() => expect(result.current.approval).toBe("required"));
    act(() => result.current.setUnlimitedApproval(true));
    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: maxUint256 }]);
    expect(result.current.unlimitedApproval).toBe(false);
  });

  it("abandons a held allowance read when the hook unmounts but providers remain", async () => {
    const { state, config } = permitChain(0n);
    await connect(config, { connector: config.connectors[0], chainId: base.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let permit!: UsePermitReturn;
    function PermitProbe() {
      permit = usePermit(permitParams());
      return null;
    }
    function Providers({ showPermit }: { showPermit: boolean }) {
      return (
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            {showPermit && <PermitProbe />}
          </QueryClientProvider>
        </WagmiProvider>
      );
    }
    const { rerender } = render(<Providers showPermit />);
    await waitFor(() => expect(permit.approval).toBe("required"));
    const { promise, resolve: releaseRead } = Promise.withResolvers<void>();
    state.readGate = promise;
    act(() => permit.setUnlimitedApproval(true));
    const readsBeforeApproval = state.reads.length;
    let pending!: Promise<boolean>;
    act(() => {
      pending = permit.ensureApproval(AMOUNT);
    });
    await waitFor(() => expect(state.reads.length).toBeGreaterThan(readsBeforeApproval));
    rerender(<Providers showPermit={false} />);

    let approved: boolean | undefined;
    await act(async () => {
      releaseRead();
      approved = await pending;
    });
    expect(approved).toBe(false);
    expect(state.approvals).toEqual([]);
    expect(state.allowance).toBe(0n);
  });

  it.each([false, true])(
    "resets a short mainnet USDT allowance before approving, unlimited=%s",
    async (unlimited) => {
      const { state, config } = permitChain(AMOUNT - 1n, {
        zeroFirst: true,
        chainId: mainnet.id,
        token: USDT,
      });
      const { result } = await renderPermit(
        config,
        permitParams({
          token: USDT,
          chainId: mainnet.id,
          pullAuthorization: permit2Pull(
            {
              name: "Permit2",
              chainId: mainnet.id,
              verifyingContract: PERMIT2_ADDRESS,
            },
            USDT,
          ),
        }),
      );
      await waitFor(() => expect(result.current.approval).toBe("required"));
      expect(result.current.approvalMayNeedReset).toBe(true);
      if (unlimited) act(() => result.current.setUnlimitedApproval(true));

      expect(await approve(result)).toBe(true);
      expect(state.approvals).toEqual([
        { spender: PERMIT2_ADDRESS, value: 0n },
        { spender: PERMIT2_ADDRESS, value: unlimited ? maxUint256 : AMOUNT },
      ]);
      expect(state.allowance).toBe(unlimited ? maxUint256 : AMOUNT);
      expect(result.current.unlimitedApproval).toBe(false);
    },
  );

  it.each([0n, AMOUNT, maxUint256])(
    "does not reset mainnet USDT allowance %s unnecessarily",
    async (initial) => {
      const { state, config } = permitChain(initial, {
        zeroFirst: true,
        chainId: mainnet.id,
        token: USDT,
      });
      const { result } = await renderPermit(
        config,
        permitParams({
          token: USDT,
          chainId: mainnet.id,
          pullAuthorization: permit2Pull(
            {
              name: "Permit2",
              chainId: mainnet.id,
              verifyingContract: PERMIT2_ADDRESS,
            },
            USDT,
          ),
        }),
      );
      await waitFor(() =>
        expect(result.current.approval).toBe(initial >= AMOUNT ? "covered" : "required"),
      );
      expect(result.current.approvalMayNeedReset).toBe(false);
      expect(await approve(result)).toBe(true);
      expect(state.approvals).toEqual(
        initial >= AMOUNT ? [] : [{ spender: PERMIT2_ADDRESS, value: AMOUNT }],
      );
    },
  );

  it("updates a normal token's short allowance without a zero reset", async () => {
    const { state, config } = permitChain(AMOUNT - 1n);
    const { result } = await renderPermit(config);
    expect(await approve(result)).toBe(true);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: AMOUNT }]);
  });

  it.each(["reset", "unmount", "context"] as const)(
    "does not send the second USDT approval after %s during the reset receipt",
    async (abandon) => {
      const { state, config } = permitChain(AMOUNT - 1n, {
        zeroFirst: true,
        chainId: mainnet.id,
        token: USDT,
      });
      const params = permitParams({
        token: USDT,
        chainId: mainnet.id,
        pullAuthorization: permit2Pull(
          {
            name: "Permit2",
            chainId: mainnet.id,
            verifyingContract: PERMIT2_ADDRESS,
          },
          USDT,
        ),
      });
      const { result, rerender, unmount } = await renderPermit(config, params);
      await waitFor(() => expect(result.current.approval).toBe("required"));
      const { promise, resolve: releaseReceipt } = Promise.withResolvers<void>();
      state.receiptGate = promise;
      act(() => result.current.setUnlimitedApproval(true));
      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.ensureApproval(AMOUNT);
      });
      await waitFor(() =>
        expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: 0n }]),
      );
      if (abandon === "unmount") unmount();
      else if (abandon === "context") rerender({ ...params, approvalContext: "replacement" });
      else act(() => result.current.reset());

      let approved: boolean | undefined;
      await act(async () => {
        releaseReceipt();
        approved = await pending;
      });
      expect(approved).toBe(false);
      expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: 0n }]);
      expect(state.allowance).toBe(0n);
      if (abandon !== "unmount") expect(result.current.unlimitedApproval).toBe(false);
    },
  );
  it("stops and consumes consent when the USDT reset receipt reverts", async () => {
    const { state, config } = permitChain(AMOUNT - 1n, {
      zeroFirst: true,
      reverts: true,
      chainId: mainnet.id,
      token: USDT,
    });
    const { result } = await renderPermit(
      config,
      permitParams({
        token: USDT,
        chainId: mainnet.id,
        pullAuthorization: permit2Pull(
          {
            name: "Permit2",
            chainId: mainnet.id,
            verifyingContract: PERMIT2_ADDRESS,
          },
          USDT,
        ),
      }),
    );
    await waitFor(() => expect(result.current.approval).toBe("required"));
    act(() => result.current.setUnlimitedApproval(true));
    expect(await approve(result)).toBe(false);
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: 0n }]);
    expect(state.allowance).toBe(AMOUNT - 1n);
    expect(result.current.unlimitedApproval).toBe(false);
  });

  it.each([false, true])(
    "uses the mined USDT reset receipt despite a stale latest allowance, unlimited=%s",
    async (unlimited) => {
      const initial = AMOUNT - 1n;
      const { state, config } = permitChain(initial, {
        zeroFirst: true,
        chainId: mainnet.id,
        token: USDT,
      });
      // RPC reads lag while transaction validation sees the actual chain state.
      state.reportedAllowance = initial;
      const { result } = await renderPermit(
        config,
        permitParams({
          token: USDT,
          chainId: mainnet.id,
          pullAuthorization: permit2Pull(
            {
              name: "Permit2",
              chainId: mainnet.id,
              verifyingContract: PERMIT2_ADDRESS,
            },
            USDT,
          ),
        }),
      );
      await waitFor(() => expect(result.current.approval).toBe("required"));
      if (unlimited) act(() => result.current.setUnlimitedApproval(true));

      expect(await approve(result)).toBe(true);
      expect(state.approvals).toEqual([
        { spender: PERMIT2_ADDRESS, value: 0n },
        { spender: PERMIT2_ADDRESS, value: unlimited ? maxUint256 : AMOUNT },
      ]);
      expect(state.allowance).toBe(unlimited ? maxUint256 : AMOUNT);
      expect(state.reportedAllowance).toBe(initial);
      expect(result.current.approval).toBe("required");
      expect(result.current.unlimitedApproval).toBe(false);
    },
  );

  it("does not claim a USDT reset is required before its allowance is known", async () => {
    const { state, config } = permitChain(AMOUNT - 1n, {
      zeroFirst: true,
      chainId: mainnet.id,
      token: USDT,
    });
    const { promise, resolve: releaseRead } = Promise.withResolvers<void>();
    state.readGate = promise;
    const { result } = await renderPermit(
      config,
      permitParams({
        token: USDT,
        chainId: mainnet.id,
        pullAuthorization: permit2Pull(
          {
            name: "Permit2",
            chainId: mainnet.id,
            verifyingContract: PERMIT2_ADDRESS,
          },
          USDT,
        ),
      }),
    );
    expect(result.current.approval).toBe("unknown");
    expect(result.current.approvalMayNeedReset).toBe(false);

    await act(async () => {
      releaseRead();
    });
    await waitFor(() => expect(result.current.approval).toBe("required"));
    expect(result.current.approvalMayNeedReset).toBe(true);
    expect(state.approvals).toEqual([]);
  });
});
