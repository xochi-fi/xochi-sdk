// An in-process EVM JSON-RPC endpoint for driving OnchainEscrowGateway with
// real ethers providers and wallets and no network: `_send` answers every
// request from contract stubs this file holds. Calls are decoded and encoded
// through the same ABIs the gateway uses, so a selector or a return shape the
// gateway gets wrong fails here as it would against a node.
//
// Deterministic and timer-free: `send` answers each request directly instead
// of through ethers' batch-drain timer, and a mined transaction lands in
// `head + 1` at once, so a test may run under fake timers and nothing waits on
// the wall clock. A transaction the node is told to `pend` sits in its mempool
// until `mine(hash)`, and a later one at the same nonce must outbid it.
//
// ethers' request cache is OFF by default here (`cacheTimeout: -1`); pass
// `{ cacheTimeout: 250 }` (ethers' own default) to drive the gateway the way a
// consumer's default provider does, where an identical read inside 250ms is
// answered from the cache.

import { ethers } from "ethers";

// Thrown by a stub to make an `eth_call` revert with a decoded custom error.
export class Revert extends Error {
  constructor(
    readonly errorName: string,
    readonly args: unknown[] = [],
  ) {
    super(`revert ${errorName}`);
  }
}

type Impl = (args: ethers.Result, from: string | undefined) => unknown;
interface Stub {
  iface: ethers.Interface;
  impl: Record<string, Impl>;
}

// How the node answers `eth_sendRawTransaction`. `reject` is an RPC error
// message the node returns (ethers maps "insufficient funds", "nonce too low",
// ... to its codes; anything else is ambiguous); `mine` lands it at once with
// that receipt status; `pend` accepts it into the mempool without mining it.
export type SendBehavior = { reject: string } | { mine: 1 | 0 } | { pend: true };

export interface SentTx {
  hash: string;
  from: string;
  to: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint | null; // null on a legacy transaction
  gasPrice: bigint | null;
  method: string | null; // decoded against the stubbed contract at `to`
  args: ethers.Result | null;
}

interface StoredLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
}

export class FakeChain extends ethers.JsonRpcProvider {
  head = 1_000;
  timestamp = 1_900_000_000;
  safe: number | null = 1_000;
  // Every transaction the node accepted (mined or pending).
  readonly sent: SentTx[] = [];
  // Every raw transaction the node was handed, accepted or refused.
  readonly attempts: SentTx[] = [];
  readonly methods: string[] = [];
  // Native balances in wei; an address not set holds 1 ether.
  readonly balances = new Map<string, bigint>();
  // While set, `eth_getTransactionReceipt` answers null for every hash: a
  // load-balanced RPC whose receipt backend trails its state backend.
  hideReceipts = false;
  // `eth_getTransactionCount` answers this many below the truth: a
  // load-balanced RPC whose state backend has not yet seen the latest blocks.
  nonceLag = 0;
  // While set, `eth_getTransactionByHash` answers null for every hash: a
  // load-balanced RPC whose lookup backend lacks what its peer's pool holds.
  hideTransactions = false;
  // Every block's base fee (and `eth_gasPrice`), in wei: ethers prices a
  // send at 2 x this + `tip`.
  baseFee = 1n;
  // What `eth_maxPriorityFeePerGas` answers, in wei.
  tip = 1n;
  // What `eth_estimateGas` answers (Arbitrum's for a plain transfer is ~22.7k).
  gasEstimate = 200_000n;
  // While set, every `eth_sendRawTransaction` first waits for it: a broadcast
  // held in flight, so a test can act while a send sits inside the gateway's queue.
  holdSends: Promise<void> | null = null;
  // Called once per send, before it is applied; default mines with status 1.
  onSend: (tx: SentTx) => SendBehavior = () => ({ mine: 1 });
  // Called when a mined transaction succeeds, so a stub's state can follow it.
  onMined: (tx: SentTx) => void = () => {};

  private readonly stubs = new Map<string, Stub>();
  private readonly receipts = new Map<
    string,
    { blockNumber: number; status: number; from: string; to: string }
  >();
  private readonly nonces = new Map<string, number>();
  private readonly mempool = new Map<string, SentTx>(); // by `${from}:${nonce}`
  private readonly raws = new Map<string, string>(); // every accepted transaction's raw bytes, by hash
  private readonly logs: StoredLog[] = [];
  private nextId = 1;

  constructor(
    readonly chainId: number,
    opts: { cacheTimeout?: number } = {},
  ) {
    super("http://fake.invalid", new ethers.Network(`fake-${chainId}`, chainId), {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: opts.cacheTimeout ?? -1,
    });
  }

