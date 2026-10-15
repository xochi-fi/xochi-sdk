/**
 * Daemon server tests -- starts the HTTP daemon on a random port, hits it
 * with fetch requests, asserts auth, route scoping, signing policy, the
 * idempotent signing ledger, and audit semantics.
 *
 * The TLS handshake itself is not exercised (it would need a CA + certs); the
 * mTLS scope rules are covered through `scopesFor`, and the bearer path covers
 * all of the request handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Barretenberg } from "@aztec/bb.js";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  RawPrivateKeyLoader,
  loadLocalSigner,
  MemoryReplayDb,
  type DestroyableDigestSigner,
  type DigestSigner,
} from "../src/index.js";
import {
  BoundedSerialQueue,
  createDaemonServer,
  scopesFor,
  type DaemonServer,
} from "../daemon/src/server.js";
import { FileAuditSink, MemoryAuditSink, type AuditSink } from "../daemon/src/audit.js";
import { loadConfig, type DaemonConfig } from "../daemon/src/config.js";
import { signingPolicy } from "../daemon/src/handlers.js";

const TEST_PRIVATE_KEY = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_PRIVATE_KEY[i] = i + 1; // 0x01..0x20
const TEST_API_KEY = "test-bearer-key-do-not-ship";
const CREDENTIAL_ROOT_KEY = "test-credential-root-key-do-not-ship";

/** Fixed clock (unix seconds) for the signing policy and the ledger. */
const NOW = 1_750_000_000;
const CHAIN_ID = 31337;
const ORACLE = "0x1234567890123456789012345678901234567890";
const PROVIDER_ID = 42;

function testConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    host: "127.0.0.1",
    port: 0, // ephemeral
    signerKeyHex: "0x" + Buffer.from(TEST_PRIVATE_KEY).toString("hex"),
    apiKey: TEST_API_KEY,
    credentialRootApiKey: CREDENTIAL_ROOT_KEY,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    clientCaPath: undefined,
    signalsClientCns: undefined,
    credentialRootClientCns: undefined,
    auditLogPath: undefined,
    providerLabel: "test",
    chainId: BigInt(CHAIN_ID),
    oracleAddress: ORACLE,
    providerId: BigInt(PROVIDER_ID),
    maxTimestampAgeSeconds: 300,
    maxTimestampSkewSeconds: 30,
    credentialRootMaxValiditySeconds: 3600,
    allowInsecureBind: false,
    ...overrides,
  };
}

describe("BoundedSerialQueue", () => {
  it("serializes work and rejects requests beyond its bound", async () => {
    const queue = new BoundedSerialQueue(2);
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const operation = async (gate?: Promise<void>): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (gate) {
        markFirstEntered();
        await gate;
      }
      active -= 1;
    };

    const first = queue.run(() => operation(firstGate));
    await firstEntered;
    const second = queue.run(() => operation());
    await expect(queue.run(() => operation())).rejects.toThrow(/queue is full/);
    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
  });

  it("continues after an operation rejects", async () => {
    const queue = new BoundedSerialQueue(1);
    await expect(
      queue.run(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});

let api: Barretenberg;
let signer: DestroyableDigestSigner;
let replayDb: MemoryReplayDb;
let audit: MemoryAuditSink;
let server: DaemonServer;
let baseUrl: string;

async function startServer(
  auditSink: AuditSink,
  config: DaemonConfig = testConfig(),
  signerOverride: DigestSigner = signer,
): Promise<{ server: DaemonServer; url: string }> {
  const s = createDaemonServer(
    {
      api,
      signer: signerOverride,
      replayDb: new MemoryReplayDb({ now: () => NOW }),
      audit: auditSink,
    },
    config,
    signingPolicy(config, () => NOW),
  );
  const { host, port } = await s.listen();
  return { server: s, url: `http://${host}:${String(port)}` };
}

beforeAll(async () => {
  api = await Barretenberg.new();
  signer = await loadLocalSigner(new RawPrivateKeyLoader(TEST_PRIVATE_KEY, "daemon-test"));
  replayDb = new MemoryReplayDb({ now: () => NOW });
  audit = new MemoryAuditSink();
  const config = testConfig();
  server = createDaemonServer(
    { api, signer, replayDb, audit },
    config,
    signingPolicy(config, () => NOW),
  );
  const { host, port } = await server.listen();
  baseUrl = `http://${host}:${String(port)}`;
}, 60_000);

afterAll(async () => {
  await server.close();
  signer.destroy();
  await api.destroy();
});

const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";
const SUBMITTER = "0x000000000000000000000000000000000000dEaD";

const SAMPLE_BODY = {
  proofType: 7, // COMPLIANCE_SIGNED
  // Audit F-6: chain_id + oracle_address bind the signed digest to a
  // specific deployment. Both must match the daemon's pins.
  chainId: CHAIN_ID,
  oracleAddress: ORACLE,
  providerSetHash: PROVIDER_SET_HASH,
  signals: [25, 0, 0, 0, 0, 0, 0, 0],
  weights: [100, 0, 0, 0, 0, 0, 0, 0],
  timestamp: String(NOW),
  submitter: SUBMITTER,
};

function authHeaders(key: string = TEST_API_KEY): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

function post(path: string, body: unknown, key: string = TEST_API_KEY): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify(body),
  });
}

