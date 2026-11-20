/** In-memory fund-safe boundaries for route UI checks; no wallet, credentials, or network. */
import {
  atomic,
  createMemoryRampOperationStore,
  createRampClient,
  createXochiRampLeg,
  type RampLegSnapshot,
  type RampMoney,
  type RampProvider,
  type RampSnapshot,
  type XochiRampDriver,
  type XochiRampPreview,
} from "@xochi/client";
export const ROUTE_WALLET = "0x1111111111111111111111111111111111111111";
export const ROUTE_RECEIVED: RampMoney = {
  asset: {
    kind: "crypto",
    chain_id: "eip155:8453",
    asset_id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
  },
  atomic: atomic("25000000"),
};
export class MemoryRouteClient implements XochiRampDriver {
  quotes = 0;
  executions = 0;
  polls = 0;
  failQuote = false;
  now = Date.parse("2026-11-16T12:00:00Z");
  result: RampLegSnapshot = {
    name: "xochi",
    state: "completed",
    recoverable: false,
    transaction_hash: `0x${"ab".repeat(32)}`,
  };
  async quote(): Promise<XochiRampPreview> {
    this.quotes++;
    if (this.failQuote) throw new Error("route_failed");
    const output: RampMoney = {
      asset: {
        ...ROUTE_RECEIVED.asset,
        kind: "crypto",
        chain_id: "eip155:1",
        asset_id: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        decimals: 6,
      },
      atomic: atomic("24500000"),
    };
    return {
      quoteId: `quote_${this.quotes}`,
      expiresAt: new Date(this.now + 30_000).toISOString(),
      pay: ROUTE_RECEIVED,
      receive: output,
      recipient: ROUTE_WALLET,
      settlement: "public",
    };
  }
  async execute() {
    this.executions++;
    return this.result;
  }
  async poll() {
    this.polls++;
    return this.result;
  }
}
class NoResubmissionPeer implements RampProvider {
  readonly id = "peer";
  calls = 0;
  async capabilities() {
    this.calls++;
    return [];
  }
  normalizeCapabilities() {
    return [];
  }
  async preview(): Promise<never> {
    this.calls++;
    throw new Error("invalid_request");
  }
  async approve(): Promise<never> {
    this.calls++;
    throw new Error("invalid_request");
  }
  async interact(): Promise<never> {
    this.calls++;
    throw new Error("invalid_request");
  }
  async status(): Promise<never> {
    this.calls++;
    throw new Error("invalid_request");
  }
  async recover(): Promise<never> {
    this.calls++;
    throw new Error("invalid_request");
  }
}
export async function routeHarness() {
  const snapshot: RampSnapshot = {
    contract_version: "ramp/1",
    kind: "snapshot",
    operation_id: "purchase_local",
    revision: "0",
    direction: "onramp",
    leg_order: ["peer"],
    peer: { name: "peer", state: "completed", recoverable: false, payout_state: "released" },
    allowed_actions: [],
    terminal: true,
    updated_at: "2026-11-16T12:00:00Z",
  };
  const store = createMemoryRampOperationStore();
  await store.transact(snapshot.operation_id, () => ({
    record: { snapshot, receipts: {} },
    result: undefined,
  }));
  const driver = new MemoryRouteClient();
  const peer = new NoResubmissionPeer();
  const leg = createXochiRampLeg({
    store,
    driver,
    delivered: ROUTE_RECEIVED,
    now: () => driver.now,
  });
  const client = createRampClient({ store, peer, xochi: leg });
  return { snapshot, store, driver, peer, leg, client };
}
