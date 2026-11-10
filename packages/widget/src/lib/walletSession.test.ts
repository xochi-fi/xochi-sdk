// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../constants.js";
import { stubApi, TEST_WALLET } from "../test/intentHarness.js";
import {
  clearWalletSession,
  ensureWalletSession,
  getWalletSessionAddress,
  getWalletSessionGeneration,
  getWalletToken,
  subscribeWalletSession,
} from "./walletSession.js";

beforeEach(() => {
  clearWalletSession();
});

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("wallet session authority", () => {
  it("notifies synchronously after sign-in and logout without changing the stored format", async () => {
    const generation = getWalletSessionGeneration();
    const snapshots: { generation: number; token: string | null }[] = [];
    const unsubscribe = subscribeWalletSession(() => {
      snapshots.push({ generation: getWalletSessionGeneration(), token: getWalletToken() });
    });
    stubApi((call) =>
      call.url.endsWith("/challenge")
        ? { message: "Sign in", nonce: "nonce" }
        : { token: "wallet.session.jwt", wallet: TEST_WALLET },
    );
    const signedMessages: string[] = [];
    try {
      const token = await ensureWalletSession(TEST_WALLET, async ({ message }) => {
        signedMessages.push(message);
        return "0xsignature";
      });
      expect(token).toBe("wallet.session.jwt");
      expect(signedMessages).toEqual(["Sign in"]);
      expect(getWalletSessionAddress()).toBe(TEST_WALLET.toLowerCase());
      expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.walletSession)!)).toEqual({
        token: "wallet.session.jwt",
        wallet: TEST_WALLET.toLowerCase(),
      });
      expect(snapshots).toEqual([{ generation: generation + 1, token: "wallet.session.jwt" }]);

      clearWalletSession();
      expect(snapshots).toEqual([
        { generation: generation + 1, token: "wallet.session.jwt" },
        { generation: generation + 2, token: null },
      ]);
      expect(getWalletToken()).toBeNull();
    } finally {
      unsubscribe();
    }
    clearWalletSession();
    expect(snapshots).toHaveLength(2);
  });

  it.each(["challenge", "signature", "verification"] as const)(
    "does not resurrect a session cleared while awaiting %s",
    async (stage) => {
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<unknown>();
      const signature = Promise.withResolvers<string>();
      let signed = 0;
      const api = stubApi((call) => {
        const isChallenge = call.url.endsWith("/challenge");
        if ((isChallenge && stage === "challenge") || (!isChallenge && stage === "verification")) {
          entered.resolve();
          return response.promise;
        }
        return isChallenge
          ? { message: "Sign in", nonce: "nonce" }
          : { token: "wallet.session.jwt", wallet: TEST_WALLET };
      });
      const signIn = ensureWalletSession(TEST_WALLET, async () => {
        signed += 1;
        if (stage === "signature") {
          entered.resolve();
          return signature.promise;
        }
        return "0xsignature";
      });
      const rejected = expect(signIn).rejects.toThrow("Wallet session changed during sign-in");
      await entered.promise;
      const generation = getWalletSessionGeneration();
      clearWalletSession();
      response.resolve(
        stage === "challenge"
          ? { message: "Sign in", nonce: "nonce" }
          : { token: "wallet.session.jwt", wallet: TEST_WALLET },
      );
      signature.resolve("0xsignature");
      await rejected;

      expect(getWalletSessionGeneration()).toBe(generation + 1);
      expect(getWalletToken()).toBeNull();
      expect(getWalletSessionAddress()).toBeNull();
      expect(signed).toBe(stage === "challenge" ? 0 : 1);
      expect(api.calls.filter((call) => call.url.endsWith("/verify"))).toHaveLength(
        stage === "verification" ? 1 : 0,
      );
    },
  );
});