async function expectRejected(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { code: string; signature?: string };
  expect(body.code).toBe(code);
  expect(body.signature).toBeUndefined();
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
    const res = await post("/sign", SAMPLE_BODY, "wrong");
    expect(res.status).toBe(401);
  });

  it("rejects /pubkey-hash without bearer token", async () => {
    const res = await fetch(`${baseUrl}/pubkey-hash`);
    expect(res.status).toBe(401);
  });
});

describe("route scoping", () => {
  it("refuses the credential-root key on /sign and /sign-multi", async () => {
    await expectRejected(
      await post("/sign", SAMPLE_BODY, CREDENTIAL_ROOT_KEY),
      403,
      "ROUTE_NOT_PERMITTED",
    );
    await expectRejected(
      await post("/sign-multi", SAMPLE_BODY, CREDENTIAL_ROOT_KEY),
      403,
      "ROUTE_NOT_PERMITTED",
    );
  });

  it("refuses the signal key on /sign-credential-root", async () => {
    await expectRejected(
      await post("/sign-credential-root", {}, TEST_API_KEY),
      403,
      "ROUTE_NOT_PERMITTED",
    );
  });

  it("serves /pubkey-hash to either credential", async () => {
    for (const key of [TEST_API_KEY, CREDENTIAL_ROOT_KEY]) {
      const res = await fetch(`${baseUrl}/pubkey-hash`, { headers: authHeaders(key) });
      expect(res.status).toBe(200);
    }
  });

  it("disables /sign-credential-root when no credential-root credential is configured", async () => {
    const { server: s, url } = await startServer(
      new MemoryAuditSink(),
      testConfig({ credentialRootApiKey: undefined }),
    );
    try {
      const res = await fetch(`${url}/sign-credential-root`, {
        method: "POST",
        headers: authHeaders(TEST_API_KEY),
        body: "{}",
      });
      await expectRejected(res, 403, "ROUTE_NOT_PERMITTED");
    } finally {
      await s.close();
    }
  });

  describe("scopesFor (mTLS)", () => {
    const mtls = testConfig({
      apiKey: undefined,
      credentialRootApiKey: undefined,
      clientCaPath: "/unused/ca.pem",
      credentialRootClientCns: ["publisher"],
    });

    it("gives a credential-root CN only the credential-root scope", () => {
      expect(scopesFor({ kind: "mtls", commonName: "publisher" }, mtls)).toEqual([
        "credentialRoot",
      ]);
    });

    it("gives any other verified cert only the signal scope", () => {
      expect(scopesFor({ kind: "mtls", commonName: "orchestrator" }, mtls)).toEqual(["signals"]);
      expect(scopesFor({ kind: "mtls", commonName: undefined }, mtls)).toEqual(["signals"]);
    });

    it("restricts the signal scope to the allowlist when one is set", () => {
      const allow = { ...mtls, signalsClientCns: ["orchestrator"] };
      expect(scopesFor({ kind: "mtls", commonName: "orchestrator" }, allow)).toEqual(["signals"]);
      expect(scopesFor({ kind: "mtls", commonName: "someone-else" }, allow)).toEqual([]);
      expect(scopesFor({ kind: "mtls", commonName: undefined }, allow)).toEqual([]);
    });
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
    expect(body.pubkeyX).toBe("0x" + Buffer.from(signer.publicKeyX).toString("hex"));
    expect(body.pubkeyY).toBe("0x" + Buffer.from(signer.publicKeyY).toString("hex"));
  });

  it("uses one validated identity snapshot for hash and coordinates", async () => {
    const expectedX = signer.publicKeyX;
    let xReads = 0;
    const mutableSigner: DigestSigner = {
      label: "mutable-registration",
      get publicKeyX() {
        xReads += 1;
        return xReads === 1 ? expectedX : new Uint8Array(32);
      },
      publicKeyY: signer.publicKeyY,
      async signDigest() {
        throw new Error("unused");
      },
    };
    const { server: s, url } = await startServer(
      new MemoryAuditSink(),
      testConfig(),
      mutableSigner,
    );
    try {
      const res = await fetch(`${url}/pubkey-hash`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pubkeyX: string };
      expect(body.pubkeyX).toBe(`0x${Buffer.from(expectedX).toString("hex")}`);
      expect(xReads).toBe(1);
    } finally {
      await s.close();
    }
  });

  it("returns a generic internal error for a malformed identity", async () => {
    const malformed: DigestSigner = {
      label: "filesystem/or/backend/detail",
      publicKeyX: new Uint8Array(32),
      publicKeyY: new Uint8Array(32),
      async signDigest() {
        throw new Error("unused");
      },
    };
    const { server: s, url } = await startServer(new MemoryAuditSink(), testConfig(), malformed);
    try {
      const res = await fetch(`${url}/pubkey-hash`, { headers: authHeaders() });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error", code: "INTERNAL" });
    } finally {
      await s.close();
    }
  });
});

