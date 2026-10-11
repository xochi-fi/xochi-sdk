/**
 * PxeBridgeClient -- JSON-RPC 2.0 client for the pxe-bridge server.
 *
 * Provides typed methods for creating Aztec L2 notes from L1 settlement context.
 */

/**
 * Parameters for creating an Aztec L2 note from L1 settlement context.
 *
 * The fields tradeId, subTradeIndex, and totalSubTrades form an all-or-nothing
 * group: either all three must be provided (for sub-trade notes within a split
 * settlement) or all three must be omitted (for standalone notes). The
 * pxe-bridge server enforces this constraint at runtime.
 */
export interface CreateNoteParams {
  recipient: string;
  token: string;
  amount: string;
  chainId: number;
  tradeId?: string;
  subTradeIndex?: number;
  totalSubTrades?: number;
}

export interface CreateNoteResult {
  noteCommitment: string;
  nullifierHash: string;
  l2TxHash: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface PxeBridgeClientOptions {
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * The bearer token and the note parameters (recipient, amount) must not cross
 * the network in cleartext, so the URL must be https. Plain http is accepted
 * only for a loopback bridge (local development, same-host sidecar).
 */
function parseBridgeUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed;
  throw new Error(
    `pxe-bridge URL must be https (plain http is allowed only for loopback hosts); got ${url}`,
  );
}

export class PxeBridgeClient {
  private nextId = 1;
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(
    url: string,
    private apiKey?: string,
    options: PxeBridgeClientOptions = {},
  ) {
    this.url = parseBridgeUrl(url);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive integer; got ${String(timeoutMs)}`);
    }
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`pxe-bridge HTTP error: ${String(response.status)} ${response.statusText}`);
    }

    const body = (await response.json()) as JsonRpcResponse<T>;

    if (body.error) {
      throw new Error(`pxe-bridge RPC error ${String(body.error.code)}: ${body.error.message}`);
    }

    if (body.result === undefined) {
      throw new Error("pxe-bridge RPC response missing result");
    }

    return body.result;
  }

  async createNote(params: CreateNoteParams): Promise<CreateNoteResult> {
    return this.call<CreateNoteResult>("pxe_createNote", params);
  }

  async getVersion(): Promise<string> {
    return this.call<string>("pxe_getVersion", {});
  }
}
