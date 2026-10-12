/**
 * PxeBridgeClient transport guards: the bearer token must not be sent over
 * cleartext to a remote host, and a bridge that never answers must not hang
 * the caller.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PxeBridgeClient } from "../src/pxe-bridge-client.js";

describe("PxeBridgeClient URL policy", () => {
  it.each(["http://pxe.example.com/rpc", "http://10.0.0.5:8080", "ftp://127.0.0.1/"])(
    "rejects %s",
    (url) => {
      expect(() => new PxeBridgeClient(url, "secret")).toThrow("pxe-bridge URL must be https");
    },
  );

  it.each([
    "https://pxe.example.com/rpc",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://[::1]:8080",
  ])("accepts %s", (url) => {
    expect(new PxeBridgeClient(url, "secret")).toBeInstanceOf(PxeBridgeClient);
  });

  it.each([0, -1, 1.5, NaN])("rejects timeoutMs %s", (timeoutMs) => {
    expect(() => new PxeBridgeClient("https://pxe.example.com", undefined, { timeoutMs })).toThrow(
      "timeoutMs must be a positive integer",
    );
  });
});

describe("PxeBridgeClient over a loopback bridge", () => {
  const held: ServerResponse[] = [];
  const seenAuth: Array<string | undefined> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenAuth.push(req.headers.authorization);
    if (req.url === "/hang") {
      // Never answer: the client timeout is the only way out.
      held.push(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pxe-bridge/1.2.3" }));
  });

  let base = "";
  const ready = new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      resolve();
    });
  });

  afterAll(async () => {
    for (const res of held) res.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("sends the bearer token and returns the result", async () => {
    await ready;
    const client = new PxeBridgeClient(`${base}/rpc`, "secret");
    await expect(client.getVersion()).resolves.toBe("pxe-bridge/1.2.3");
    expect(seenAuth.at(-1)).toBe("Bearer secret");
  });

  it("aborts a request the bridge never answers", async () => {
    await ready;
    const client = new PxeBridgeClient(`${base}/hang`, undefined, { timeoutMs: 200 });
    await expect(client.getVersion()).rejects.toThrow(/timeout|aborted/i);
  });
});
