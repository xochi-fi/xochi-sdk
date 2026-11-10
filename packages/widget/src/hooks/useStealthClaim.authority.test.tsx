// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, type Config } from "wagmi";
import { connect, disconnect } from "wagmi/actions";
import {
  bytesToHex,
  encodeFunctionData,
  parseAbi,
  recoverAddress,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAddress } from "viem/accounts";
import {
  computeMetaAddressFromKeys,
  computeStealthAddress,
  computeUserOpHash,
  deriveStealthKeys,
  deriveStealthOwner,
  ENTRYPOINT_V08_ADDRESS,
  type StealthAnnouncement,
  type UserOperationV08,
} from "@xochi/signer";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";
import { clearWalletSession } from "../lib/walletSession.js";
import { apiStub, makeTestConfig, TEST_ACCOUNT, type FetchStub } from "../pages/trade/harness.js";
import { StealthProvider, useStealth } from "./useStealth.js";
import { useStealthClaim, type ClaimResult } from "./useStealthClaim.js";

const WALLET_B = "0x2222222222222222222222222222222222222222" as const;
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as const;
const keys = deriveStealthKeys(`0x${"ab".repeat(64)}1b`);
const settlement = computeStealthAddress(
  computeMetaAddressFromKeys(keys, 1),
  `0x${"01".repeat(32)}`,
);
// The existing harness's factory eth_call returns the zero address, and its
// token balance is configurable. Only that existing RPC boundary is simulated;
// discovery, owner derivation, verification, hashing and signing remain real.
const announcement: StealthAnnouncement = {
  schemeId: 1,
  stealthAddress: zeroAddress,
  caller: TEST_ACCOUNT,
  ephemeralPubKey: settlement.ephemeralPubKey,
  metadata: `0x${settlement.viewTag.toString(16).padStart(2, "0")}${TOKEN.slice(2)}a9059cbb${"1".padStart(64, "0")}${SIMPLE_ACCOUNT_FACTORY.slice(2)}${"0".repeat(64)}`,
  blockNumber: 10,
  txHash: `0x${"12".repeat(32)}`,
  logIndex: 0,
};
const owner = privateKeyToAddress(
  bytesToHex(deriveStealthOwner(announcement, keys.spendingKey, keys.viewingKey).stealthPrivKey),
);
const abi = parseAbi([
  "function execute(address dest, uint256 value, bytes func)",
  "function transfer(address to, uint256 amount)",
  "function createAccount(address owner, uint256 salt)",
]);

