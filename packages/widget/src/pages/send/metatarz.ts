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

interface MetatarzProvider {
  isMetatarzWallet: true;
  request(args: { method: Method }): Promise<unknown>;
  on(event: Event, listener: Listener): void;
  removeListener(event: Event, listener: Listener): void;
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
): Promise<MetatarzSession> {
  const current = status.parse(await provider.request({ method: "status" }));
  let state = current.connection;
  const approving = connect && !state.isConnected;
  if (approving) {
    state = connection.parse(await provider.request({ method: "connect" }));
  }
  if (!state.isNetworkConnected) return { kind: "unreachable" };
  if (!state.isConnected) return { kind: "disconnected", reason: state.reason };

  if (expectedNetwork === METATARZ_TESTNET) return readAllocatedParty(provider, expectedNetwork);

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
  provider.on("statusChanged", statusChanged);
  provider.on("accountsChanged", accountsChanged);
  try {
    const session = await readAllocatedParty(provider, expectedNetwork);
    return changed && session.kind === "connected" ? { kind: "changed" } : session;
  } finally {
    provider.removeListener("statusChanged", statusChanged);
    provider.removeListener("accountsChanged", accountsChanged);
  }
}

async function readAllocatedParty(
  provider: MetatarzProvider,
  expectedNetwork: typeof METATARZ_TESTNET | typeof METATARZ_MAINNET,
): Promise<MetatarzSession> {
  const first = network.parse(await provider.request({ method: "getActiveNetwork" }));
  if (first.networkId !== expectedNetwork) {
    return { kind: "wrong-network", networkId: first.networkId };
  }
  const accounts = z.array(account).parse(await provider.request({ method: "listAccounts" }));
  const latest = status.parse(await provider.request({ method: "status" }));
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
    const active = account.parse(await provider.request({ method: "getPrimaryAccount" }));
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
