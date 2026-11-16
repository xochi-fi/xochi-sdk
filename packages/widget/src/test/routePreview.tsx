/** Local visual evidence harness. All provider and Xochi calls use in-memory implementations. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { RampAction } from "@xochi/client";
import { RampRouteSteps } from "../ramp/route/RampRouteSteps.js";
import { routeHarness, ROUTE_RECEIVED, ROUTE_WALLET } from "./routePort.js";
import "../index.css";

const h = await routeHarness();
h.driver.now = Date.now();
if (new URLSearchParams(location.search).has("failure")) h.driver.failQuote = true;
function Preview() {
  const [snapshot, setSnapshot] = useState(h.snapshot);
  const [busy, setBusy] = useState(false);
  async function action(action: RampAction) {
    setBusy(true);
    try {
      const context = (revision: string) => ({
        expected_revision: revision,
        idempotency_key: crypto.randomUUID(),
      });
      const offered = snapshot.xochi
        ? snapshot
        : await h.client.offerRoute(snapshot.operation_id, context(snapshot.revision));
      setSnapshot(
        await h.client.recover(offered.operation_id, "xochi", action, context(offered.revision)),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main style={{ maxWidth: 460, margin: "auto", padding: 16 }}>
      <p>Trade / Buy · In-memory preview</p>
      <RampRouteSteps
        snapshot={snapshot}
        preview={h.leg.preview(snapshot.operation_id)}
        wallet={ROUTE_WALLET}
        received={ROUTE_RECEIVED}
        busy={busy}
        onAction={(a) => void action(a)}
      >
        <p>Route 25 Base USDC to USDT on Ethereum, paid to your wallet.</p>
      </RampRouteSteps>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
