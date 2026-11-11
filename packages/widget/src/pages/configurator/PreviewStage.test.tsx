// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  MESSAGE,
  WIDGET_PROTOCOL_VERSION,
  type Eip1193Provider,
  type HostMessage,
} from "@xochi/widget-lib";
import { PreviewStage } from "./PreviewStage.js";

const origin = window.location.origin;

function frameSends(frame: Window, data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame }));
  });
}

afterEach(cleanup);

describe("PreviewStage host wallet bridge", () => {
  it("answers the frame and forwards its wallet RPC to the host provider", async () => {
    const requests: unknown[] = [];
    const provider: Eip1193Provider = {
      request: async (args) => {
        requests.push(args);
        return ["0x1234567890123456789012345678901234567890"];
      },
    };
    window.ethereum = provider;

    render(
      <PreviewStage
        path="/embed?toChain=1"
        params={{ toChainId: 1 }}
        backdrop={{ kind: "checker", custom: "#58a1c6" }}
        onBackdrop={() => {}}
        device="desktop"
        onDevice={() => {}}
      />,
    );
    const iframe = screen.getByTitle("Xochi swap preview") as HTMLIFrameElement;
    const frame = iframe.contentWindow;
    if (frame === null) throw new Error("preview frame has no window");
    const received: HostMessage[] = [];
    frame.addEventListener("message", (event) => received.push(event.data as HostMessage));

    // Mounting only advertises the wallet. It never connects or reads accounts.
    expect(requests).toEqual([]);
    frameSends(frame, { type: MESSAGE.ready, protocolVersion: WIDGET_PROTOCOL_VERSION });
    await waitFor(() =>
      expect(received.some((message) => message.type === MESSAGE.provider)).toBe(true),
    );
    const providerMessage = received.find((message) => message.type === MESSAGE.provider);
    if (providerMessage?.type !== MESSAGE.provider) {
      throw new Error("preview host did not advertise its provider");
    }
    expect(providerMessage).toMatchObject({
      protocolVersion: WIDGET_PROTOCOL_VERSION,
      available: true,
      autoConnect: false,
    });
    frameSends(frame, {
      type: MESSAGE.providerAck,
      protocolVersion: WIDGET_PROTOCOL_VERSION,
      handshakeId: providerMessage.handshakeId,
      walletUi: providerMessage.walletUi,
    });
    frameSends(frame, {
      type: MESSAGE.rpc,
      id: "preview-wallet-request",
      method: "eth_requestAccounts",
      params: [],
    });
    await waitFor(() => expect(requests).toEqual([{ method: "eth_requestAccounts", params: [] }]));
    await waitFor(() =>
      expect(received).toContainEqual({
        type: MESSAGE.rpcResult,
        id: "preview-wallet-request",
        result: ["0x1234567890123456789012345678901234567890"],
      }),
    );
  });
});
