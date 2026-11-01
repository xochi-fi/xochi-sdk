/**
 * The frame side, `connectToHost`, driven in a scripted window: the frame's
 * `parent` records every `postMessage` as its JSON text and `targetOrigin`, and
 * the host's messages are delivered straight to the frame's listener with the
 * origin and source a browser would stamp on them.
 *
 * `frame.wire.json` was recorded from the widget app's own frame bridge
 * (xochi-widget `src/lib/hostBridge.ts` at 9b80e8d) under this same script, so
 * replaying it proves `connectToHost` puts the same bytes on the wire, to the
 * same origins, and settles the same requests the same way.
 */

import { describe, expect, it } from "vitest";
import {
  HostRpcError,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PENDING_RPC,
  RPC_ERROR,
  TRADE_REF_PATTERN,
  connectToHost,
  mintTradeRef,
  type HostConnection,
  type XochiWidgetEvent,
} from "./index.js";
import wire from "./frame.wire.json";

const HOST = "https://host.example";
const TRADE_REF = `tr_${"a".repeat(32)}`;

interface Posted {
  targetOrigin: string;
  message: string;
}

/** A frame window whose parent records what the frame posts. */
class ScriptedFrame {
  posted: Posted[] = [];
  readonly parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      this.posted.push({ targetOrigin, message: JSON.stringify(message) });
    },
  };
  /** Another window: a sibling frame, a popup. */
  readonly stranger = {};
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly window = {
    parent: this.parent,
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") this.listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") this.listeners.delete(listener);
    },
  } as unknown as Window;

  /** A message arriving at the frame, `from` the parent unless said otherwise. */
  receive(data: unknown, origin = HOST, source: object = this.parent): void {
    const event = { data, origin, source } as unknown as MessageEvent;
    for (const listener of [...this.listeners]) listener(event);
  }

  take(): Posted[] {
    return this.posted.splice(0);
  }
}

function connect(options: { hostOrigin?: string } = {}) {
  const frame = new ScriptedFrame();
  const connection = connectToHost({ window: frame.window, ...options });
  if (connection === null) throw new Error("connectToHost returned null in a framed window");
  return { frame, connection };
}

/** Attach the host's wallet: the host's answer to `xochi:ready`. */
function attach(frame: ScriptedFrame, autoConnect = false): void {
  frame.receive({ type: "xochi:provider", available: true, autoConnect });
}

function describeError(e: unknown): unknown {
  const err = e as { name?: unknown; code?: unknown; message?: unknown; data?: unknown };
  return {
    error: e instanceof Error,
    name: err.name,
    code: err.code,
    message: err.message,
    ...(e !== null && typeof e === "object" && "data" in e ? { data: err.data } : {}),
  };
}

/**
 * The settled outcome of a request, once the frame has resolved or rejected
 * it. The frame settles synchronously while handling a message, so the
 * callbacks are queued before this await resumes.
 */
async function outcome(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    (value) => ({ value }),
    (e: unknown) => ({ reason: describeError(e) }),
  );
}

type Step = (typeof wire)[number];

