/** Actual presentation components over in-memory legs; no network or wallet. */
import { createRoot } from "react-dom/client";
import { atomic } from "@xochi/client";
import { useState } from "react";
import { OfframpRouteReview } from "../ramp/offramp/OfframpRouteReview.js";
import { CompletedPrerequisite } from "../ramp/offramp/CompletedPrerequisite.js";
import { createOfframpPrerequisite } from "../ramp/offramp/prerequisite.js";
import { ROUTE_RECEIVED, ROUTE_WALLET } from "./routePort.js";
import "../index.css";

const source = {
  asset: {
    kind: "crypto" as const,
    chain_id: "eip155:1",
    asset_id: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
  },
  atomic: atomic("25000000"),
};
const route = createOfframpPrerequisite({
  source,
  wallet: ROUTE_WALLET,
  spendable: async () => 24_000_000n,
  driver: {
    async quote() {
      return {
        quoteId: "route_synthetic",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        pay: source,
        receive: { ...ROUTE_RECEIVED, atomic: atomic("24000000") },
        recipient: ROUTE_WALLET,
        settlement: "public",
      };
    },
    async execute() {
      return { name: "xochi", state: "completed", recoverable: false };
    },
    async poll() {
      return { name: "xochi", state: "completed", recoverable: false };
    },
  },
});
await route.act("quote");
const failure = new URLSearchParams(location.search).has("failure");
if (failure) await route.act("execute");
function Preview() {
  const [, render] = useState(0);
  return (
    <main style={{ maxWidth: 460, margin: "auto", padding: 16 }}>
      <p>Send / Own payment app · In-memory preview</p>
      <h3>Cash out with two separate approvals</h3>
      {failure ? (
        <>
          <CompletedPrerequisite
            wallet={ROUTE_WALLET}
            peerFailed
            receipt={route.snapshot().operation_id}
          />
          <section className="send-review">
            <h4>Peer cash-out did not start</h4>
            <p role="alert">
              Peer's terms changed before deposit. Your 24 USDC remains in your wallet on Base. The
              completed Xochi route will not repeat.
            </p>
            <button className="submit-btn send-cta">Check Peer rails for a fresh estimate</button>
          </section>
        </>
      ) : (
        <OfframpRouteReview
          status={route.snapshot().xochi!.state}
          preview={route.preview()}
          receipt={route.snapshot().operation_id}
          authorized
          onAction={async (a) => {
            if (a !== "balance") await route.act(a);
            render((n) => n + 1);
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
