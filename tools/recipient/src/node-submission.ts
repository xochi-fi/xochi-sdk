import type { AztecNode } from "@aztec-labs/aztec.js/node";
import type { JsonRpcFetch } from "@aztec-labs/foundation/json-rpc/client";
import { jsonStringify } from "@aztec-labs/foundation/json-rpc";
import { NoRetryError } from "@aztec-labs/foundation/retry";
import type { TxHash } from "@aztec-labs/stdlib/tx";

type BeforeSubmit = (txHash: TxHash) => void | Promise<void>;
/**
 * The SDK's default JSON-RPC transport retries requests whose response may have been lost. Writes
 * must instead make exactly one HTTP attempt: after `beforeSubmit` is durable, any transport error
 * is ambiguous and the journal deliberately blocks a resend.
 */
export const singleAttemptJsonRpcFetch: JsonRpcFetch = async (host, body, extraHeaders = {}) => {
  let response: Response;
  try {
    response = await fetch(host, {
      method: "POST",
      body: jsonStringify(body),
      headers: { "content-type": "application/json", ...extraHeaders },
      redirect: "error",
    });
  } catch {
    throw new NoRetryError(
      "Aztec node submission failed after the HTTP request may have been written",
    );
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new NoRetryError("Aztec node submission response ended before its outcome could be read");
  }
  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new NoRetryError(
      response.ok
        ? "Aztec node submission returned an invalid JSON response"
        : `Aztec node submission returned HTTP ${response.status}`,
    );
  }

  if (!response.ok) {
    throw new NoRetryError(`Aztec node submission returned HTTP ${response.status}`);
  }
  return { response: responseJson, headers: response.headers };
};

export function createSingleAttemptAztecNodeBroadcaster(url: string): Pick<AztecNode, "sendTx"> {
  return {
    async sendTx(tx) {
      const { response } = await singleAttemptJsonRpcFetch(url, [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "aztec_sendTx",
          params: [tx],
        },
      ]);
      if (
        !Array.isArray(response) ||
        response.length !== 1 ||
        typeof response[0] !== "object" ||
        response[0] === null ||
        response[0].id !== 1 ||
        response[0].jsonrpc !== "2.0" ||
        "error" in response[0] ||
        !("result" in response[0])
      ) {
        throw new NoRetryError("Aztec node submission returned an invalid JSON-RPC outcome");
      }
    },
  };
}

/**
 * Wraps the real Aztec node's `sendTx` boundary. The Aztec 6 wallet computes the transaction hash
 * only after proving, immediately before this call; `BatchCall.send` exposes no hook at that point.
 * An armed callback therefore persists the hash before the wrapped node can receive the transaction.
 */
export class NodeSubmission {
  readonly node: AztecNode;
  private armed: { beforeSubmit: BeforeSubmit; submitted: boolean } | null = null;
  private readonly boundMethods = new WeakMap<Function, Function>();
  constructor(
    private readonly target: AztecNode,
    private readonly broadcaster: Pick<AztecNode, "sendTx"> = target,
  ) {
    this.node = new Proxy(target, {
      get: (node, property) => {
        if (property === "sendTx") return this.sendTx;
        const value: unknown = Reflect.get(node, property, node);
        if (typeof value !== "function") return value;
        const cached = this.boundMethods.get(value);
        if (cached) return cached;
        const bound = value.bind(node);
        this.boundMethods.set(value, bound);
        return bound;
      },
    });
  }

  async run<T>(beforeSubmit: BeforeSubmit, operation: () => Promise<T>): Promise<T> {
    if (this.armed) throw new Error("an Aztec node submission hook is already armed");
    const armed = { beforeSubmit, submitted: false };
    this.armed = armed;
    try {
      const result = await operation();
      if (!armed.submitted) {
        throw new Error("recipient operation completed without an Aztec node submission");
      }
      return result;
    } catch {
      throw new Error(
        armed.submitted
          ? "Aztec transaction submission or receipt outcome requires journal reconciliation"
          : "recipient operation failed before Aztec node submission",
      );
    } finally {
      this.armed = null;
    }
  }

  private readonly sendTx = async (tx: Parameters<AztecNode["sendTx"]>[0]): Promise<void> => {
    const armed = this.armed;
    if (!armed) {
      await this.target.sendTx(tx);
      return;
    }
    if (armed.submitted) {
      throw new Error("an operation attempted more than one Aztec node submission");
    }
    const txHash = tx.getTxHash();
    await armed.beforeSubmit(txHash);
    armed.submitted = true;
    await this.broadcaster.sendTx(tx);
  };
}