describe("POST /sign", () => {
  it("returns a signature that ECDSA-verifies", async () => {
    replayDb.reset();
    const res = await post("/sign", SAMPLE_BODY);
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

  it("signs RISK_SCORE_SIGNED under its own domain", async () => {
    replayDb.reset();
    const compliance = (await (await post("/sign", SAMPLE_BODY)).json()) as { payloadHash: string };
    const res = await post("/sign", { ...SAMPLE_BODY, proofType: "0x08" });
    expect(res.status).toBe(200);
    const risk = (await res.json()) as { payloadHash: string };
    expect(risk.payloadHash).not.toBe(compliance.payloadHash);
  });

  it("rejects malformed body with 400", async () => {
    await expectRejected(
      await post("/sign", { providerSetHash: PROVIDER_SET_HASH }),
      400,
      "BAD_REQUEST",
    );
  });

  it("rejects invalid JSON with 400", async () => {
    audit.events.length = 0;
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      route: "/sign",
      outcome: "rejected",
      source: "bearer:signals",
    });
  });

  it("answers an identical retry with the identical signature", async () => {
    replayDb.reset();
    audit.events.length = 0;
    const first = await post("/sign", SAMPLE_BODY);
    expect(first.status).toBe(200);
    const retry = await post("/sign", SAMPLE_BODY);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(audit.events.map((e) => e.outcome)).toEqual(["signed", "replayed"]);
  });

  it("audits each accepted sign before answering", async () => {
    replayDb.reset();
    audit.events.length = 0;
    const res = await post("/sign", SAMPLE_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payloadHash: string; signerPubkeyHash: string };
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      route: "/sign",
      outcome: "signed",
      source: "bearer:signals",
      payloadHash: body.payloadHash,
      signerPubkeyHash: body.signerPubkeyHash,
      submitter: SUBMITTER.toLowerCase(),
    });
  });

  it("rejects oversized body with 413", async () => {
    audit.events.length = 0;
    const huge = "x".repeat(64 * 1024); // > 32 KB limit
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      headers: authHeaders(),
      body: huge,
    });
    expect(res.status).toBe(413);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      route: "/sign",
      outcome: "rejected",
      source: "bearer:signals",
    });
  });

  describe("signing policy", () => {
    it("refuses a chainId other than the pinned one", async () => {
      await expectRejected(
        await post("/sign", { ...SAMPLE_BODY, chainId: 1 }),
        403,
        "CHAIN_MISMATCH",
      );
    });

    it("refuses an oracleAddress other than the pinned one (case-insensitive match)", async () => {
      await expectRejected(
        await post("/sign", { ...SAMPLE_BODY, oracleAddress: "0x" + "99".repeat(20) }),
        403,
        "ORACLE_MISMATCH",
      );
      const upper = await post("/sign", { ...SAMPLE_BODY, oracleAddress: ORACLE.toUpperCase() });
      expect(upper.status).toBe(400); // "0X..." prefix is not an address
      const mixed = await post("/sign", {
        ...SAMPLE_BODY,
        oracleAddress: "0x" + ORACLE.slice(2).toUpperCase(),
      });
      expect(mixed.status).toBe(200);
    });

    it("refuses timestamps outside [now - maxAge, now + skew]", async () => {
      for (const timestamp of [NOW - 301, NOW + 31, 1_700_000_000]) {
        await expectRejected(
          await post("/sign", { ...SAMPLE_BODY, timestamp }),
          403,
          "TIMESTAMP_OUT_OF_WINDOW",
        );
      }
      for (const timestamp of [NOW - 300, NOW + 30]) {
        const res = await post("/sign", { ...SAMPLE_BODY, timestamp });
        expect(res.status, `timestamp ${String(timestamp)}`).toBe(200);
      }
    });

    it("audits refusals with the reason", async () => {
      audit.events.length = 0;
      await post("/sign", { ...SAMPLE_BODY, chainId: 1 });
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({ route: "/sign", outcome: "rejected" });
      expect(audit.events[0].reason).toMatch(/chainId 1 is not the pinned chain 31337/);
    });
  });

  describe("range checks", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["signal above 100", { signals: [101, 0, 0, 0, 0, 0, 0, 0] }],
      ["fractional signal", { signals: [25.5, 0, 0, 0, 0, 0, 0, 0] }],
      ["weight above u32", { weights: [2 ** 32, 0, 0, 0, 0, 0, 0, 0] }],
      ["negative weight", { weights: [-1, 0, 0, 0, 0, 0, 0, 0] }],
      [
        "no positive weight",
        { weights: [0, 0, 0, 0, 0, 0, 0, 0], signals: [0, 0, 0, 0, 0, 0, 0, 0] },
      ],
      ["signal on an inactive slot", { signals: [25, 7, 0, 0, 0, 0, 0, 0] }],
      ["non-contiguous active slots", { weights: [100, 0, 50, 0, 0, 0, 0, 0] }],
      ["zero submitter", { submitter: "0x" + "00".repeat(20) }],
      ["short submitter", { submitter: "0xdead" }],
      ["short oracleAddress", { oracleAddress: "0xabcd1234" }],
      ["missing proofType", { proofType: undefined }],
      ["proofType without a signed-signals domain", { proofType: 9 }],
    ];
    it.each(cases)("rejects %s with 400", async (_label, patch) => {
      await expectRejected(await post("/sign", { ...SAMPLE_BODY, ...patch }), 400, "BAD_REQUEST");
    });
  });
});