  stub(address: string, abi: ethers.InterfaceAbi, impl: Record<string, Impl>): void {
    const iface = abi instanceof ethers.Interface ? abi : new ethers.Interface(abi);
    const existing = this.stubs.get(address.toLowerCase());
    if (existing) Object.assign(existing.impl, impl);
    else this.stubs.set(address.toLowerCase(), { iface, impl: { ...impl } });
  }

  nonceOf(address: string): number {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }

  // Consume a nonce without a receipt this chain will ever report for the
  // given hash: the in-doubt transaction was replaced or dropped and another
  // one from the same sender landed in its slot.
  consumeNonce(address: string): void {
    this.nonces.set(address.toLowerCase(), this.nonceOf(address) + 1);
    this.mempool.delete(`${address.toLowerCase()}:${this.nonceOf(address) - 1}`);
  }

  // Mine a pending transaction (it must be next in its sender's nonce order).
  mine(hash: string, status: 1 | 0 = 1): void {
    const tx = [...this.mempool.values()].find((t) => t.hash === hash);
    if (!tx) throw new Error(`fake chain ${this.chainId}: ${hash} is not pending`);
    if (tx.nonce !== this.nonceOf(tx.from))
      throw new Error(`fake chain ${this.chainId}: ${hash} is not next for ${tx.from}`);
    this.mempool.delete(slotOf(tx));
    this.land(tx, status);
  }

  // Mine a transaction this node accepted and then let a same-nonce
  // replacement push out of its pool: another node held the first signing and
  // a block included it. It must be next in its sender's nonce order; whatever
  // now occupies its slot here is dropped.
  mineReplaced(hash: string): void {
    const tx = this.sent.find((t) => t.hash === hash);
    if (!tx) throw new Error(`fake chain ${this.chainId}: ${hash} was never accepted`);
    if (tx.nonce !== this.nonceOf(tx.from))
      throw new Error(`fake chain ${this.chainId}: ${hash} is not next for ${tx.from}`);
    this.mempool.delete(slotOf(tx));
    this.land(tx, 1);
  }

  pending(): SentTx[] {
    return [...this.mempool.values()];
  }

  // Drop pending transactions from the mempool without mining them (all, or
  // the one hash): pool eviction, a node restart, a load-balanced backend that
  // took the broadcast and never propagated it. The node no longer knows them.
  evict(hash?: string): void {
    for (const [slot, tx] of this.mempool)
      if (hash === undefined || tx.hash === hash) this.mempool.delete(slot);
  }

  // Record an event in the current head block, as a mined transaction would.
  logEvent(
    address: string,
    iface: ethers.Interface,
    event: string,
    args: unknown[],
    transactionHash: string,
  ): void {
    const { topics, data } = iface.encodeEventLog(event, args);
    this.logs.push({ address, topics, data, blockNumber: this.head, transactionHash });
  }

