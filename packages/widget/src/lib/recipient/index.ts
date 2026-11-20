import { validateAddressForVm } from "@xochi/client";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { parseStealthMetaAddress } from "../../pages/send/stealthRecipient.js";
import { normalizeZkMoneyTag, zkMoneyTagValid } from "../../pages/trade/zkMoney.js";

export type RecipientKind = "address" | "ens" | "gns" | "wns" | "zkmoney" | "stealth_meta";

export interface ResolvedRecipient {
  readonly kind: RecipientKind;
  readonly input: string;
  readonly name?: string;
  readonly address?: Address;
  readonly avatarUrl?: string;
  readonly stealthMetaAddress?: string;
  readonly shieldedAlias?: string;
}

export type ResolveResult =
  | { readonly status: "resolved"; readonly recipient: ResolvedRecipient }
  | {
      readonly status: "not_found" | "invalid" | "unsupported" | "unavailable";
      readonly reason: string;
    };

export interface RecipientDeps {
  readonly mainnetClient: PublicClient;
  readonly clientFor: (chainId: number) => PublicClient | undefined;
}

const REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";
// Canonical deployments with bytecode verified via eth_getCode. Ethereum takes
// priority, then Base, then the other mainnets and testnets in this order.
const REGISTRY_CHAINS: readonly number[] = [
  1, 8453, 42161, 10, 100, 137, 534352, 11155111, 84532, 421614, 11155420,
];
const registryAbi = parseAbi([
  "function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)",
  "function registerKeys(uint256 schemeId, bytes stealthMetaAddress)",
]);
const SCHEME_ID = 1n;
const STEALTH_PREFIX = "st:eth:";
const STEALTH_TEXT_KEY = "stealth-meta-address[1]";

const nameRegistries = {
  gns: "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6",
  wns: "0x0000000000696760E15f265e828DB644A0c242EB",
} as const;
const nameRegistryAbi = parseAbi([
  "function computeId(string fullName) pure returns (uint256)",
  "function resolve(uint256 tokenId) view returns (address)",
]);

const ENS_RESOLVER = mainnet.contracts.ensUniversalResolver.address;
const ZK_MONEY_SUFFIX = ".zk.money";
// Same Universal Resolver and missing-user selector as the Shielded quote worker.
const ZK_MONEY_RESOLVER = "0x64969fb44091A7E5fA1213D30D7A7e8488edf693";
const USER_NOT_FOUND = "0x9a66e130";

export function classifyRecipientInput(input: string): RecipientKind | "unknown" {
  const value = input.trim().toLowerCase();
  if (value.startsWith("st:")) return "stealth_meta";
  if (value.startsWith("0x") && !value.includes(".")) return "address";
  if (value.startsWith("@") || value.endsWith(ZK_MONEY_SUFFIX)) return "zkmoney";
  if (value.endsWith(".eth")) return "ens";
  if (value.endsWith(".gwei")) return "gns";
  if (value.endsWith(".wei")) return "wns";
  return "unknown";
}

// Viem ENS and contract actions don't accept a signal. Return promptly on
// abort and prevent later lookups even if an in-flight RPC finishes afterward.
async function abortable<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, run()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function validAddress(value: string | null | undefined): Address | undefined {
  if (!value || !validateAddressForVm(value, "evm").valid) return undefined;
  return getAddress(value);
}

function validMetaAddress(value: string): string | undefined {
  const parsed = parseStealthMetaAddress(value);
  return parsed.ok ? parsed.recipient.encoded : undefined;
}

async function ensRecord<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
  zkMoney = false,
): Promise<T | null> {
  try {
    return await abortable(read, signal);
  } catch (error) {
    signal?.throwIfAborted();
    const revert =
      error instanceof BaseError &&
      error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const { errorName, args } = revert.data ?? {};
      if (
        errorName === "ResolverNotFound" ||
        errorName === "UnsupportedResolverProfile" ||
        errorName === "ReverseAddressMismatch" ||
        (zkMoney && errorName === "ResolverError" && args?.[0] === USER_NOT_FOUND)
      ) {
        return null;
      }
    }
    throw error;
  }
}