describe("the wire", () => {
  it("matches what the widget's own frame bridge sends, byte for byte", async () => {
    const frame = new ScriptedFrame();
    let connection: HostConnection | null = null;
    let observed: unknown[] = [];
    for (const step of wire as Step[]) {
      const s = step as Step & Record<string, unknown>;
      switch (s.do) {
        case "connect":
          connection = connectToHost({ window: frame.window });
          for (const name of ["accountsChanged", "chainChanged", "disconnect"]) {
            connection!.provider.on(name, (arg) =>
              observed.push({
                providerEvent: name,
                arg: name === "disconnect" ? describeError(arg) : arg,
              }),
            );
          }
          connection!.onAvailability((available) => observed.push({ availability: available }));
          break;
        case "resize":
          connection!.resize(s.height as number);
          break;
        case "emit":
          connection!.emit(s.event as XochiWidgetEvent);
          break;
        case "request": {
          const args =
            "params" in s
              ? { method: s.method as string, params: s.params as unknown[] }
              : { method: s.method as string };
          const label = s.label;
          connection!.provider.request(args).then(
            (value) => observed.push({ settled: label, value }),
            (e: unknown) => observed.push({ settled: label, reason: describeError(e) }),
          );
          break;
        }
        case "host":
          frame.receive(
            s.data,
            (s.origin as string | undefined) ?? HOST,
            s.source === "stranger" ? frame.stranger : frame.parent,
          );
          break;
        case "destroy":
          connection!.destroy();
          break;
      }
      // Requests settle synchronously within the step; their callbacks were
      // queued before this continuation.
      await Promise.resolve();
      expect({ step: s, posted: frame.take(), observed }).toEqual({
        step: s,
        posted: s.expect.posted,
        observed: s.expect.observed,
      });
      expect(connection!.available()).toBe(s.expect.available);
      expect(connection!.autoConnect()).toBe(s.expect.autoConnect);
      observed = [];
    }
  });
});

