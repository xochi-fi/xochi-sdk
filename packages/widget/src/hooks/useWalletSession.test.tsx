// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { connect, disconnect, getAccount } from "wagmi/actions";
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
    const verifying = Promise.withResolvers<void>();
    const verification = Promise.withResolvers<unknown>();
    const api = stubApi((call) => {
      if (call.body?.method === "eth_sign") {
        return { jsonrpc: "2.0", id: call.body.id, result: `0x${"11".repeat(64)}1b` };
      }
      if (call.url.endsWith("/challenge")) return { message: "Sign in", nonce: "nonce" };
      verifying.resolve();
      return verification.promise;
    });
    let observers = 2;
    function Observer() {
      useWalletSession();
      return null;
    }
    const SharedProvider = testWrapper(config);
    const { result, rerender } = renderHook(() => useWalletSession(), {
      wrapper: ({ children }) => (
        <SharedProvider>
          {children}
          {observers >= 1 && <Observer />}
          {observers >= 2 && <Observer />}
        </SharedProvider>
      ),
    });
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.state).toBe("idle");
    expect(api.calls).toEqual([]);

    let pending!: Promise<string | null>;
    await act(async () => {
      pending = result.current.ensureSession();
      await verifying.promise;
    });
    expect(result.current.state).toBe("signing");
    observers = 1;
    rerender();
    expect(result.current.state).toBe("signing");
    let signedIn: string | null = null;
    await act(async () => {
      verification.resolve({ token: "wallet.session.jwt", wallet: TEST_WALLET });
      signedIn = await pending;
    });
    expect(signedIn).toBe("wallet.session.jwt");
    expect(result.current.state).toBe("active");
    expect(result.current.isActive).toBe(true);
    expect(api.calls.filter((call) => call.body?.method === "eth_sign")).toHaveLength(1);

    observers = 0;
    rerender();
    expect(getWalletToken()).toBe("wallet.session.jwt");
    expect(result.current.isActive).toBe(true);
    const callsBeforeReuse = api.calls.length;
    let reusedToken: string | null = null;
    await act(async () => {
      reusedToken = await result.current.ensureSession();
    });
    expect(reusedToken).toBe("wallet.session.jwt");
    expect(api.calls).toHaveLength(callsBeforeReuse);
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

  it.each([
    ["challenge", false],
    ["challenge", true],
    ["signature", false],
    ["signature", true],
    ["verification", false],
    ["verification", true],
  ] as const)(
    "cancels pending %s work on teardown (disconnect: %s) without clearing shared session authority",
    async (stage, disconnectAfterTeardown) => {
      const config = createTestWagmiConfig();
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<unknown>();
      const api = stubApi((call) => {
        const isSignature = call.body?.method === "eth_sign";
        const isChallenge = call.url.endsWith("/challenge");
        if (
          (isChallenge && stage === "challenge") ||
          (isSignature && stage === "signature") ||
          (!isChallenge && !isSignature && stage === "verification")
        ) {
          entered.resolve();
          return response.promise;
        }
        return isSignature
          ? { jsonrpc: "2.0", id: call.body?.id, result: `0x${"11".repeat(64)}1b` }
          : { message: "Sign in", nonce: "nonce" };
      });
      const { result, unmount } = renderHook(() => useWalletSession(), {
        wrapper: testWrapper(config),
      });
      await act(async () => {
        await connect(config, { connector: config.connectors[0] });
        await vi.advanceTimersByTimeAsync(10);
      });
      const ensureSession = result.current.ensureSession;
      let pending!: Promise<string | null>;
      await act(async () => {
        pending = ensureSession();
        await entered.promise;
      });
      await act(async () => {
        unmount();
        if (disconnectAfterTeardown) await disconnect(config);
      });
      expect(getAccount(config).address).toBe(disconnectAfterTeardown ? undefined : TEST_WALLET);
      const callsBeforeAnswer = api.calls.length;
      let outcome: string | null = null;
      await act(async () => {
        response.resolve(
          stage === "challenge"
            ? { message: "Sign in", nonce: "nonce" }
            : stage === "signature"
              ? { jsonrpc: "2.0", id: 1, result: `0x${"11".repeat(64)}1b` }
              : { token: "obsolete.wallet.jwt", wallet: TEST_WALLET },
        );
        outcome = await pending;
      });
      expect(outcome).toBeNull();
      expect(getWalletToken()).toBeNull();
      expect(api.calls).toHaveLength(callsBeforeAnswer);
      expect(api.calls.filter((call) => call.body?.method === "eth_sign")).toHaveLength(
        stage === "challenge" ? 0 : 1,
      );
      await act(async () => {
        expect(await ensureSession()).toBeNull();
      });
      expect(api.calls).toHaveLength(callsBeforeAnswer);
    },
  );
});
