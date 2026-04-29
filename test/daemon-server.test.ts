/**
 * Daemon server tests -- starts the HTTP daemon on a random port, hits it
 * with fetch requests, asserts auth + replay + audit semantics.
 *
 * mTLS path is not exercised here (would require generating a CA + certs in
 * the test). Bearer-auth path covers all of the request handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Barretenberg } from "@aztec/bb.js";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  RawKeyLoader,
  loadSignerKey,
  MemoryReplayDb,
  type SignerKey,
} from "../src/provider/index.js";
import { createDaemonServer, type DaemonServer } from "../daemon/src/server.js";
import { MemoryAuditSink } from "../daemon/src/audit.js";
import type { DaemonConfig } from "../daemon/src/config.js";

const TEST_PRIVATE_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_PRIVATE_KEY[i] = i + 1; // 0x01..0x20
const TEST_API_KEY = "test-bearer-key-do-not-ship";

let api: Barretenberg;
let signerKey: SignerKey;
let replayDb: MemoryReplayDb;
let audit: MemoryAuditSink;
let server: DaemonServer;
let baseUrl: string;

beforeAll(async () => {
  api = await Barretenberg.new();
  signerKey = await loadSignerKey(new RawKeyLoader(TEST_PRIVATE_KEY, "daemon-test"));
  replayDb = new MemoryReplayDb();
  audit = new MemoryAuditSink();
  const config: DaemonConfig = {
    host: "127.0.0.1",
    port: 0, // ephemeral
    signerKeyHex: "0x" + Buffer.from(TEST_PRIVATE_KEY).toString("hex"),
    apiKey: TEST_API_KEY,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    clientCaPath: undefined,
    auditLogPath: undefined,
    providerLabel: "test",
  };
  server = createDaemonServer({ api, signerKey, replayDb, audit }, config);
  const { host, port } = await server.listen();
  baseUrl = `http://${host}:${String(port)}`;
}, 60_000);

afterAll(async () => {
  await server.close();
  await api.destroy();
});

const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";
const SUBMITTER = "0x000000000000000000000000000000000000dEaD";

const SAMPLE_BODY = {
  providerSetHash: PROVIDER_SET_HASH,
  signals: [25, 0, 0, 0, 0, 0, 0, 0],
  weights: [100, 0, 0, 0, 0, 0, 0, 0],
  timestamp: "1700000000",
  submitter: SUBMITTER,
};

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TEST_API_KEY}`,
  };
}

describe("GET /healthz", () => {
  it("is unauthenticated and returns ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("rejects /sign without bearer token", async () => {
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("rejects /sign with wrong bearer token", async () => {
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("rejects /pubkey-hash without bearer token", async () => {
    const res = await fetch(`${baseUrl}/pubkey-hash`);
    expect(res.status).toBe(401);
  });
});

describe("GET /pubkey-hash", () => {
  it("returns a 32-byte hash and the (x, y) coords", async () => {
    const res = await fetch(`${baseUrl}/pubkey-hash`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signerPubkeyHash: string;
      pubkeyX: string;
      pubkeyY: string;
    };
    expect(body.signerPubkeyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.pubkeyX).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.pubkeyY).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("POST /sign", () => {
  it("returns a signature that ECDSA-verifies", async () => {
    replayDb.reset();
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signature: string;
      pubkeyX: string;
      pubkeyY: string;
      payloadHash: string;
    };

    // Reconstruct uncompressed pubkey + payload hash, verify off-chain.
    const sigBytes = Buffer.from(body.signature.slice(2), "hex");
    const xBytes = Buffer.from(body.pubkeyX.slice(2), "hex");
    const yBytes = Buffer.from(body.pubkeyY.slice(2), "hex");
    const digest = Buffer.from(body.payloadHash.slice(2), "hex");
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(xBytes, 1);
    uncompressed.set(yBytes, 33);
    expect(secp256k1.verify(sigBytes, digest, uncompressed)).toBe(true);
  });

  it("rejects malformed body with 400", async () => {
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ providerSetHash: PROVIDER_SET_HASH }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_REQUEST");
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate request with 409 REPLAY", async () => {
    replayDb.reset();
    const ok = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(ok.status).toBe(200);

    const dup = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { code: string };
    expect(body.code).toBe("REPLAY");
  });

  it("audits each accepted sign", async () => {
    replayDb.reset();
    audit.events.length = 0;
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(res.status).toBe(200);
    expect(audit.events.length).toBe(1);
    expect(audit.events[0].outcome).toBe("signed");
    expect(audit.events[0].source).toBe("bearer");
  });

  it("rejects oversized body with 413", async () => {
    const huge = "x".repeat(64 * 1024); // > 32 KB limit
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: huge,
    });
    expect(res.status).toBe(413);
  });
});

describe("POST /sign-credential-root", () => {
  const ORACLE = "0x1234567890123456789012345678901234567890";
  const ROOT = "0x" + "ab".repeat(32);

  function credentialRootBody(
    overrides?: Partial<Record<string, unknown>>,
  ): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      chainId: 31337,
      oracleAddress: ORACLE,
      providerId: 42,
      root: ROOT,
      cid: "ipfs://Qm-test",
      notBefore: now - 60,
      notAfter: now + 3600,
      ...overrides,
    };
  }

  it("rejects without bearer", async () => {
    const res = await fetch(`${baseUrl}/sign-credential-root`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentialRootBody()),
    });
    expect(res.status).toBe(401);
  });

  it("returns a 65-byte signature plus digest and signer", async () => {
    const res = await fetch(`${baseUrl}/sign-credential-root`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(credentialRootBody()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signature: string; digest: string; signer: string };
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/); // 65 bytes
    expect(body.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.signer).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("digest depends on root", async () => {
    const a = await (
      await fetch(`${baseUrl}/sign-credential-root`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(credentialRootBody({ root: "0x" + "11".repeat(32) })),
      })
    ).json();
    const b = await (
      await fetch(`${baseUrl}/sign-credential-root`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(credentialRootBody({ root: "0x" + "22".repeat(32) })),
      })
    ).json();
    expect((a as { digest: string }).digest).not.toBe((b as { digest: string }).digest);
  });

  it("digest depends on cid (cidHash binding)", async () => {
    const a = await (
      await fetch(`${baseUrl}/sign-credential-root`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(credentialRootBody({ cid: "ipfs://A" })),
      })
    ).json();
    const b = await (
      await fetch(`${baseUrl}/sign-credential-root`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(credentialRootBody({ cid: "ipfs://B" })),
      })
    ).json();
    expect((a as { digest: string }).digest).not.toBe((b as { digest: string }).digest);
  });

  it("signature recovers to the daemon's signer address", async () => {
    const res = await fetch(`${baseUrl}/sign-credential-root`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(credentialRootBody()),
    });
    const body = (await res.json()) as { signature: string; digest: string; signer: string };
    const sigBytes = Buffer.from(body.signature.slice(2), "hex");
    const digestBytes = Buffer.from(body.digest.slice(2), "hex");
    // Reconstruct uncompressed pubkey for noble; verify the signature.
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(signerKey.publicKeyX, 1);
    uncompressed.set(signerKey.publicKeyY, 33);
    expect(secp256k1.verify(sigBytes.subarray(0, 64), digestBytes, uncompressed)).toBe(true);
  });

  it("rejects malformed body", async () => {
    const res = await fetch(`${baseUrl}/sign-credential-root`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ providerId: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects inverted window", async () => {
    const res = await fetch(`${baseUrl}/sign-credential-root`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(credentialRootBody({ notBefore: 2000, notAfter: 1000 })),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_RANGE");
  });
});

describe("404", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe("config validation", () => {
  it("refuses to start without SIGNER_API_KEY or SIGNER_CLIENT_CA", async () => {
    const { loadConfig } = await import("../daemon/src/config.js");
    expect(() =>
      loadConfig({ SIGNER_PRIVATE_KEY_HEX: "0x" + "01".repeat(32) } as NodeJS.ProcessEnv),
    ).toThrow(/Refusing to start/);
  });

  it("refuses to start without a key", async () => {
    const { loadConfig } = await import("../daemon/src/config.js");
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/SIGNER_PRIVATE_KEY_HEX is required/);
  });

  it("requires both TLS cert and key together", async () => {
    const { loadConfig } = await import("../daemon/src/config.js");
    expect(() =>
      loadConfig({
        SIGNER_PRIVATE_KEY_HEX: "0x" + "01".repeat(32),
        SIGNER_API_KEY: "k",
        SIGNER_TLS_CERT: "/etc/cert",
      } as NodeJS.ProcessEnv),
    ).toThrow(/SIGNER_TLS_CERT and SIGNER_TLS_KEY/);
  });
});