describe("connectToHost", () => {
  it("is null in a window nobody framed", () => {
    expect(connectToHost({ window })).toBeNull();
    const top = { parent: undefined } as unknown as Window;
    expect(connectToHost({ window: top })).toBeNull();
  });

  it("refuses a hostOrigin that is not a secure origin", () => {
    const frame = new ScriptedFrame();
    for (const hostOrigin of ["http://host.example", "https://host.example/path", "nope"]) {
      expect(() => connectToHost({ window: frame.window, hostOrigin })).toThrow(TypeError);
    }
    expect(frame.posted).toEqual([]);
  });

  it("with hostOrigin, says ready to that origin only and lets nothing else pin", () => {
    const { frame, connection } = connect({ hostOrigin: `${HOST}/` });
    expect(frame.take()).toEqual([{ targetOrigin: HOST, message: '{"type":"xochi:ready"}' }]);
    frame.receive({ type: "xochi:provider", available: true }, "https://evil.example");
    expect(connection.available()).toBe(false);
    connection.resize(500);
    attach(frame);
    expect(connection.available()).toBe(true);
    expect(frame.take()).toEqual([
      { targetOrigin: HOST, message: '{"type":"xochi:resize","height":500}' },
    ]);
  });

  it("never pins an opaque origin, which no targetOrigin can name", () => {
    const { frame, connection } = connect();
    frame.receive({ type: "xochi:provider", available: true }, "null");
    expect(connection.available()).toBe(false);
    attach(frame);
    expect(connection.available()).toBe(true);
  });

  it("drops an oversized host message, but still answers the request it was for", async () => {
    const { frame, connection } = connect();
    frame.receive({ type: "xochi:provider", available: true, pad: "x".repeat(MAX_MESSAGE_LENGTH) });
    expect(connection.available()).toBe(false);
    attach(frame);
    const request = connection.provider.request({ method: "eth_chainId" });
    frame.receive({ type: "xochi:rpc:result", id: 1, result: "x".repeat(MAX_MESSAGE_LENGTH) });
    expect(await outcome(request)).toEqual({
      reason: {
        error: true,
        name: "ProviderRpcError",
        code: RPC_ERROR.internal,
        message: `The wallet's answer is not JSON or exceeds ${MAX_MESSAGE_LENGTH} characters`,
      },
    });
  });

  it("caps the host's error message and refuses a code that is not a safe integer", async () => {
    const { frame, connection } = connect();
    attach(frame);
    const long = connection.provider.request({ method: "eth_chainId" });
    const unsafe = connection.provider.request({ method: "eth_chainId" });
    frame.receive({
      type: "xochi:rpc:result",
      id: 1,
      error: { code: 4001, message: "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 10) },
    });
    frame.receive({ type: "xochi:rpc:result", id: 2, error: { code: 2 ** 60, message: "big" } });
    const capped = (await outcome(long)) as { reason: { message: string } };
    expect(capped.reason.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(capped.reason.message.endsWith("…")).toBe(true);
    expect(await outcome(unsafe)).toMatchObject({ reason: { code: RPC_ERROR.internal } });
  });
});

describe("the frame's own refusals", () => {
  it("refuses a method off the allowlist with 4200, without asking the host", async () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    for (const method of ["wallet_requestPermissions", "eth_sign", "x".repeat(100)]) {
      const error = await connection.provider.request({ method }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostRpcError);
      expect(error).toMatchObject({
        code: RPC_ERROR.unsupportedMethod,
        message: `Unsupported method: ${method.length <= 64 ? method : `${method.slice(0, 63)}…`}`,
      });
    }
    expect(frame.take()).toEqual([]);
  });

  it("refuses params that are neither an array nor an object with -32602", async () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    await expect(
      connection.provider.request({ method: "eth_chainId", params: "0x1" as never }),
    ).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: "params must be an array or an object",
    });
    expect(frame.take()).toEqual([]);
  });

  it("refuses an oversized request with -32600 and keeps its id unspent", async () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    await expect(
      connection.provider.request({
        method: "personal_sign",
        params: ["x".repeat(MAX_MESSAGE_LENGTH), "0x0"],
      }),
    ).rejects.toMatchObject({
      code: RPC_ERROR.invalidRequest,
      message: `Request is not JSON or exceeds ${MAX_MESSAGE_LENGTH} characters`,
    });
    void connection.provider.request({ method: "eth_chainId" });
    expect(frame.take()).toEqual([
      { targetOrigin: HOST, message: '{"type":"xochi:rpc","id":1,"method":"eth_chainId"}' },
    ]);
  });

  it(`holds at most ${MAX_PENDING_RPC} requests in flight, refusing more with -32005`, async () => {
    const { frame, connection } = connect();
    attach(frame);
    const inFlight = Array.from({ length: MAX_PENDING_RPC }, () =>
      connection.provider.request({ method: "eth_chainId" }),
    );
    await expect(connection.provider.request({ method: "eth_chainId" })).rejects.toMatchObject({
      code: RPC_ERROR.limitExceeded,
      message: `More than ${MAX_PENDING_RPC} wallet requests in flight`,
    });
    frame.receive({ type: "xochi:rpc:result", id: 1, result: "0x1" });
    await expect(inFlight[0]).resolves.toBe("0x1");
    void connection.provider.request({ method: "eth_chainId" });
    expect(frame.take().at(-1)).toEqual({
      targetOrigin: HOST,
      message: `{"type":"xochi:rpc","id":${MAX_PENDING_RPC + 1},"method":"eth_chainId"}`,
    });
  });

  it("posts the request as plain JSON", () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    void connection.provider.request({
      method: "eth_sendTransaction",
      params: [{ to: "0x0", value: undefined, data: "0x" }],
    });
    expect(frame.take()).toEqual([
      {
        targetOrigin: HOST,
        message:
          '{"type":"xochi:rpc","id":1,"method":"eth_sendTransaction","params":[{"to":"0x0","data":"0x"}]}',
      },
    ]);
  });

  it("refuses everything once destroyed, and posts nothing more", async () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    connection.destroy();
    connection.destroy();
    await expect(connection.provider.request({ method: "eth_chainId" })).rejects.toMatchObject({
      code: RPC_ERROR.disconnected,
      message: "the frame closed the bridge",
    });
    connection.resize(300);
    connection.emit({ name: "trade:completed", tradeRef: TRADE_REF });
    expect(frame.take()).toEqual([]);
  });
});

