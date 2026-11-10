// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { connect, getAccount } from "wagmi/actions";
import { useWalletSession } from "./useWalletSession.js";
import { clearWalletSession, getWalletToken } from "../lib/walletSession.js";
import { createTestWagmiConfig, stubApi, testWrapper, TEST_WALLET } from "../test/intentHarness.js";

beforeEach(() => {
  clearWalletSession();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  clearWalletSession();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wallet session hook authority", () => {
  it("requests no signature on connect and reflects explicit same-wallet sign-in and logout", async () => {
    const config = createTestWagmiConfig();
    const api = stubApi((call) => {
      if (call.body?.method === "eth_sign") {
        return { jsonrpc: "2.0", id: call.body.id, result: `0x${"11".repeat(64)}1b` };
      }
      return call.url.endsWith("/challenge")
        ? { message: "Sign in", nonce: "nonce" }
        : { token: "wallet.session.jwt", wallet: TEST_WALLET };
    });
    const { result } = renderHook(() => useWalletSession(), { wrapper: testWrapper(config) });
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.state).toBe("idle");
    expect(api.calls).toEqual([]);

    let signedIn: string | null = null;
    await act(async () => {
      signedIn = await result.current.ensureSession();
    });
    expect(signedIn).toBe("wallet.session.jwt");
    expect(result.current.state).toBe("active");
    expect(result.current.isActive).toBe(true);
    expect(api.calls.filter((call) => call.body?.method === "eth_sign")).toHaveLength(1);

    await act(async () => {
      clearWalletSession();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.isActive).toBe(false);
  });

  it.each(["switch", "disconnect"] as const)(
    "invalidates a first sign-in's pending challenge on wallet %s before signing",
    async (transition) => {
      const config = createTestWagmiConfig();
      const challenge = Promise.withResolvers<unknown>();
      const api = stubApi(() => challenge.promise);
      const { result } = renderHook(() => useWalletSession(), { wrapper: testWrapper(config) });
      await act(async () => {
        await connect(config, { connector: config.connectors[0] });
        await vi.advanceTimersByTimeAsync(10);
      });
      let pending: Promise<string | null> | undefined;
      await act(async () => {
        pending = result.current.ensureSession();
      });
      expect(result.current.state).toBe("signing");
      expect(getWalletToken()).toBeNull();
      await act(async () => {
        config.connectors[0].onAccountsChanged(
          transition === "switch" ? ["0x2222222222222222222222222222222222222222"] : [],
        );
      });
      expect(getAccount(config).address).toBe(
        transition === "disconnect" ? undefined : "0x2222222222222222222222222222222222222222",
      );
      expect(result.current.state).toBe("idle");
      let outcome: string | null | undefined;
      await act(async () => {
        challenge.resolve({ message: "Sign in", nonce: "nonce" });
        outcome = await pending;
      });
      expect(outcome).toBeNull();
      expect(getWalletToken()).toBeNull();
      expect(result.current.state).toBe("idle");
      expect(result.current.isActive).toBe(false);
      expect(api.calls).toHaveLength(1);
    },
  );

  it("invalidates a pending sign-in when the signer connection changes at the same wallet", async () => {
    const config = createTestWagmiConfig();
    const replacement = createTestWagmiConfig();
    const challenge = Promise.withResolvers<unknown>();
    const api = stubApi(() => challenge.promise);
    const { result } = renderHook(() => useWalletSession(), { wrapper: testWrapper(config) });
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
      await vi.advanceTimersByTimeAsync(10);
    });
    let pending: Promise<string | null> | undefined;
    await act(async () => {
      pending = result.current.ensureSession();
    });
    expect(result.current.state).toBe("signing");
    await act(async () => {
      await connect(config, { connector: replacement.connectors[0] });
    });
    expect(getAccount(config).address).toBe(TEST_WALLET);
    expect(getAccount(config).connector?.uid).toBe(replacement.connectors[0].uid);
    expect(result.current.state).toBe("idle");
    let outcome: string | null | undefined;
    await act(async () => {
      challenge.resolve({ message: "Sign in", nonce: "nonce" });
      outcome = await pending;
    });
    expect(outcome).toBeNull();
    expect(getWalletToken()).toBeNull();
    expect(result.current.isActive).toBe(false);
    expect(api.calls).toHaveLength(1);
  });
});
