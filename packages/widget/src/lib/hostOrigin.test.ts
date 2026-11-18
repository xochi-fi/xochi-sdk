// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MESSAGE } from "@xochi/widget-lib";
import { isFirstPartyHost, startHostBridge, type HostBridgeLease } from "./hostBridge.js";
import { firstPartyOrigins } from "./hostOrigin.js";

// The frame is a real child browsing context of this jsdom window; jsdom leaves
// `source` null on delivered messages, so the parent's posts are dispatched on
// the frame with `source` set, the way a browser delivers them.

const PRODUCTION = ["https://xochi.fi", "https://www.xochi.fi"];

let iframe: HTMLIFrameElement;
let frame: Window;
let lease: HostBridgeLease | null = null;

/** A message to the frame from `source` (default: its parent), as the browser stamps it. */
function post(origin: string, data: object = HANDSHAKE, source: Window = frame.parent): void {
  frame.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

const HANDSHAKE = { type: MESSAGE.provider, available: false, autoConnect: false };

function bridgeWith(allowed: readonly string[]): { firstPartyHost(): boolean } {
  lease = startHostBridge({ window: frame }, allowed);
  const bridge = lease.bridge;
  if (bridge === null) throw new Error("expected a framed bridge");
  return { firstPartyHost: () => isFirstPartyHost(bridge) };
}

beforeEach(() => {
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  frame = iframe.contentWindow!;
});

afterEach(() => {
  lease?.stop();
  lease = null;
  iframe.remove();
  window.history.replaceState({}, "", "/");
});

describe("a bridge's first-party host", () => {
  it("is our page once our page has answered the handshake", () => {
    const host = bridgeWith(PRODUCTION);
    expect(host.firstPartyHost()).toBe(false);
    post("https://www.xochi.fi");
    expect(host.firstPartyHost()).toBe(true);
  });

  it("is not a third-party page", () => {
    const host = bridgeWith(PRODUCTION);
    post("https://partner.example");
    expect(host.firstPartyHost()).toBe(false);
  });

  it.each(["https://xochi.fi.evil.com", "http://xochi.fi", "https://evil.xochi.fi"])(
    "is not the near miss %s",
    (origin) => {
      const host = bridgeWith(PRODUCTION);
      post(origin);
      expect(host.firstPartyHost()).toBe(false);
    },
  );

  it("ignores an origin claimed in the embed URL or a message", () => {
    window.history.replaceState(
      {},
      "",
      "/embed?hostOrigin=https%3A%2F%2Fxochi.fi&origin=https%3A%2F%2Fxochi.fi",
    );
    const host = bridgeWith(PRODUCTION);
    post("https://partner.example", {
      ...HANDSHAKE,
      origin: "https://xochi.fi",
      hostOrigin: "https://xochi.fi",
    });
    expect(host.firstPartyHost()).toBe(false);
  });

  it("counts only what the parent window posts", () => {
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    try {
      const host = bridgeWith(PRODUCTION);
      post("https://xochi.fi", HANDSHAKE, other.contentWindow!);
      expect(host.firstPartyHost()).toBe(false);
      post("https://partner.example");
      post("https://xochi.fi", HANDSHAKE, other.contentWindow!);
      expect(host.firstPartyHost()).toBe(false);
    } finally {
      other.remove();
    }
  });

  it("is not our page once the parent has posted from any other origin", () => {
    const host = bridgeWith(PRODUCTION);
    post("https://xochi.fi");
    post("https://partner.example", { type: "partner:hello" });
    expect(host.firstPartyHost()).toBe(false);
  });

  it("is never our page under an empty list", () => {
    const host = bridgeWith(firstPartyOrigins(""));
    post("https://xochi.fi");
    expect(host.firstPartyHost()).toBe(false);
  });

  it("must agree with the parent origin the browser reports, where it reports one", () => {
    const report = (origin: string) =>
      Object.defineProperty(frame.location, "ancestorOrigins", {
        value: [origin],
        configurable: true,
      });
    const host = bridgeWith(PRODUCTION);
    post("https://xochi.fi");
    report("https://partner.example");
    expect(host.firstPartyHost()).toBe(false);
    report("https://xochi.fi");
    expect(host.firstPartyHost()).toBe(true);
  });
});
