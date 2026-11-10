// @vitest-environment jsdom

import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../constants.js";
import { authFetch } from "./authFetch.js";
import { clearWalletSession, getWalletToken } from "./walletSession.js";
import { stubApi } from "../test/intentHarness.js";

let server: Server;
let baseUrl = "";
let authorization = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    authorization = request.headers.authorization ?? "";
    const category = request.url?.slice(1) || "unknown";
    response.writeHead(category === "wallet_auth_mismatch" ? 403 : 401, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ success: false, error: "rejected", error_category: category }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("auth test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function storeWalletSession(token = "wallet-token"): void {
  sessionStorage.setItem(
    STORAGE_KEYS.walletSession,
    JSON.stringify({ token, wallet: "0x1111111111111111111111111111111111111111" }),
  );
}

beforeEach(() => {
  authorization = "";
  storeWalletSession();
});

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("authFetch wallet-session eviction", () => {
  it("preserves valid credentials across business-rule and signature failures", async () => {
    for (const category of [
      "wallet_auth_mismatch",
      "signature_invalid",
      "served_payload_mismatch",
      "verification_unavailable",
    ]) {
      storeWalletSession();
      const response = await authFetch(`${baseUrl}/${category}`);

      expect([401, 403]).toContain(response.status);
      expect(authorization).toBe("Bearer wallet-token");
      expect(getWalletToken()).toBe("wallet-token");
    }
  });

  it("clears the session only when the server names an invalid credential", async () => {
    const response = await authFetch(`${baseUrl}/auth_invalid`);

    expect(response.status).toBe(401);
    expect(getWalletToken()).toBeNull();
  });

  it.each(["other-wallet-token", "wallet-token"])(
    "does not evict a newer session using %s when an old request fails",
    async (replacementToken) => {
      const response = Promise.withResolvers<unknown>();
      stubApi(() => response.promise);
      const request = authFetch("https://api.example.test/history");
      clearWalletSession();
      storeWalletSession(replacementToken);
      response.resolve(
        new Response(JSON.stringify({ error_category: "auth_invalid" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect((await request).status).toBe(401);
      expect(getWalletToken()).toBe(replacementToken);
    },
  );

  it("does not evict a wallet session for an explicitly supplied unrelated credential", async () => {
    stubApi(
      () => new Response(JSON.stringify({ error_category: "auth_invalid" }), { status: 401 }),
    );
    await authFetch("https://api.example.test/history", {
      headers: { Authorization: "Bearer explicit-passkey-token" },
    });
    expect(getWalletToken()).toBe("wallet-token");
  });
});