describe("trade events", () => {
  it("throws for an event the host would drop", () => {
    const { connection } = connect();
    expect(() => connection.emit({ name: "trade:submitted", tradeRef: "xi_1" })).toThrow(TypeError);
    expect(() => connection.emit({ name: "trade:started", tradeRef: TRADE_REF } as never)).toThrow(
      TypeError,
    );
    expect(() =>
      connection.emit({ name: "trade:failed", tradeRef: TRADE_REF, error: 5 } as never),
    ).toThrow(TypeError);
  });

  it("cuts a long failure reason to the cap, which the host would otherwise drop", () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    connection.emit({
      name: "trade:failed",
      tradeRef: TRADE_REF,
      error: "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 500),
    });
    const [posted] = frame.take();
    const error = `${"x".repeat(MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
    expect(posted).toEqual({
      targetOrigin: HOST,
      message: JSON.stringify({
        type: "xochi:event",
        event: { name: "trade:failed", tradeRef: TRADE_REF, error },
      }),
    });
  });

  it("sends only the event's own fields", () => {
    const { frame, connection } = connect();
    attach(frame);
    frame.take();
    connection.emit({ name: "trade:completed", tradeRef: TRADE_REF, intentId: "xi_1" } as never);
    expect(frame.take()).toEqual([
      {
        targetOrigin: HOST,
        message: `{"type":"xochi:event","event":{"name":"trade:completed","tradeRef":"${TRADE_REF}"}}`,
      },
    ]);
  });

  it("queues at most 32 events before the handshake", () => {
    const { frame, connection } = connect();
    frame.take();
    for (let i = 0; i < 40; i++) connection.emit({ name: "trade:submitted", tradeRef: TRADE_REF });
    attach(frame);
    expect(frame.take()).toHaveLength(32);
  });

  it("mints a fresh reference in TRADE_REF_PATTERN every call", () => {
    const refs = new Set(Array.from({ length: 64 }, mintTradeRef));
    expect(refs.size).toBe(64);
    for (const ref of refs) expect(ref).toMatch(TRADE_REF_PATTERN);
  });
});

describe("onAutoConnect", () => {
  it("is off until the host says so, and off for anything but a literal true", () => {
    const { frame, connection } = connect();
    expect(connection.autoConnect()).toBe(false);
    frame.receive({ type: "xochi:provider", available: true, autoConnect: "true" });
    expect(connection.autoConnect()).toBe(false);
    // An older host that sends no `autoConnect` at all gets the default.
    frame.receive({ type: "xochi:provider", available: true });
    expect(connection.autoConnect()).toBe(false);
    attach(frame, true);
    expect(connection.autoConnect()).toBe(true);
  });

  it("is read before availability listeners run", () => {
    const { frame, connection } = connect();
    const seen: [boolean, boolean][] = [];
    connection.onAvailability((available) => seen.push([available, connection.autoConnect()]));
    attach(frame, true);
    expect(seen).toEqual([[true, true]]);
  });

  it("never connects in the default mode", () => {
    const { frame, connection } = connect();
    let connects = 0;
    connection.onAutoConnect(() => connects++);
    attach(frame);
    frame.receive({ type: "xochi:provider", available: false, autoConnect: false });
    attach(frame);
    expect(connects).toBe(0);
  });

  it("connects once when an opted-in host attaches its wallet, and again only on a re-attach", () => {
    const { frame, connection } = connect();
    let connects = 0;
    connection.onAutoConnect(() => connects++);
    expect(connects).toBe(0);
    attach(frame, true);
    expect(connects).toBe(1);
    // The host re-sends provider state (a provider swap): still the same
    // attachment, so a user who disconnected in the frame stays disconnected.
    attach(frame, true);
    expect(connects).toBe(1);
    frame.receive({ type: "xochi:provider", available: false, autoConnect: true });
    attach(frame, true);
    expect(connects).toBe(2);
  });

  it("connects at once when the opted-in host wallet is already attached", () => {
    const { frame, connection } = connect();
    attach(frame, true);
    let connects = 0;
    connection.onAutoConnect(() => connects++);
    expect(connects).toBe(1);
  });

  it("stops on unsubscribe", () => {
    const { frame, connection } = connect();
    let connects = 0;
    const stop = connection.onAutoConnect(() => connects++);
    stop();
    attach(frame, true);
    expect(connects).toBe(0);
  });
});
