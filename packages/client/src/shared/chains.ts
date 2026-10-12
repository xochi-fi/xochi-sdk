/**
 * Chain Definitions
 *
 * Supported chains and their configuration.
 *
 * `CHAIN_REGISTRY` is the ONE literal in this file: the `ChainId` union, every
 * display/lookup map and `SUPPORTED_CHAIN_IDS` are derived from it. `SUPPORTED_CHAIN_IDS`
 * is typed `readonly ChainId[]`, so a hand-maintained copy that omitted a chain compiled
 * cleanly and silently excluded it from `isChainId`, `SETTLEABLE_CHAIN_IDS` and the
 * capabilities fallback; the per-chain maps outside this file (`tokens.ts`) fail to
 * compile until they carry a new registry entry.
 */

/**
 * One supported EVM chain. `explorer` is an origin with no trailing path.
 * `nativeCurrency` is the gas token symbol (defaults to "ETH" if omitted).
 */
export interface ChainDefinition {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly explorer: string;
  readonly nativeCurrency?: string;
}

/**
 * The single source of truth for supported EVM chains.
 *
 * Keyed by slug rather than by id for two reasons: the slugs are themselves
 * public API (`CHAIN_IDS.base`), and string keys preserve insertion order, so
 * `SUPPORTED_CHAIN_IDS` keeps its declared order. Integer-like keys would be
 * re-sorted ascending by the runtime, which would silently reorder the
 * `/api/capabilities` fallback payload built from that array.
 *
 * Non-EVM and virtual chains are deliberately NOT here: Tron (base58 addresses,
 * TronWeb signing, hash-route explorer) and the Aztec virtual source chain (0)
 * are display-only, and join the extended maps below through their own
 * constants. EVM-only code (viem/wagmi/RPC) must never receive those ids.
 *
 * Short names are the compact UI labels; explorers are the origins the link
 * helpers below build on (one map, so per-component explorer maps cannot
 * drift).
 */
export const CHAIN_REGISTRY = {
  ethereum: { id: 1, name: "Ethereum", shortName: "ETH", explorer: "https://etherscan.io" },
  optimism: {
    id: 10,
    name: "Optimism",
    shortName: "OP",
    explorer: "https://optimistic.etherscan.io",
  },
  polygon: {
    id: 137,
    name: "Polygon",
    shortName: "POLY",
    explorer: "https://polygonscan.com",
    nativeCurrency: "POL",
  },
  arbitrum: { id: 42161, name: "Arbitrum", shortName: "ARB", explorer: "https://arbiscan.io" },
  base: { id: 8453, name: "Base", shortName: "BASE", explorer: "https://basescan.org" },
  robinhood: {
    id: 4663,
    name: "Robinhood",
    shortName: "HOOD",
    explorer: "https://robinhoodchain.blockscout.com",
  },
  arc: {
    id: 5042,
    name: "Arc",
    shortName: "ARC",
    explorer: "https://explorer.arc.io",
    nativeCurrency: "USDC",
  },
  gnosis: {
    id: 100,
    name: "Gnosis",
    shortName: "GNO",
    explorer: "https://gnosisscan.io",
    nativeCurrency: "xDAI",
  },
} as const satisfies Record<string, ChainDefinition>;

/** Slug of a supported chain: the `CHAIN_REGISTRY` keys. */
export type ChainSlug = keyof typeof CHAIN_REGISTRY;

/** Supported L1/L2 chain IDs, derived from `CHAIN_REGISTRY`. */
export type ChainId = (typeof CHAIN_REGISTRY)[ChainSlug]["id"];

/** Registry entries in declaration order. */
const CHAIN_LIST = Object.values(CHAIN_REGISTRY);

/**
 * Project the registry into a per-chain lookup.
 *
 * The assertion is confined to this helper: the loop writes exactly one entry
 * per registry chain, so the result is exhaustive by construction, but TS cannot
 * prove exhaustiveness of a runtime iteration. Call sites stay plain
 * `Record<ChainId, T>` with no cast of their own.
 */
function byChainId<T>(project: (chain: ChainDefinition) => T): Record<ChainId, T> {
  const lookup: Partial<Record<ChainId, T>> = {};
  for (const chain of CHAIN_LIST) lookup[chain.id] = project(chain);
  return lookup as Record<ChainId, T>;
}

/** Aztec virtual chain ID for shielded operations */
export type AztecChainId = 0;

/**
 * Extended chain ID: every UI-renderable chain beyond the core EVM `ChainId`.
 * Includes the Aztec virtual source chain (0) and non-EVM destinations (Tron).
 * Used for `Token.chainId` and the display maps (`EXTENDED_CHAIN_NAMES`,
 * `CHAIN_ICONS`). EVM-only code (viem/wagmi/RPC) must never receive these.
 */
export type ExtendedChainId = ChainId | AztecChainId | TronChainId;

