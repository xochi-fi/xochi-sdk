// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  MESSAGE,
  WIDGET_PROTOCOL_VERSION,
  connectToHost,
  type HostConnection,
  type HostMessage,
} from "@xochi/widget-lib";
import { useEmbedLook } from "./useEmbedLook.js";

let iframe: HTMLIFrameElement;
let frame: Window;
let parent: Window;
let bridge: HostConnection;

function hostSends(message: HostMessage): void {
  act(() => {
    frame.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: window.location.origin,
        source: parent,
      }),
    );
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/embed?theme=dim&layout=swap&howItWorks=0&height=640");
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  frame = iframe.contentWindow!;
  parent = frame.parent;
  bridge = connectToHost({ window: frame })!;
  hostSends({
    type: MESSAGE.provider,
    protocolVersion: WIDGET_PROTOCOL_VERSION,
    handshakeId: 1,
    available: false,
    autoConnect: false,
    walletUi: "host",
  });
});

afterEach(() => {
  cleanup();
  bridge.destroy();
  iframe.remove();
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("live host theme consumption", () => {
  it("uses the URL first, then changes only the theme without rereading layout", () => {
    const { result, rerender, unmount } = renderHook(() => useEmbedLook(bridge));
    const initial = result.current;
    expect(initial).toEqual({ theme: "dim", layout: "swap", howItWorks: false, height: 640 });

    hostSends({ type: MESSAGE.theme, theme: "light" });
    expect(result.current).toEqual({ ...initial, theme: "light" });
    const lightLook = result.current;
    hostSends({ type: MESSAGE.theme, theme: "light" });
    expect(result.current).toBe(lightLook);

    window.history.replaceState({}, "", "/embed?theme=contrast&layout=full&height=900");
    rerender();
    expect(result.current).toBe(lightLook);
    hostSends({ type: MESSAGE.theme, theme: "contrast" });
    expect(result.current).toEqual({ ...initial, theme: "contrast" });
    unmount();
    hostSends({ type: MESSAGE.theme, theme: "dim" });
  });

  it("reads a theme already delivered before React subscribes", () => {
    hostSends({ type: MESSAGE.theme, theme: "contrast" });
    const { result } = renderHook(() => useEmbedLook(bridge));
    expect(result.current.theme).toBe("contrast");
  });

  it("resubscribes when a preserved frame receives a new bridge instance", () => {
    const { result, rerender } = renderHook(
      ({ connection }: { connection: HostConnection }) => useEmbedLook(connection),
      { initialProps: { connection: bridge } },
    );
    hostSends({ type: MESSAGE.theme, theme: "light" });
    const initial = result.current;
    const previousBridge = bridge;

    previousBridge.destroy();
    bridge = connectToHost({ window: frame })!;
    hostSends({
      type: MESSAGE.provider,
      protocolVersion: WIDGET_PROTOCOL_VERSION,
      handshakeId: 1,
      available: false,
      autoConnect: false,
      walletUi: "host",
    });
    hostSends({ type: MESSAGE.theme, theme: "contrast" });
    expect(result.current).toBe(initial);

    rerender({ connection: bridge });
    expect(result.current).toEqual({ ...initial, theme: "contrast" });
    hostSends({ type: MESSAGE.theme, theme: "dim" });
    expect(result.current).toEqual({ ...initial, theme: "dim" });
  });
});
