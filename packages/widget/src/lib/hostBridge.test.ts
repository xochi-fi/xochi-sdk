// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { MESSAGE, WIDGET_PROTOCOL_VERSION } from "@xochi/widget-lib";
import { hostBridge, startHostBridge } from "./hostBridge.js";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  document.body.replaceChildren();
});

it("unmount revokes pending host requests and releases bridge ownership", async () => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frame = iframe.contentWindow!;
  stop = startHostBridge({ window: frame, hostOrigin: window.location.origin });
  frame.dispatchEvent(
    new MessageEvent("message", {
      source: frame.parent,
      origin: window.location.origin,
      data: {
        type: MESSAGE.provider,
        protocolVersion: WIDGET_PROTOCOL_VERSION,
        handshakeId: 1,
        available: true,
        autoConnect: false,
        walletUi: "widget",
      },
    }),
  );
  const bridge = hostBridge!;
  expect(bridge.available()).toBe(true);
  expect(() => startHostBridge({ window: frame })).toThrow(/already mounted/);
  const revoked = expect(bridge.provider.request({ method: "eth_accounts" })).rejects.toMatchObject(
    { code: 4900 },
  );
  const previousStop = stop;
  stop();
  await revoked;
  expect(hostBridge).toBeNull();
  stop = startHostBridge({ window: frame });
  previousStop();
  expect(hostBridge?.available()).toBe(false);
  expect(() => startHostBridge({ window: frame })).toThrow(/already mounted/);
});

it("standalone mounting owns the lifecycle without creating a host wallet", () => {
  stop = startHostBridge({ window });
  expect(hostBridge).toBeNull();
  expect(() => startHostBridge({ window })).toThrow(/already mounted/);
});