describe("POST /sign-credential-root", () => {
  const ROOT = "0x" + "ab".repeat(32);

  function credentialRootBody(
    overrides?: Partial<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      providerId: PROVIDER_ID,
      root: ROOT,
      cid: "ipfs://Qm-test",
      notBefore: NOW - 60,
      notAfter: NOW + 3600,
      ...overrides,
    };
  }

  function postRoot(body: unknown): Promise<Response> {
    return post("/sign-credential-root", body, CREDENTIAL_ROOT_KEY);
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
    const res = await postRoot(credentialRootBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signature: string; digest: string; signer: string };
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/); // 65 bytes
    expect(body.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.signer).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("signature recovers to the daemon's signer address", async () => {
    const res = await postRoot(credentialRootBody());
    const body = (await res.json()) as { signature: string; digest: string; signer: string };
    const sigBytes = Buffer.from(body.signature.slice(2), "hex");
    const digestBytes = Buffer.from(body.digest.slice(2), "hex");
    // Reconstruct uncompressed pubkey for noble; verify the signature.
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(signer.publicKeyX, 1);
    uncompressed.set(signer.publicKeyY, 33);
    expect(secp256k1.verify(sigBytes.subarray(0, 64), digestBytes, uncompressed)).toBe(true);
  });

  it("audits the root, cid and window it signed", async () => {
    audit.events.length = 0;
    const res = await postRoot(credentialRootBody());
    const body = (await res.json()) as { digest: string; signer: string };
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      route: "/sign-credential-root",
      outcome: "signed",
      source: "bearer:credential-root",
      payloadHash: body.digest,
      signer: body.signer,
      credentialRoot: {
        chainId: String(CHAIN_ID),
        oracleAddress: ORACLE,
        providerId: String(PROVIDER_ID),
        root: ROOT,
        cid: "ipfs://Qm-test",
        notBefore: String(NOW - 60),
        notAfter: String(NOW + 3600),
      },
    });
  });

  it("rejects malformed body", async () => {
    await expectRejected(await postRoot({ providerId: 42 }), 400, "BAD_REQUEST");
  });

  it("rejects inverted window", async () => {
    await expectRejected(
      await postRoot(credentialRootBody({ notBefore: NOW + 100, notAfter: NOW + 50 })),
      400,
      "BAD_RANGE",
    );
  });

  it("rejects a window that has already closed", async () => {
    await expectRejected(
      await postRoot(credentialRootBody({ notBefore: NOW - 100, notAfter: NOW })),
      403,
      "WINDOW_EXPIRED",
    );
  });

  it("rejects a window longer than the maximum validity", async () => {
    await expectRejected(
      await postRoot(credentialRootBody({ notAfter: NOW + 3601 })),
      403,
      "VALIDITY_TOO_LONG",
    );
  });

  it("rejects values that do not fit uint64", async () => {
    await expectRejected(
      await postRoot(credentialRootBody({ notBefore: "18446744073709551616" })),
      400,
      "BAD_REQUEST",
    );
  });

  it("refuses a chain, Oracle or provider other than the pinned ones", async () => {
    await expectRejected(await postRoot(credentialRootBody({ chainId: 1 })), 403, "CHAIN_MISMATCH");
    await expectRejected(
      await postRoot(credentialRootBody({ oracleAddress: "0x" + "99".repeat(20) })),
      403,
      "ORACLE_MISMATCH",
    );
    await expectRejected(
      await postRoot(credentialRootBody({ providerId: 43 })),
      403,
      "PROVIDER_MISMATCH",
    );
  });
});