/**
 * Tron mainnet chain id. Tron is non-EVM (base58 addresses, TronWeb signing),
 * so it is deliberately kept OUT of the EVM `ChainId` union -- EVM-only code
 * (viem, wagmi, contract reads) must never receive it. UI-level chain selection
 * uses `SelectableChainId` below.
 */
export const TRON_CHAIN_ID = 728_126_428;
export type TronChainId = typeof TRON_CHAIN_ID;

/** Tron display names (Tron is outside CHAIN_REGISTRY, being non-EVM). */
export const TRON_CHAIN_NAME = "Tron";
export const TRON_SHORT_NAME = "TRON";

/**
 * Chains a user can pick in the trade UI: every EVM chain plus Tron. Components
 * that only do chain *selection* (selectors, route display) accept this wider
 * union; anything that touches an EVM RPC stays on `ChainId`.
 */
export type SelectableChainId = ChainId | TronChainId;

/** Type guard for the Tron mainnet chain id. */
export function isTronChainId(value: unknown): value is TronChainId {
  return value === TRON_CHAIN_ID;
}

/**
 * Type guard for any chain the UI can render a link/name for (every EVM `ChainId`
 * plus Tron). Guards raw `settlementChainId` values from Riddler -- which adds
 * chains on its own cadence -- so an unknown id falls back to inference instead of
 * producing a dead `href=""` or a `View undefined tx` label.
 */
export function isSelectableChainId(value: unknown): value is SelectableChainId {
  return isChainId(value) || isTronChainId(value);
}

/**
 * Robinhood Chain (4663): an Arbitrum Orbit L2 whose native stablecoin is USDG
 * (Global Dollar, Paxos). It has no USDC. The solver settles USDC<->USDG (and
 * other stablecoin) cross-asset corridors to and from it. It is fully EVM (0x
 * addresses, EIP-712 signing, Permit2 pull on USDG) and a first-class member
 * of `ChainId`: the trade UI lists Robinhood + USDG, so the per-chain token
 * maps carry it. USDG is a first-class token (see USDG_ADDRESSES in
 * tokens.ts), never shoehorned into USDC_ADDRESSES (that map is Permit2-free
 * ERC-3009 USDC only, and USDG supports neither ERC-3009 nor EIP-2612).
 * `ROBINHOOD_CHAIN_ID` is kept for readable references and the settleable
 * guards below.
 */
export const ROBINHOOD_CHAIN_ID = 4663;
export type RobinhoodChainId = typeof ROBINHOOD_CHAIN_ID;

/** Type guard for the Robinhood Chain id. */
export function isRobinhoodChainId(value: unknown): value is RobinhoodChainId {
  return value === ROBINHOOD_CHAIN_ID;
}

/**
 * Arc chain id. Arc is Circle's EVM-compatible L1 where USDC is the native
 * gas token (18 dec protocol-level, 6 dec ERC-20). No WETH, no ETH --
 * stablecoin-only chain. Feature-flagged behind ARC_LIVE.
 */
export const ARC_CHAIN_ID = 5042;
export type ArcChainId = typeof ARC_CHAIN_ID;

/** Type guard for the Arc chain id. */
export function isArcChainId(value: unknown): value is ArcChainId {
  return value === ARC_CHAIN_ID;
}

/**
 * Gnosis Chain id. Native gas is xDAI. Xochi lists a single token here,
 * Monerium EURe (18 dec, no ERC-3009, Permit2 pull); there is no WETH or USDC
 * leg. Feature-flagged in the UI behind GNOSIS_LIVE.
 */
export const GNOSIS_CHAIN_ID = 100;
export type GnosisChainId = typeof GNOSIS_CHAIN_ID;

/** Type guard for the Gnosis Chain id. */
export function isGnosisChainId(value: unknown): value is GnosisChainId {
  return value === GNOSIS_CHAIN_ID;
}

/**
 * Slug -> chain id, derived from the registry, plus the Aztec virtual chain
 * (0), which has no registry entry because it is not an EVM chain.
 */
type ChainIdsBySlug = { readonly [K in ChainSlug]: (typeof CHAIN_REGISTRY)[K]["id"] } & {
  readonly aztec: AztecChainId;
};

/** Per-slug ids. Same assertion rationale as `byChainId`: `Object.fromEntries`
 * erases the key/value correlation that the mapped type expresses. */
const CHAIN_IDS_BY_SLUG = Object.fromEntries(
  Object.entries(CHAIN_REGISTRY).map(([slug, chain]) => [slug, chain.id]),
) as { readonly [K in ChainSlug]: (typeof CHAIN_REGISTRY)[K]["id"] };

/** All supported chain IDs */
export const CHAIN_IDS: ChainIdsBySlug = {
  ...CHAIN_IDS_BY_SLUG,
  aztec: 0,
};