  // Answer directly, without ethers' batch-drain timer (see the header).
  override async send(
    method: string,
    params: unknown[] | Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "eth_sendRawTransaction" && this.holdSends) await this.holdSends;
    const payload = { method, params, id: this.nextId++, jsonrpc: "2.0" } as ethers.JsonRpcPayload;
    const [result] = await this._send(payload);
    if (result && "error" in result) throw this.getRpcError(payload, result as ethers.JsonRpcError);
    return (result as ethers.JsonRpcResult).result;
  }

  override async _send(
    payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[],
  ): Promise<ethers.JsonRpcResult[]> {
    const requests = Array.isArray(payload) ? payload : [payload];
    return requests.map((req) => {
      this.methods.push(req.method);
      try {
        return { id: req.id, result: this.handle(req.method, req.params as unknown[]) };
      } catch (err) {
        if (err instanceof RpcError)
          return { id: req.id, error: { code: err.code, message: err.message, data: err.data } };
        throw err;
      }
    }) as ethers.JsonRpcResult[];
  }

  private handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return ethers.toQuantity(this.chainId);
      case "eth_blockNumber":
        return ethers.toQuantity(this.head);
      case "eth_getBlockByNumber":
        return this.blockJson(params[0] as string);
      case "eth_gasPrice":
        return ethers.toQuantity(this.baseFee);
      case "eth_maxPriorityFeePerGas":
        return ethers.toQuantity(this.tip);
      case "eth_getBalance":
        return ethers.toQuantity(
          this.balances.get((params[0] as string).toLowerCase()) ?? ethers.WeiPerEther,
        );
      case "eth_estimateGas":
        return ethers.toQuantity(this.gasEstimate);
      case "eth_getTransactionCount":
        return ethers.toQuantity(
          Math.max(
            0,
            (params[1] === "pending"
              ? this.pendingNonceOf(params[0] as string)
              : this.nonceOf(params[0] as string)) - this.nonceLag,
          ),
        );
      case "eth_getCode":
        return this.stubs.has((params[0] as string).toLowerCase()) ? "0x01" : "0x";
      case "eth_call":
        return this.ethCall(params[0] as { to: string; data: string; from?: string });
      case "eth_getLogs":
        return this.logsJson(
          params[0] as {
            address?: string;
            topics?: (string | null)[];
            fromBlock?: string;
            toBlock?: string;
          },
        );
      case "eth_sendRawTransaction":
        return this.sendRaw(params[0] as string);
      case "eth_getTransactionReceipt":
        return this.receiptJson(params[0] as string);
      case "eth_getTransactionByHash":
        return this.hideTransactions ? null : this.txJson(params[0] as string);
      default:
        throw new Error(`fake chain ${this.chainId}: unhandled ${method}`);
    }
  }

  // The next nonce counting this sender's consecutive pending transactions.
  private pendingNonceOf(address: string): number {
    let n = this.nonceOf(address);
    while (this.mempool.has(`${address.toLowerCase()}:${n}`)) n += 1;
    return n;
  }

  private blockJson(tag: string): unknown {
    let n: number | null;
    if (tag === "latest" || tag === "pending") n = this.head;
    else if (tag === "safe" || tag === "finalized") n = this.safe;
    else n = Number(tag);
    if (n === null || n > this.head) return null;
    return {
      hash: ethers.zeroPadValue(ethers.toBeHex(n + 1), 32),
      parentHash: ethers.zeroPadValue(ethers.toBeHex(n), 32),
      number: ethers.toQuantity(n),
      timestamp: ethers.toQuantity(this.timestamp - (this.head - n) * 2),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: ethers.ZeroAddress,
      extraData: "0x",
      baseFeePerGas: ethers.toQuantity(this.baseFee),
      transactions: [],
    };
  }

  private ethCall(tx: { to: string; data: string; from?: string }): string {
    const stub = this.stubs.get(tx.to.toLowerCase());
    if (!stub) throw new Error(`fake chain ${this.chainId}: eth_call to unstubbed ${tx.to}`);
    const parsed = stub.iface.parseTransaction({ data: tx.data });
    if (!parsed)
      throw new Error(
        `fake chain ${this.chainId}: unknown selector ${tx.data.slice(0, 10)} on ${tx.to}`,
      );
    const impl = stub.impl[parsed.name];
    if (!impl)
      throw new Error(`fake chain ${this.chainId}: ${parsed.name} not stubbed on ${tx.to}`);
    let out: unknown;
    try {
      out = impl(parsed.args, tx.from);
    } catch (err) {
      if (err instanceof Revert) {
        throw new RpcError(
          3,
          "execution reverted",
          stub.iface.encodeErrorResult(err.errorName, err.args),
        );
      }
      throw err;
    }
    const outputs = parsed.fragment.outputs;
    if (outputs.length === 0) return "0x";
    return stub.iface.encodeFunctionResult(
      parsed.fragment,
      outputs.length === 1 ? [out] : (out as unknown[]),
    );
  }

  private logsJson(filter: {
    address?: string;
    topics?: (string | null)[];
    fromBlock?: string;
    toBlock?: string;
  }): unknown[] {
    const from = filter.fromBlock === undefined ? 0 : Number(filter.fromBlock);
    const to =
      filter.toBlock === undefined || filter.toBlock === "latest"
        ? this.head
        : Number(filter.toBlock);
    return this.logs
      .filter(
        (l) =>
          (!filter.address || l.address.toLowerCase() === filter.address.toLowerCase()) &&
          l.blockNumber >= from &&
          l.blockNumber <= to &&
          (filter.topics ?? []).every(
            (t, i) => t === null || t.toLowerCase() === l.topics[i]?.toLowerCase(),
          ),
      )
      .map((l, i) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: ethers.toQuantity(l.blockNumber),
        blockHash: ethers.zeroPadValue(ethers.toBeHex(l.blockNumber + 1), 32),
        transactionHash: l.transactionHash,
        transactionIndex: "0x0",
        logIndex: ethers.toQuantity(i),
        removed: false,
      }));
  }

  private sendRaw(raw: string): string {
    const parsed = ethers.Transaction.from(raw);
    const stub = parsed.to ? this.stubs.get(parsed.to.toLowerCase()) : undefined;
    const decoded = stub?.iface.parseTransaction({ data: parsed.data }) ?? null;
    const tx: SentTx = {
      hash: parsed.hash!,
      from: parsed.from!,
      to: parsed.to!,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit,
      maxFeePerGas: parsed.maxFeePerGas,
      gasPrice: parsed.type === 2 ? null : parsed.gasPrice,
      method: decoded?.name ?? null,
      args: decoded?.args ?? null,
    };
    this.attempts.push(tx);
    const behavior = this.onSend(tx);
    if ("reject" in behavior) throw new RpcError(-32000, behavior.reject);
    if (tx.nonce < this.nonceOf(tx.from))
      throw new RpcError(-32000, `nonce too low: next nonce ${this.nonceOf(tx.from)}`);
    const occupant = this.mempool.get(slotOf(tx));
    if (occupant?.hash === tx.hash) throw new RpcError(-32000, "already known");
    // geth's rule: a replacement must offer at least 10% more.
    if (occupant && feeOf(tx) * 10n < feeOf(occupant) * 11n)
      throw new RpcError(-32000, "replacement transaction underpriced");
    this.sent.push(tx);
    this.raws.set(tx.hash, raw);
    if ("mine" in behavior && tx.nonce === this.nonceOf(tx.from)) {
      this.mempool.delete(slotOf(tx));
      this.land(tx, behavior.mine);
    } else {
      this.mempool.set(slotOf(tx), tx);
    }
    return tx.hash;
  }

  private land(tx: SentTx, status: 1 | 0): void {
    this.head += 1;
    this.nonces.set(tx.from.toLowerCase(), this.nonceOf(tx.from) + 1);
    this.receipts.set(tx.hash, { blockNumber: this.head, status, from: tx.from, to: tx.to });
    if (status === 1) this.onMined(tx);
  }

  private receiptJson(hash: string): unknown {
    const r = this.hideReceipts ? undefined : this.receipts.get(hash);
    if (!r) return null;
    return {
      transactionHash: hash,
      blockHash: ethers.zeroPadValue(ethers.toBeHex(r.blockNumber + 1), 32),
      blockNumber: ethers.toQuantity(r.blockNumber),
      transactionIndex: "0x0",
      from: r.from,
      to: r.to,
      contractAddress: null,
      gasUsed: "0x5208",
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      logs: [],
      logsBloom: "0x" + "00".repeat(256),
      status: ethers.toQuantity(r.status),
      type: "0x2",
    };
  }

  // A transaction the node holds pending or has mined; null for one it does not know.
  private txJson(hash: string): unknown {
    const receipt = this.receipts.get(hash);
    const pending = [...this.mempool.values()].some((t) => t.hash === hash);
    const raw = this.raws.get(hash);
    if (!raw || (!receipt && !pending)) return null;
    const tx = ethers.Transaction.from(raw);
    return {
      hash,
      blockHash: receipt ? ethers.zeroPadValue(ethers.toBeHex(receipt.blockNumber + 1), 32) : null,
      blockNumber: receipt ? ethers.toQuantity(receipt.blockNumber) : null,
      transactionIndex: receipt ? "0x0" : null,
      from: tx.from,
      to: tx.to,
      nonce: ethers.toQuantity(tx.nonce),
      gas: ethers.toQuantity(tx.gasLimit),
      value: ethers.toQuantity(tx.value),
      input: tx.data,
      chainId: ethers.toQuantity(tx.chainId),
      type: ethers.toQuantity(tx.type ?? 0),
      ...(tx.maxFeePerGas !== null
        ? {
            maxFeePerGas: ethers.toQuantity(tx.maxFeePerGas),
            maxPriorityFeePerGas: ethers.toQuantity(tx.maxPriorityFeePerGas ?? 0n),
          }
        : { gasPrice: ethers.toQuantity(tx.gasPrice ?? 0n) }),
      r: tx.signature!.r,
      s: tx.signature!.s,
      v: ethers.toQuantity(tx.signature!.v),
      yParity: ethers.toQuantity(tx.signature!.yParity),
    };
  }
}

function slotOf(tx: SentTx): string {
  return `${tx.from.toLowerCase()}:${tx.nonce}`;
}

function feeOf(tx: SentTx): bigint {
  return tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: string,
  ) {
    super(message);
  }
}