describe("POST /sign-multi", () => {
  const SAMPLE_MULTI_BODY = {
    slotIndex: 0,
    chainId: CHAIN_ID,
    oracleAddress: ORACLE,
    jurisdictionId: 0, // EU
    providerSetHash: PROVIDER_SET_HASH,
    configHash: "0xbeef",
    signals: [25, 0, 0, 0, 0, 0, 0, 0],
    weights: [100, 0, 0, 0, 0, 0, 0, 0],
    timestamp: String(NOW),
    submitter: SUBMITTER,
  };

  it("returns a signature that ECDSA-verifies against the slot payload digest", async () => {
    replayDb.reset();
    const res = await post("/sign-multi", SAMPLE_MULTI_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signature: string;
      pubkeyX: string;
      pubkeyY: string;
      payloadHash: string;
    };

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
    await expectRejected(await post("/sign-multi", { slotIndex: 0 }), 400, "BAD_REQUEST");
  });

  it("rejects slotIndex out of range with 400", async () => {
    await expectRejected(
      await post("/sign-multi", { ...SAMPLE_MULTI_BODY, slotIndex: 5 }),
      400,
      "BAD_REQUEST",
    );
  });

  it("refuses an Oracle other than the pinned one", async () => {
    await expectRejected(
      await post("/sign-multi", { ...SAMPLE_MULTI_BODY, oracleAddress: "0x" + "99".repeat(20) }),
      403,
      "ORACLE_MISMATCH",
    );
  });

  it("rejects without bearer", async () => {
    const res = await fetch(`${baseUrl}/sign-multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_MULTI_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("answers an identical retry with the identical signature", async () => {
    replayDb.reset();
    audit.events.length = 0;
    const first = await post("/sign-multi", SAMPLE_MULTI_BODY);
    expect(first.status).toBe(200);
    const retry = await post("/sign-multi", SAMPLE_MULTI_BODY);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(audit.events.map((e) => e.outcome)).toEqual(["signed", "replayed"]);
  });
});

describe("signing failure redaction", () => {
  const sensitiveLabel = "kms://sensitive-provider-key";
  const sensitiveMessage = "custody backend slot 8675309 is unavailable";

  it("redacts custody details from every signing route while preserving the audit reason", async () => {
    const rejectingSigner: DigestSigner = {
      publicKeyX: signer.publicKeyX.slice(),
      publicKeyY: signer.publicKeyY.slice(),
      label: sensitiveLabel,
      signDigest: async () => {
        throw new Error(sensitiveMessage);
      },
    };
    const privateAudit = new MemoryAuditSink();
    const { server: rejectingServer, url } = await startServer(
      privateAudit,
      testConfig(),
      rejectingSigner,
    );
    const requests = [
      { route: "/sign", body: SAMPLE_BODY, key: TEST_API_KEY },
      {
        route: "/sign-multi",
        body: {
          slotIndex: 0,
          chainId: CHAIN_ID,
          oracleAddress: ORACLE,
          jurisdictionId: 0,
          providerSetHash: PROVIDER_SET_HASH,
          configHash: "0xbeef",
          signals: [25, 0, 0, 0, 0, 0, 0, 0],
          weights: [100, 0, 0, 0, 0, 0, 0, 0],
          timestamp: String(NOW),
          submitter: SUBMITTER,
        },
        key: TEST_API_KEY,
      },
      {
        route: "/sign-credential-root",
        body: {
          chainId: CHAIN_ID,
          oracleAddress: ORACLE,
          providerId: PROVIDER_ID,
          root: "0x" + "ab".repeat(32),
          cid: "ipfs://Qm-test",
          notBefore: NOW - 60,
          notAfter: NOW + 3600,
        },
        key: CREDENTIAL_ROOT_KEY,
      },
    ] as const;

    try {
      for (const request of requests) {
        const response = await fetch(`${url}${request.route}`, {
          method: "POST",
          headers: authHeaders(request.key),
          body: JSON.stringify(request.body),
        });
        expect(response.status).toBe(500);
        const responseBody = await response.json();
        expect(responseBody).toEqual({ error: "signing failed", code: "SIGN_FAILED" });
        const serializedBody = JSON.stringify(responseBody);
        expect(serializedBody).not.toContain(sensitiveLabel);
        expect(serializedBody).not.toContain(sensitiveMessage);
      }

      expect(privateAudit.events).toHaveLength(3);
      expect(privateAudit.events.map((event) => event.route)).toEqual(
        requests.map((request) => request.route),
      );
      for (const event of privateAudit.events) {
        expect(event).toMatchObject({ outcome: "rejected" });
        expect(event.reason).toContain(sensitiveLabel);
        expect(event.reason).toContain(sensitiveMessage);
      }
    } finally {
      await rejectingServer.close();
    }
  });

  it.each([null, "custody string rejection", { backend: "private-topology" }])(
    "handles a hostile thrown value without changing the public response",
    async (thrown) => {
      const rejectingSigner: DigestSigner = {
        publicKeyX: signer.publicKeyX,
        publicKeyY: signer.publicKeyY,
        label: "private-label",
        async signDigest() {
          throw thrown;
        },
      };
      const privateAudit = new MemoryAuditSink();
      const { server: s, url } = await startServer(privateAudit, testConfig(), rejectingSigner);
      try {
        const response = await fetch(`${url}/sign-credential-root`, {
          method: "POST",
          headers: authHeaders(CREDENTIAL_ROOT_KEY),
          body: JSON.stringify({
            chainId: CHAIN_ID,
            oracleAddress: ORACLE,
            providerId: PROVIDER_ID,
            root: "0x" + "ab".repeat(32),
            cid: "ipfs://Qm-test",
            notBefore: NOW - 60,
            notAfter: NOW + 3600,
          }),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "signing failed", code: "SIGN_FAILED" });
        expect(privateAudit.events).toHaveLength(1);
        expect(privateAudit.events[0].reason).toBeTypeOf("string");
      } finally {
        await s.close();
      }
    },
  );
});

describe("404", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe("audit log", () => {
  const scratch = mkdtempSync(join(tmpdir(), "xochi-daemon-audit-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("has the record on disk by the time the signature is returned", async () => {
    const path = join(scratch, "audit.jsonl");
    const sink = new FileAuditSink(path);
    const { server: s, url } = await startServer(sink);
    try {
      const res = await fetch(`${url}/sign`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(SAMPLE_BODY),
      });
      expect(res.status).toBe(200);
      const { payloadHash } = (await res.json()) as { payloadHash: string };
      const lines = readFileSync(path, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ outcome: "signed", payloadHash });
    } finally {
      await s.close();
      await sink.close();
    }
  });

  it("withholds the signature and stays up when the log cannot be written", async () => {
    // A path under a missing directory: the stream errors asynchronously.
    // Unhandled, that 'error' event would crash the process.
    const sink = new FileAuditSink(join(scratch, "missing-dir", "audit.jsonl"));
    const { server: s, url } = await startServer(sink);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${url}/sign`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(SAMPLE_BODY),
        });
        await expectRejected(res, 500, "AUDIT_FAILED");
      }
      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe("config validation", () => {
  const BASE_ENV = {
    SIGNER_PRIVATE_KEY_HEX: "0x" + "01".repeat(32),
    SIGNER_API_KEY: "k",
    SIGNER_CHAIN_ID: String(CHAIN_ID),
    SIGNER_ORACLE_ADDRESS: ORACLE,
  };

  function load(env: Record<string, string | undefined>): DaemonConfig {
    return loadConfig(env as NodeJS.ProcessEnv);
  }

  it("accepts the minimal bearer configuration and applies defaults", () => {
    const config = load(BASE_ENV);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      chainId: BigInt(CHAIN_ID),
      oracleAddress: ORACLE,
      providerId: undefined,
      credentialRootApiKey: undefined,
      maxTimestampAgeSeconds: 300,
      maxTimestampSkewSeconds: 30,
      credentialRootMaxValiditySeconds: 3600,
      allowInsecureBind: false,
    });
  });

  it("refuses to start without SIGNER_API_KEY or SIGNER_CLIENT_CA", () => {
    expect(() => load({ ...BASE_ENV, SIGNER_API_KEY: undefined })).toThrow(/Refusing to start/);
  });

  it("refuses to start without a key", () => {
    expect(() => load({})).toThrow(/SIGNER_PRIVATE_KEY_HEX is required/);
  });

  it("requires both TLS cert and key together", () => {
    expect(() => load({ ...BASE_ENV, SIGNER_TLS_CERT: "/etc/cert" })).toThrow(
      /SIGNER_TLS_CERT and SIGNER_TLS_KEY/,
    );
  });

  it("requires the pinned chain ID and Oracle address", () => {
    expect(() => load({ ...BASE_ENV, SIGNER_CHAIN_ID: undefined })).toThrow(/SIGNER_CHAIN_ID/);
    expect(() => load({ ...BASE_ENV, SIGNER_CHAIN_ID: "0x1" })).toThrow(/SIGNER_CHAIN_ID/);
    expect(() => load({ ...BASE_ENV, SIGNER_ORACLE_ADDRESS: undefined })).toThrow(
      /SIGNER_ORACLE_ADDRESS/,
    );
    expect(() => load({ ...BASE_ENV, SIGNER_ORACLE_ADDRESS: "0xabcd1234" })).toThrow(
      /SIGNER_ORACLE_ADDRESS/,
    );
  });

  it("refuses a non-loopback plain-HTTP bind unless explicitly overridden", () => {
    expect(() => load({ ...BASE_ENV, SIGNER_HTTP_HOST: "0.0.0.0" })).toThrow(
      /Refusing to bind non-loopback host 0.0.0.0/,
    );
    expect(
      load({ ...BASE_ENV, SIGNER_HTTP_HOST: "0.0.0.0", SIGNER_ALLOW_INSECURE_BIND: "1" }).host,
    ).toBe("0.0.0.0");
    expect(
      load({
        ...BASE_ENV,
        SIGNER_HTTP_HOST: "0.0.0.0",
        SIGNER_TLS_CERT: "/etc/cert",
        SIGNER_TLS_KEY: "/etc/key",
      }).host,
    ).toBe("0.0.0.0");
    expect(load({ ...BASE_ENV, SIGNER_HTTP_HOST: "::1" }).host).toBe("::1");
  });

  it("enforces the bind rule on hand-built configs too", () => {
    expect(() =>
      createDaemonServer({ api, signer, replayDb, audit }, testConfig({ host: "0.0.0.0" })),
    ).toThrow(/Refusing to bind/);
  });

  it("keeps the credential-root credential separate", () => {
    expect(() => load({ ...BASE_ENV, SIGNER_CREDENTIAL_ROOT_API_KEY: "k" })).toThrow(
      /must differ from SIGNER_API_KEY/,
    );
    expect(
      load({ ...BASE_ENV, SIGNER_CREDENTIAL_ROOT_API_KEY: "other" }).credentialRootApiKey,
    ).toBe("other");
  });

  it("rejects mTLS scope settings that would be ignored or ambiguous", () => {
    const mtls = {
      ...BASE_ENV,
      SIGNER_API_KEY: undefined,
      SIGNER_TLS_CERT: "/etc/cert",
      SIGNER_TLS_KEY: "/etc/key",
      SIGNER_CLIENT_CA: "/etc/ca",
    };
    expect(() => load({ ...mtls, SIGNER_CREDENTIAL_ROOT_API_KEY: "x" })).toThrow(
      /ignored under mTLS/,
    );
    expect(() => load({ ...BASE_ENV, SIGNER_CREDENTIAL_ROOT_CLIENT_CNS: "publisher" })).toThrow(
      /require SIGNER_CLIENT_CA/,
    );
    expect(() =>
      load({
        ...mtls,
        SIGNER_SIGNALS_CLIENT_CNS: "a,publisher",
        SIGNER_CREDENTIAL_ROOT_CLIENT_CNS: "publisher",
      }),
    ).toThrow(/both signal and credential-root scopes; got publisher/);
    expect(load({ ...mtls, SIGNER_CREDENTIAL_ROOT_CLIENT_CNS: "pub1, pub2" })).toMatchObject({
      credentialRootClientCns: ["pub1", "pub2"],
    });
  });

  it("parses the provider pin and freshness overrides", () => {
    const config = load({
      ...BASE_ENV,
      SIGNER_PROVIDER_ID: "7",
      SIGNER_MAX_TIMESTAMP_AGE_SECONDS: "60",
      SIGNER_MAX_TIMESTAMP_SKEW_SECONDS: "5",
      SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS: "900",
    });
    expect(config).toMatchObject({
      providerId: 7n,
      maxTimestampAgeSeconds: 60,
      maxTimestampSkewSeconds: 5,
      credentialRootMaxValiditySeconds: 900,
    });
    expect(() => load({ ...BASE_ENV, SIGNER_MAX_TIMESTAMP_AGE_SECONDS: "-1" })).toThrow(
      /SIGNER_MAX_TIMESTAMP_AGE_SECONDS/,
    );
  });
});