async function reverseName(
  address: Address,
  client: PublicClient,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // Viem's universal resolver verifies that the primary name resolves back.
  const name = await ensRecord(
    () => client.getEnsName({ address, universalResolverAddress: ENS_RESOLVER, strict: true }),
    signal,
  );
  return name ? normalize(name) : undefined;
}

async function httpsAvatar(
  name: string,
  client: PublicClient,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const avatar = await abortable(
      () => client.getEnsAvatar({ name, universalResolverAddress: ENS_RESOLVER }),
      signal,
    );
    if (avatar && new URL(avatar).protocol === "https:") return avatar;
  } catch {
    signal?.throwIfAborted();
  }
}

async function registryMetaAddress(
  address: Address,
  deps: RecipientDeps,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let failed = false;
  for (const chainId of REGISTRY_CHAINS) {
    signal?.throwIfAborted();
    const client = chainId === 1 ? deps.mainnetClient : deps.clientFor(chainId);
    if (!client) continue;
    try {
      const code = await abortable(() => client.getCode({ address: REGISTRY }), signal);
      if (!code || code === "0x") continue;
      const bytes = await abortable(
        () =>
          client.readContract({
            address: REGISTRY,
            abi: registryAbi,
            functionName: "stealthMetaAddressOf",
            args: [address, SCHEME_ID],
          }),
        signal,
      );
      const metaAddress = validMetaAddress(`${STEALTH_PREFIX}${bytes}`);
      if (metaAddress) return metaAddress;
    } catch {
      signal?.throwIfAborted();
      failed = true;
    }
  }
  // An RPC error cannot establish that a recipient lacks a private destination.
  if (failed) throw new Error("Registry lookup unavailable.");
}

async function ensMetaAddress(
  name: string,
  client: PublicClient,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const text = await ensRecord(
    () =>
      client.getEnsText({
        name,
        key: STEALTH_TEXT_KEY,
        universalResolverAddress: ENS_RESOLVER,
        strict: true,
      }),
    signal,
  );
  return text ? validMetaAddress(text) : undefined;
}

async function addressMetaAddress(
  address: Address,
  deps: RecipientDeps,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const registered = await registryMetaAddress(address, deps, signal);
  if (registered) return registered;
  const name = await reverseName(address, deps.mainnetClient, signal);
  return name ? ensMetaAddress(name, deps.mainnetClient, signal) : undefined;
}

/** Use readStealthRegistration when absence must be distinguished from a lookup failure. */
export async function lookupStealthMetaAddress(
  address: Address,
  deps: RecipientDeps,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    if (validAddress(address)) return await addressMetaAddress(address, deps, signal);
  } catch {
    return undefined;
  }
}

export async function readStealthRegistration(
  address: Address,
  deps: RecipientDeps,
  signal?: AbortSignal,
): Promise<"published" | "not_published" | "unknown"> {
  try {
    if (!validAddress(address)) return "unknown";
    return (await addressMetaAddress(address, deps, signal)) ? "published" : "not_published";
  } catch {
    return "unknown";
  }
}

/** Build unsigned calldata for a verified deployment. */
export function buildRegisterStealthMetaAddressTx(
  metaAddress: string,
  chainId: number,
): { to: Address; data: `0x${string}`; value: 0n } {
  if (!REGISTRY_CHAINS.includes(chainId)) throw new Error("Unsupported registry chain.");
  const parsed = parseStealthMetaAddress(metaAddress);
  if (!parsed.ok) throw new Error("Invalid stealth meta-address.");
  return {
    to: REGISTRY,
    data: encodeFunctionData({
      abi: registryAbi,
      functionName: "registerKeys",
      args: [
        SCHEME_ID,
        `0x${parsed.recipient.spendingPubKey.slice(2)}${parsed.recipient.viewingPubKey.slice(2)}`,
      ],
    }),
    value: 0n,
  };
}

async function resolveRegistryName(
  kind: "gns" | "wns",
  name: string,
  client: PublicClient,
  signal?: AbortSignal,
): Promise<Address | null> {
  const address = nameRegistries[kind];
  const tokenId = await abortable(
    () =>
      client.readContract({
        address,
        abi: nameRegistryAbi,
        functionName: "computeId",
        args: [name],
      }),
    signal,
  );
  if (!tokenId) return null;
  return abortable(
    () =>
      client.readContract({
        address,
        abi: nameRegistryAbi,
        functionName: "resolve",
        args: [tokenId],
      }),
    signal,
  );
}

