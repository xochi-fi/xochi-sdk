import { isCantonPartyId } from "@xochi/client";
import { z } from "zod";

export const METATARZ_TESTNET = "canton:testnet";
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

type Method = "status" | "connect" | "getActiveNetwork" | "listAccounts";
type Event = "statusChanged" | "accountsChanged";
type Listener = () => void;

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
  | { kind: "connected"; primaryParty: string };

export async function readMetatarzSession(
  provider: MetatarzProvider,
  connect: boolean,
): Promise<MetatarzSession> {
  const current = status.parse(await provider.request({ method: "status" }));
  let state = current.connection;
  if (connect && !state.isConnected) {
    state = connection.parse(await provider.request({ method: "connect" }));
  }
  if (!state.isNetworkConnected) return { kind: "unreachable" };
  if (!state.isConnected) return { kind: "disconnected", reason: state.reason };

  const first = network.parse(await provider.request({ method: "getActiveNetwork" }));
  if (first.networkId !== METATARZ_TESTNET) {
    return { kind: "wrong-network", networkId: first.networkId };
  }
  const accounts = z.array(account).parse(await provider.request({ method: "listAccounts" }));
  const latest = status.parse(await provider.request({ method: "status" }));
  if (!latest.connection.isNetworkConnected) return { kind: "unreachable" };
  if (!latest.connection.isConnected) return { kind: "disconnected" };
  if (latest.network?.networkId !== METATARZ_TESTNET) {
    if (latest.network) return { kind: "wrong-network", networkId: latest.network.networkId };
    return { kind: "disconnected" };
  }
  const primary = accounts.filter((party) => party.primary && party.networkId === METATARZ_TESTNET);
  if (primary.length !== 1 || accounts.some((party) => party.networkId !== METATARZ_TESTNET)) {
    return { kind: "no-primary" };
  }
  return { kind: "connected", primaryParty: primary[0].partyId };
}

export function metatarzStandaloneUrl(): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set("initialTab", "send");
  return url.href;
}
