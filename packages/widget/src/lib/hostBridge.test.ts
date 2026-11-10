// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { MESSAGE, WIDGET_PROTOCOL_VERSION } from "@xochi/widget-lib";
import { hostBridge, startHostBridge, type HostBridgeLease } from "./hostBridge.js";

let lease: HostBridgeLease | undefined;
afterEach(() => {
  lease?.stop();
  lease = undefined;
  document.body.replaceChildren();
});

it("unmount revokes pending host requests and releases bridge ownership", async () => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const frame = iframe.contentWindow!;
  lease = startHostBridge({ window: frame, hostOrigin: window.location.origin });
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
  const bridge = lease.bridge!;
  expect(hostBridge).toBe(bridge);
  expect(lease.active).toBe(true);
  expect(bridge.available()).toBe(true);
  expect(() => startHostBridge({ window: frame })).toThrow(/already mounted/);
  const revoked = expect(bridge.provider.request({ method: "eth_accounts" })).rejects.toMatchObject(
    { code: 4900 },
  );
  const previousLease = lease;
  lease.stop();
  await revoked;
  expect(previousLease.active).toBe(false);
  expect(previousLease.bridge).toBe(bridge);
  expect(hostBridge).toBeNull();
  lease = startHostBridge({ window: frame });
  previousLease.stop();
  expect(lease).not.toBe(previousLease);
  expect(lease.bridge).not.toBe(bridge);
  expect(lease.active).toBe(true);
  expect(hostBridge).toBe(lease.bridge);
  expect(lease.bridge?.available()).toBe(false);
  expect(() => startHostBridge({ window: frame })).toThrow(/already mounted/);
});

it("standalone mounting owns the lifecycle without creating a host wallet", () => {
  lease = startHostBridge({ window });
  expect(lease.bridge).toBeNull();
  expect(lease.active).toBe(true);
  expect(hostBridge).toBeNull();
  expect(() => startHostBridge({ window })).toThrow(/already mounted/);

  const previousLease = lease;
  lease.stop();
  expect(previousLease.active).toBe(false);
  lease = startHostBridge({ window });
  previousLease.stop();
  expect(lease).not.toBe(previousLease);
  expect(lease.active).toBe(true);
  expect(lease.bridge).toBeNull();
  expect(() => startHostBridge({ window })).toThrow(/already mounted/);
});