function preparedClaim(recipient: Hex) {
  const userOperation: UserOperationV08 = {
    sender: zeroAddress,
    nonce: "0x0",
    factory: SIMPLE_ACCOUNT_FACTORY,
    factoryData: encodeFunctionData({ abi, functionName: "createAccount", args: [owner, 0n] }),
    callData: encodeFunctionData({
      abi,
      functionName: "execute",
      args: [
        TOKEN,
        0n,
        encodeFunctionData({ abi, functionName: "transfer", args: [recipient, 1n] }),
      ],
    }),
    callGasLimit: "0x30000",
    verificationGasLimit: "0x30000",
    preVerificationGas: "0x10000",
    maxFeePerGas: "0x77359400",
    maxPriorityFeePerGas: "0x3b9aca00",
    paymaster: "0x0000000000000039cd5e8ae05257ce51c473ddd1",
    paymasterVerificationGasLimit: "0xffff",
    paymasterPostOpGasLimit: "0x1",
    paymasterData: "0x01000000678122b100000000000000000000aaaaabbbbccccc",
    signature: "0x",
  };
  return {
    userOperation,
    userOpHash: computeUserOpHash(userOperation, ENTRYPOINT_V08_ADDRESS, 1),
    entryPoint: ENTRYPOINT_V08_ADDRESS,
    chainId: 1,
    stealthAddress: owner,
    counterfactualAddress: zeroAddress,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function setSession(wallet: string): void {
  sessionStorage.setItem(
    STORAGE_KEYS.walletSession,
    JSON.stringify({ token: `session-${wallet}`, wallet: wallet.toLowerCase() }),
  );
}

function switchWallet(config: Config): void {
  setSession(WALLET_B);
  config.setState((state) => {
    const connection = state.current && state.connections.get(state.current);
    if (!connection || !state.current) throw new Error("Harness wallet is not connected");
    return {
      ...state,
      connections: new Map(state.connections).set(state.current, {
        ...connection,
        accounts: [WALLET_B],
      }),
    };
  });
}

async function renderClaims(fetch: FetchStub) {
  vi.stubGlobal("fetch", fetch);
  setSession(TEST_ACCOUNT);
  const config = makeTestConfig(1n);
  await connect(config, { connector: config.connectors[0] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <StealthProvider>{children}</StealthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
  const hook = renderHook(() => ({ claim: useStealthClaim(), stealth: useStealth() }), { wrapper });
  await waitFor(() => expect(config.state.status).toBe("connected"));
  await act(async () => {
    expect(await hook.result.current.stealth.initializeKeys()).toBe(true);
  });
  return { ...hook, config };
}

function claimRoutes(submitted: unknown[] = [], prepared: unknown[] = []) {
  return apiStub({
    "/api/stealth/announcements": {
      body: { success: true, announcements: [announcement], count: 1 },
    },
    "/api/stealth/claim/prepare": {
      answer: (request) => {
        prepared.push(request);
        if (
          !request ||
          typeof request !== "object" ||
          !("recipientAddress" in request) ||
          typeof request.recipientAddress !== "string"
        ) {
          throw new Error("Harness prepare requires a recipient");
        }
        return preparedClaim(request.recipientAddress as Hex);
      },
    },
    "/api/stealth/claim/submit": {
      answer: (request) => {
        submitted.push(request);
        return { txHash: `0x${"34".repeat(32)}`, opHash: `0x${"56".repeat(32)}` };
      },
    },
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearWalletSession();
  vi.unstubAllGlobals();
});

describe("stealth claim authority", () => {
  it("still discovers, independently verifies and signs an authorized payment", async () => {
    const submitted: { userOpHash: Hex; signature: Hex }[] = [];
    const { result } = await renderClaims(claimRoutes(submitted));
    await act(() => result.current.claim.scan());
    const payment = result.current.claim.payments.find((row) => row.chainId === 1)!;
    expect(payment).toBeDefined();
    let outcome!: ClaimResult;
    await act(async () => {
      outcome = await result.current.claim.claim(payment, TEST_ACCOUNT);
    });
    expect(outcome).toMatchObject({ success: true });
    expect(submitted).toHaveLength(1);
    expect(
      await recoverAddress({ hash: submitted[0].userOpHash, signature: submitted[0].signature }),
    ).toBe(owner);
  });

  it.each(["switch", "disconnect", "lock", "session"] as const)(
    "revokes retained payments and old callbacks on %s",
    async (change) => {
      const prepared: unknown[] = [];
      const { result, config } = await renderClaims(claimRoutes([], prepared));
      await act(() => result.current.claim.scan());
      const payment = result.current.claim.payments.find((row) => row.chainId === 1)!;
      const oldClaim = result.current.claim.claim;
      await act(async () => {
        if (change === "switch") switchWallet(config);
        else if (change === "disconnect") await disconnect(config);
        else if (change === "lock") result.current.stealth.reset();
        else {
          clearWalletSession();
          // Reusing the exact token cannot revive the pre-logout authority.
          setSession(TEST_ACCOUNT);
        }
        // Check in the same turn, before a React effect can protect the old callback.
        expect(await oldClaim(payment, WALLET_B)).toMatchObject({
          errorCategory: "claim_authority_revoked",
        });
      });
      expect(result.current.claim.payments).toEqual([]);
      expect(payment.stealthPrivKey?.every((byte) => byte === 0)).toBe(true);
      expect(prepared).toEqual([]);
    },
  );

  it.each(["disconnect", "lock", "session"] as const)(
    "refuses a prepared operation after %s while prepare was pending",
    async (change) => {
      const submitted: unknown[] = [];
      const delayed = Promise.withResolvers<Response>();
      let preparing = false;
      const rest = claimRoutes(submitted);
      const fetch: FetchStub = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/stealth/claim/prepare")) {
          preparing = true;
          return delayed.promise;
        }
        return rest(input, init);
      };
      const { result, config } = await renderClaims(fetch);
      await act(() => result.current.claim.scan());
      const payment = result.current.claim.payments.find((row) => row.chainId === 1)!;
      let pending!: Promise<ClaimResult>;
      act(() => {
        pending = result.current.claim.claim(payment, TEST_ACCOUNT);
      });
      await waitFor(() => expect(preparing).toBe(true));
      await act(async () => {
        if (change === "disconnect") await disconnect(config);
        else if (change === "lock") result.current.stealth.reset();
        else clearWalletSession();
        delayed.resolve(json(preparedClaim(TEST_ACCOUNT)));
        expect(await pending).toMatchObject({ errorCategory: "claim_authority_revoked" });
      });
      expect(submitted).toEqual([]);
      expect(result.current.claim.payments).toEqual([]);
      expect(result.current.claim.isClaiming).toBe(false);
    },
  );

  it("discards deferred prepare authority without clobbering a newer wallet's successful claim", async () => {
    const submitted: unknown[] = [];
    const delayed = Promise.withResolvers<Response>();
    let waiting = false;
    const rest = claimRoutes(submitted);
    const fetch: FetchStub = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/stealth/claim/prepare") && !waiting) {
        waiting = true;
        return delayed.promise;
      }
      return rest(input, init);
    };
    const { result, config } = await renderClaims(fetch);
    await act(() => result.current.claim.scan());
    const payment = result.current.claim.payments.find((row) => row.chainId === 1)!;
    let oldClaim!: Promise<ClaimResult>;
    act(() => {
      oldClaim = result.current.claim.claim(payment, TEST_ACCOUNT);
    });
    await waitFor(() => expect(waiting).toBe(true));
    act(() => switchWallet(config));
    await act(async () => {
      expect(await result.current.stealth.initializeKeys()).toBe(true);
    });
    await act(() => result.current.claim.scan());
    const currentPayment = result.current.claim.payments.find((row) => row.chainId === 1)!;
    let currentOutcome!: ClaimResult;
    await act(async () => {
      currentOutcome = await result.current.claim.claim(currentPayment, WALLET_B);
    });
    expect(currentOutcome).toMatchObject({ success: true });
    await act(async () => {
      delayed.resolve(json(preparedClaim(TEST_ACCOUNT)));
      expect(await oldClaim).toMatchObject({ errorCategory: "claim_authority_revoked" });
    });
    expect(submitted).toHaveLength(1);
    expect(result.current.claim.error).toBeNull();
    expect(result.current.claim.isClaiming).toBe(false);
  });

  it("preserves an already-submitted pending outcome after keys lock without restoring old UI authority", async () => {
    const delayed = Promise.withResolvers<Response>();
    const submitted: unknown[] = [];
    const rest = claimRoutes();
    const fetch: FetchStub = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/stealth/claim/submit")) {
        submitted.push(JSON.parse(String(init?.body)));
        return delayed.promise;
      }
      return rest(input, init);
    };
    const { result } = await renderClaims(fetch);
    await act(() => result.current.claim.scan());
    const payment = result.current.claim.payments.find((row) => row.chainId === 1)!;
    let pending!: Promise<ClaimResult>;
    let outcome: ClaimResult | undefined;
    act(() => {
      pending = result.current.claim.claim(payment, TEST_ACCOUNT).then((value) => {
        outcome = value;
        return value;
      });
    });
    await waitFor(() =>
      expect({ submitted, outcome }).toMatchObject({
        submitted: [expect.anything()],
      }),
    );
    await act(async () => {
      result.current.stealth.reset();
      delayed.resolve(
        json(
          {
            success: false,
            error: "Operation accepted",
            error_category: "claim_pending",
            opHash: preparedClaim(TEST_ACCOUNT).userOpHash,
            retryAfter: 300,
          },
          503,
        ),
      );
      expect(await pending).toMatchObject({ pending: true, errorCategory: "claim_pending" });
    });
    expect(submitted).toHaveLength(1);
    expect(result.current.claim.payments).toEqual([]);
    expect(result.current.claim.isClaiming).toBe(false);
    expect(result.current.claim.isConfirming).toBe(false);
    expect(result.current.claim.error).toBeNull();
  });

  it("keeps a new scan busy when a revoked scan's errors and finally arrive", async () => {
    const responses: PromiseWithResolvers<Response>[] = [];
    const rest = claimRoutes();
    const fetch: FetchStub = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/stealth/announcements")) {
        const response = Promise.withResolvers<Response>();
        responses.push(response);
        return response.promise;
      }
      return rest(input, init);
    };
    const { result, config } = await renderClaims(fetch);
    let oldScan!: Promise<void>;
    act(() => {
      oldScan = result.current.claim.scan();
    });
    await waitFor(() => expect(responses).toHaveLength(2));
    act(() => switchWallet(config));
    await act(async () => {
      expect(await result.current.stealth.initializeKeys()).toBe(true);
    });
    let currentScan!: Promise<void>;
    act(() => {
      currentScan = result.current.claim.scan();
    });
    await waitFor(() => expect(responses).toHaveLength(4));
    await act(async () => {
      responses[0].resolve(json({ success: true, announcements: [announcement], count: 1 }));
      responses[1].resolve(json({ error: "Old wallet scan failed" }, 503));
      await oldScan;
    });
    expect(result.current.claim.payments).toEqual([]);
    expect(result.current.claim.isScanning).toBe(true);
    expect(result.current.claim.error).toBeNull();
    await act(async () => {
      for (const response of responses.slice(2))
        response.resolve(json({ success: true, announcements: [], count: 0 }));
      await currentScan;
    });
    expect(result.current.claim.isScanning).toBe(false);
    expect(result.current.claim.hasScanned).toBe(true);
  });
});