const NOT_FOUND = { status: "not_found", reason: "Recipient not found." } as const;

export async function resolveRecipient(
  input: string,
  deps: RecipientDeps,
  signal?: AbortSignal,
): Promise<ResolveResult> {
  const value = input.trim();
  const kind = classifyRecipientInput(value);
  try {
    signal?.throwIfAborted();
    if (kind === "unknown") {
      if (/^[^\s.]+(?:\.[^\s.]+)+$/u.test(value)) {
        return { status: "unsupported", reason: "Unsupported name suffix." };
      }
      return { status: "invalid", reason: "Enter a recipient name or address." };
    }
    if (kind === "stealth_meta") {
      const parsed = parseStealthMetaAddress(value);
      if (!parsed.ok) return { status: "invalid", reason: "Invalid stealth meta-address." };
      const encoded = parsed.recipient.encoded;
      return {
        status: "resolved",
        recipient: { kind, input: encoded, stealthMetaAddress: encoded },
      };
    }
    const client = deps.mainnetClient;
    if (kind === "zkmoney") {
      const bareAlias = normalizeZkMoneyTag(value);
      const alias = bareAlias.endsWith(ZK_MONEY_SUFFIX)
        ? bareAlias.slice(0, -ZK_MONEY_SUFFIX.length)
        : bareAlias;
      if (!zkMoneyTagValid(alias)) return { status: "invalid", reason: "Invalid zk.money alias." };
      const name = `${alias}${ZK_MONEY_SUFFIX}`;
      const deposit = await ensRecord(
        () =>
          client.getEnsAddress({
            name: normalize(name),
            universalResolverAddress: ZK_MONEY_RESOLVER,
            strict: true,
          }),
        signal,
        true,
      );
      if (!validAddress(deposit)) return NOT_FOUND;
      // The quote worker binds a fresh one-time address when settling the alias.
      return { status: "resolved", recipient: { kind, input: alias, name, shieldedAlias: alias } };
    }

    let address: Address | undefined;
    let name: string | undefined;
    let normalizedInput: string;
    if (kind === "address") {
      const validation = validateAddressForVm(value, "evm");
      if (!validation.valid) {
        return { status: "invalid", reason: validation.error ?? "Invalid Ethereum address" };
      }
      address = getAddress(value);
      normalizedInput = address;
    } else {
      try {
        name = normalize(value);
      } catch {
        return { status: "invalid", reason: "Invalid recipient name." };
      }
      const canonicalName = name;
      normalizedInput = name;
      const resolved =
        kind === "ens"
          ? await ensRecord(
              () =>
                client.getEnsAddress({
                  name: canonicalName,
                  universalResolverAddress: ENS_RESOLVER,
                  strict: true,
                }),
              signal,
            )
          : await resolveRegistryName(kind, canonicalName, client, signal);
      address = validAddress(resolved);
      if (!address) return NOT_FOUND;
    }

    const registered = await registryMetaAddress(address, deps, signal);
    let ensName = kind === "ens" ? name : undefined;
    if (kind === "address") {
      try {
        name = ensName = await reverseName(address, client, signal);
      } catch (error) {
        if (!registered) throw error;
      }
    } else if (kind !== "ens" && !registered) {
      ensName = await reverseName(address, client, signal);
    }
    const stealthMetaAddress =
      registered ?? (ensName && (await ensMetaAddress(ensName, client, signal)));
    const avatarUrl = ensName && (await httpsAvatar(ensName, client, signal));
    signal?.throwIfAborted();
    return {
      status: "resolved",
      recipient: {
        kind,
        input: normalizedInput,
        address,
        ...(name && { name }),
        ...(avatarUrl && { avatarUrl }),
        ...(stealthMetaAddress && { stealthMetaAddress }),
      },
    };
  } catch {
    return {
      status: "unavailable",
      reason: signal?.aborted ? "Recipient lookup cancelled." : "Recipient lookup unavailable.",
    };
  }
}
