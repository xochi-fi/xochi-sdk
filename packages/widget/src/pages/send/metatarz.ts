import { isCantonPartyId } from "@xochi/client";
import { z } from "zod";

export const METATARZ_TESTNET = "canton:testnet";
export const METATARZ_MAINNET = "canton:mainnet";
export const METATARZ_INSTALL =
  "https://chromewebstore.google.com/detail/metatarz-wallet/cdpompnhkhhadajaihlfbmcafdpcholm";

const connection = z.object({
  isConnected: z.boolean(),
  isNetworkConnected: z.boolean(),
  reason: z.string().optional(),
});
const network = z.object({ networkId: z.string() });
const status = z.object({
  provider: z.object({ id: z.literal("metatarz-wallet"), providerType: z.literal("browser") }),
  connection,
  network: network.optional(),
});
const account = z.object({
  partyId: z.string().refine(isCantonPartyId),
  networkId: z.string(),
  primary: z.boolean(),
  status: z.literal("allocated"),
});

type Method = "status" | "connect" | "getActiveNetwork" | "listAccounts" | "getPrimaryAccount";
type Event = "statusChanged" | "accountsChanged";
type Listener = (payload: unknown) => void;

export type MetatarzLedgerRequest =
  | { requestMethod: "GET"; resource: "/v2/state/ledger-end" }
  | {
      requestMethod: "POST";
      resource: "/v2/state/active-contracts" | "/v2/updates/flats";
      body: object;
      query?: { limit: number };
    };

export interface MetatarzProvider {
  isMetatarzWallet: true;
  request(
    args: { method: Method } | { method: "ledgerApi"; params: MetatarzLedgerRequest },
  ): Promise<unknown>;
  on(event: Event, listener: Listener): void;
  removeListener(event: Event, listener: Listener): void;
}

// The extension owns the approval dialog. Keep it available for the next read
// even when the form cancels the request that opened it.
const approvals = new WeakMap<MetatarzProvider, Promise<unknown>>();

function requestApproval(provider: MetatarzProvider): Promise<unknown> {
  const pending = approvals.get(provider);
  if (pending) return pending;
  const approval = provider
    .request({ method: "connect" })
    .finally(() => approvals.delete(provider));
  approvals.set(provider, approval);
  return approval;
}

export function metatarzProvider(): MetatarzProvider | undefined {
  const provider = (window as Window & { canton?: Partial<MetatarzProvider> }).canton;
  if (
    provider?.isMetatarzWallet === true &&
    typeof provider.request === "function" &&
    typeof provider.on === "function" &&
    typeof provider.removeListener === "function"
  ) {
    return provider as MetatarzProvider;
  }
}

export type MetatarzSession =
  | { kind: "disconnected"; reason?: string }
  | { kind: "unreachable" }
  | { kind: "wrong-network"; networkId: string }
  | { kind: "no-primary" }
  | { kind: "changed" }
  | { kind: "connected"; primaryParty: string };

export async function readMetatarzSession(
  provider: MetatarzProvider,
  connect: boolean,
  expectedNetwork: typeof METATARZ_TESTNET | typeof METATARZ_MAINNET = METATARZ_TESTNET,
  signal?: AbortSignal,
): Promise<MetatarzSession> {
  async function request(method: Method): Promise<unknown> {
    signal?.throwIfAborted();
    const result =
      method === "connect" ? await requestApproval(provider) : await provider.request({ method });
    signal?.throwIfAborted();
    return result;
  }

  const current = status.parse(await request("status"));
  let state = current.connection;
  const approving = connect && !state.isConnected;
  if (approving) {
    state = connection.parse(await request("connect"));
  }
  if (!state.isNetworkConnected) return { kind: "unreachable" };
  if (!state.isConnected) return { kind: "disconnected", reason: state.reason };

  if (expectedNetwork === METATARZ_TESTNET) return readAllocatedParty(request, expectedNetwork);

  let changed = false;
  const accountsChanged = () => {
    changed = true;
  };
  const statusChanged = (payload: unknown) => {
    const reported = status.safeParse(payload);
    // The approval's own notification can arrive after the connect reply.
    if (
      approving &&
      reported.success &&
      reported.data.connection.isConnected &&
      reported.data.connection.isNetworkConnected &&
      reported.data.network?.networkId === expectedNetwork
    )
      return;
    changed = true;
  };
  function removeListeners() {
    provider.removeListener("statusChanged", statusChanged);
    provider.removeListener("accountsChanged", accountsChanged);
  }
  signal?.throwIfAborted();
  provider.on("statusChanged", statusChanged);
  provider.on("accountsChanged", accountsChanged);
  signal?.addEventListener("abort", removeListeners, { once: true });
  try {
    const session = await readAllocatedParty(request, expectedNetwork);
    return changed && session.kind === "connected" ? { kind: "changed" } : session;
  } finally {
    signal?.removeEventListener("abort", removeListeners);
    if (!signal?.aborted) removeListeners();
  }
}

async function readAllocatedParty(
  request: (method: Method) => Promise<unknown>,
  expectedNetwork: typeof METATARZ_TESTNET | typeof METATARZ_MAINNET,
): Promise<MetatarzSession> {
  const first = network.parse(await request("getActiveNetwork"));
  if (first.networkId !== expectedNetwork) {
    return { kind: "wrong-network", networkId: first.networkId };
  }
  const accounts = z.array(account).parse(await request("listAccounts"));
  const latest = status.parse(await request("status"));
  if (!latest.connection.isNetworkConnected) return { kind: "unreachable" };
  if (!latest.connection.isConnected) return { kind: "disconnected" };
  if (latest.network?.networkId !== expectedNetwork) {
    if (latest.network) return { kind: "wrong-network", networkId: latest.network.networkId };
    return { kind: "disconnected" };
  }
  const primary = accounts.filter((party) => party.primary && party.networkId === expectedNetwork);
  if (primary.length !== 1 || accounts.some((party) => party.networkId !== expectedNetwork)) {
    return { kind: "no-primary" };
  }
  if (expectedNetwork === METATARZ_MAINNET) {
    // Check the current selection again even if the change event is still in transit.
    const active = account.parse(await request("getPrimaryAccount"));
    if (
      !active.primary ||
      active.networkId !== expectedNetwork ||
      active.partyId !== primary[0].partyId
    ) {
      return { kind: "changed" };
    }
  }
  return { kind: "connected", primaryParty: primary[0].partyId };
}

export function metatarzStandaloneUrl(destination?: { chainId: number; symbol: string }): string {
  const url = new URL(window.location.pathname, window.location.origin);
  if (destination) {
    url.search = window.location.search;
    url.searchParams.set("initialTab", "trade");
    url.searchParams.set("initialMode", "swap");
    url.searchParams.set("toChain", String(destination.chainId));
    url.searchParams.set("buy", destination.symbol);
  } else {
    url.searchParams.set("initialTab", "send");
  }
  return url.href;
}