/** Chain names for display */
export const CHAIN_NAMES: Record<ChainId, string> = byChainId((chain) => chain.name);

/**
 * Short chain names for compact display. Keyed by `SelectableChainId` so the
 * non-EVM Tron destination (base58) has a short name too -- the tx-link/name
 * helpers in the trade result surfaces index this with a destination chain id
 * that can be Tron.
 */
export const CHAIN_SHORT_NAMES: Record<SelectableChainId, string> = {
  ...byChainId((chain) => chain.shortName),
  [TRON_CHAIN_ID]: TRON_SHORT_NAME,
};

/**
 * Block explorer origins by chain (no trailing path). Single source of truth --
 * build tx/address URLs through the helpers below so links always target the
 * right chain (the old per-component maps drifted and one hardcoded Arbiscan).
 */
export const CHAIN_EXPLORERS: Record<ChainId, string> = byChainId((chain) => chain.explorer);

/**
 * Native currency symbol per chain. Used for gas display (QuoteDetails) and
 * balance labels (usePublicBalances). Most chains use ETH; Polygon uses POL,
 * Arc uses USDC (native gas token on Circle's stablecoin L1).
 * Derived from `CHAIN_REGISTRY.nativeCurrency`, defaulting to "ETH".
 */
export const CHAIN_NATIVE_CURRENCY: Record<ChainId, string> = byChainId(
  (chain) => chain.nativeCurrency ?? "ETH",
);

/**
 * Tronscan uses a `#/` hash route (not the `/tx/` path shape of the EVM
 * explorers), so Tron links are built separately from `CHAIN_EXPLORERS`.
 */
export const TRON_EXPLORER = "https://tronscan.org";

/**
 * Build a transaction URL on the given chain's explorer (empty if unknown).
 * Accepts a `SelectableChainId` so a Tron destination fill can be linked; Tron
 * routes to tronscan's hash-route form.
 */
export function getExplorerTxUrl(chainId: SelectableChainId, txHash: string): string {
  if (isTronChainId(chainId)) return `${TRON_EXPLORER}/#/transaction/${txHash}`;
  const base = CHAIN_EXPLORERS[chainId];
  return base ? `${base}/tx/${txHash}` : "";
}

/** Build an address URL on the given chain's explorer (empty if unknown). */
export function getExplorerAddressUrl(chainId: SelectableChainId, address: string): string {
  if (isTronChainId(chainId)) return `${TRON_EXPLORER}/#/address/${address}`;
  const base = CHAIN_EXPLORERS[chainId];
  return base ? `${base}/address/${address}` : "";
}

/**
 * Extended chain names including the Aztec source + non-EVM destinations. The
 * Aztec virtual chain is branded "Xochi" in the UI, which is why its display
 * name is not simply a chain name.
 */
export const EXTENDED_CHAIN_NAMES: Record<ExtendedChainId, string> = {
  ...CHAIN_NAMES,
  0: "Xochi",
  [TRON_CHAIN_ID]: TRON_CHAIN_NAME,
};

/** Supported chain IDs as array */
export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = CHAIN_LIST.map((chain) => chain.id);

/** Type guard for ChainId */
export function isChainId(value: unknown): value is ChainId {
  return typeof value === "number" && SUPPORTED_CHAIN_IDS.includes(value as ChainId);
}

/**
 * A chain id the solver can settle; equals `ChainId` (Robinhood is a first-class chain). The
 * name is kept for the intent-API call sites (schema validation) that document the settleable
 * surface explicitly, mirroring xochi's `@xochi/shared`.
 */
export type SettleableChainId = ChainId | RobinhoodChainId;

/**
 * Chain ids the solver can settle to or from; exactly `SUPPORTED_CHAIN_IDS`. The intent API
 * (`/api/intent/quote` and `/api/intent/execute`) validates request chain ids against this set.
 * Token addresses ride in the request body, so the API needs no per-chain token config to
 * accept a corridor; the solver decides feasibility.
 */
export const SETTLEABLE_CHAIN_IDS: readonly SettleableChainId[] = SUPPORTED_CHAIN_IDS;

/** Type guard for a settleable chain id (any supported chain, including Robinhood). */
export function isSettleableChainId(value: unknown): value is SettleableChainId {
  return typeof value === "number" && SETTLEABLE_CHAIN_IDS.includes(value as SettleableChainId);
}

/** Type guard for ExtendedChainId (EVM chains + Aztec source + Tron destination). */
export function isExtendedChainId(value: unknown): value is ExtendedChainId {
  return (
    typeof value === "number" &&
    (value === 0 || value === TRON_CHAIN_ID || SUPPORTED_CHAIN_IDS.includes(value as ChainId))
  );
}

/** Check if route between chains is supported */
export function isRouteSupported(from: ChainId, to: ChainId): boolean {
  return isChainId(from) && isChainId(to);
}
