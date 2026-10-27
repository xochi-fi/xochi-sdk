/**
 * A real local JSON-RPC endpoint whose `latest` block is scripted, standing in
 * for an RPC whose head is not the local clock: a load-balanced node whose
 * `latest` steps back, or a chain warped ahead. Only `eth_getBlockByNumber`
 * is served; anything else answers a JSON-RPC error. With `pending` set, a
 * `"pending"` request gets that timestamp instead, like an OP-stack RPC whose
 * pending context lags `latest`.
 */

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, http, toHex, type PublicClient } from "viem";

export interface ScriptedBlockRpc {
  client: PublicClient;
  url: string;
  /** Block tags requested so far, in order. */
  tags: () => string[];
  /** Number of `eth_getBlockByNumber` requests served so far. */
  reads: () => number;
  close: () => Promise<void>;
}

/** Serve `timestamps[i]` as the latest block's timestamp on the i-th read; the last repeats. */
export async function startScriptedBlockRpc(
  timestamps: readonly bigint[],
  options: { pending?: bigint } = {},
): Promise<ScriptedBlockRpc> {
  if (timestamps.length === 0) throw new Error("startScriptedBlockRpc: no timestamps scripted");
  let reads = 0;
  const tags: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params?: unknown[];
      };
      res.setHeader("Content-Type", "application/json");
      if (method !== "eth_getBlockByNumber") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: method } }));
        return;
      }
      const tag = String(params?.[0]);
      tags.push(tag);
      const timestamp =
        tag === "pending" && options.pending !== undefined
          ? options.pending
          : timestamps[Math.min(reads, timestamps.length - 1)];
      reads += 1;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            number: toHex(reads),
            hash: toHex(reads, { size: 32 }),
            timestamp: toHex(timestamp),
            transactions: [],
          },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  return {
    client: createPublicClient({ transport: http(url, { retryCount: 0 }) }),
    url,
    tags: () => [...tags],
    reads: () => reads,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
