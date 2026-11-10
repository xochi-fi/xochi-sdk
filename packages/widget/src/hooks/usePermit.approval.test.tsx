// @vitest-environment jsdom

/**
 * usePermit approves only the canonical Permit2 contract (SPEC §2.3), and its
 * approval state and `ensureApproval` come from ONE allowance read.
 *
 * The approval is unlimited, so a served pull whose domain names any other
 * contract must be refused, never approved, even though @xochi/client already
 * refuses such a quote at ingest. The payment copy says "no gas needed" only
 * when `approval` is `covered`, and `ensureApproval` sends the gasful
 * `approve(Permit2)` only when a refetch of that same read is short. These run
 * the hook against a one-wallet Base whose allowance moves when an approve is
 * sent, so the copy is seen flipping from the chain, not from a flag.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { WagmiProvider, createConfig, type Config } from "wagmi";
import { base } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import { connect } from "@wagmi/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { custom, decodeFunctionData, erc20Abi, maxUint256, numberToHex, toHex } from "viem";
import { PERMIT2_ADDRESS } from "@xochi/signer";
import { usePermit, type UsePermitReturn } from "./usePermit.js";
import type { Eip712TypedData } from "../types/intent.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
/** WETH on Base: no ERC-3009, so the pull is Permit2 either way. */
const TOKEN = "0x4200000000000000000000000000000000000006";
const AMOUNT = 1_000_000_000_000_000_000n;
const TX_HASH = `0x${"ab".repeat(32)}` as const;
const FOREIGN = `0x${"66".repeat(20)}`;
/** Where the mock connector forwards the wallet's own requests (the approve). */
const RPC = "http://permit-chain.invalid/rpc";

const permit2Pull = (domain: Eip712TypedData["domain"]): Eip712TypedData => ({
  domain,
  types: { PermitWitnessTransferFrom: [{ name: "spender", type: "address" }] },
  primaryType: "PermitWitnessTransferFrom",
  message: { permitted: { token: TOKEN, amount: AMOUNT.toString() } },
});

const VERSIONED = permit2Pull({
  name: "Permit2",
  version: "1",
  chainId: base.id,
  verifyingContract: PERMIT2_ADDRESS,
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
function permitChain(initial: bigint, { reverts = false } = {}) {
  const state = {
    allowance: initial,
    reads: [] as string[],
    approvals: [] as Array<{ spender: string; value: bigint }>,
  };
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    switch (method) {
      case "eth_chainId":
        return numberToHex(base.id);
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
        return toHex(state.allowance, { size: 32 });
      }
      case "eth_sendTransaction": {
        const call = decodeFunctionData({ abi: erc20Abi, data: callData(params) });
        if (call.functionName !== "approve") throw new Error(`permit chain: ${call.functionName}`);
        const [spender, value] = call.args;
        state.approvals.push({ spender, value });
        if (!reverts) state.allowance = value;
        return TX_HASH;
      }
      case "eth_getTransactionReceipt":
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
          to: TOKEN,
          transactionHash: TX_HASH,
          transactionIndex: "0x0",
          type: "0x2",
        };
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
    chains: [{ ...base, rpcUrls: { default: { http: [RPC] } } }],
    connectors: [mock({ accounts: [WALLET], features: { reconnect: true } })],
    transports: { [base.id]: custom({ request }) },
    batch: { multicall: false },
  });
  return { state, config };
}

async function renderPermit(config: Config, pullAuthorization: Eip712TypedData = VERSIONED) {
  await connect(config, { connector: config.connectors[0], chainId: base.id });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  return renderHook(
    () =>
      usePermit({
        token: TOKEN,
        chainId: base.id,
        pullAuthorization,
        amount: AMOUNT.toString(),
      }),
    { wrapper },
  );
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
      permit2Pull({ name: "Permit2", chainId: base.id, verifyingContract: PERMIT2_ADDRESS }),
    );
    await waitFor(() => expect(result.current.approval).toBe("required"));

    expect(await approve(result)).toBe(true);
    expect(new Set(state.reads)).toEqual(new Set([PERMIT2_ADDRESS]));
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: maxUint256 }]);
  });

  it("refuses a served domain that names another contract, sending nothing", async () => {
    const errors = vi.spyOn(console, "error");
    const { state, config } = permitChain(0n);
    const { result } = await renderPermit(
      config,
      permit2Pull({ name: "Permit2", chainId: base.id, verifyingContract: FOREIGN }),
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
    expect(state.approvals).toEqual([{ spender: PERMIT2_ADDRESS, value: maxUint256 }]);
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
