// Canton destinations (SPEC.md §3.3, ESCROW-RFC.md §7.1). Canton is destination-only and is
// reached through its Riddler synthetic chain id, never through any facade's id: the Metatarz
// gateway's facade chain ids (31337 MainNet, 30337 testnet) name a gateway's EVM-shaped API,
// not the Canton network, and 31337 is also every local anvil node.

/** Canton MainNet's Riddler synthetic chain id (SPEC.md §3.3). */
export const CANTON_MAINNET_CHAIN_ID = 253_340_876;
/** Canton TestNet's Riddler synthetic chain id; above 2^31, so never an int32. */
export const CANTON_TESTNET_CHAIN_ID = 4_149_314_359;

/** The Metatarz facade chain ids. Never Canton's chain id; refused wherever Canton is meant. */
export const CANTON_FACADE_CHAIN_IDS: readonly number[] = [31_337, 30_337];

/** Canton Coin's instrument id on MainNet (the DSO party), case-sensitive. */
export const CANTON_COIN_MAINNET =
  "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
/** Canton Coin's instrument id on TestNet; refused on MainNet and vice versa. */
export const CANTON_COIN_TESTNET =
  "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337";

/**
 * The instruments a Canton destination may name as `to_token`, per Canton chain id. Canton Coin
 * only today. A registry instrument (cBTC) is added as a further entry for its network, with its
 * own encoding once SPEC.md defines it ([PROPOSED], ESCROW-RFC.md §7.1).
 */
export const CANTON_INSTRUMENTS: Readonly<Record<number, readonly string[]>> = {
  [CANTON_MAINNET_CHAIN_ID]: [CANTON_COIN_MAINNET],
  [CANTON_TESTNET_CHAIN_ID]: [CANTON_COIN_TESTNET],
};

/**
 * A party id `hint::1220<64 lowercase hex>` (SPEC.md §3.3). The hint is free text
 * (`[A-Za-z0-9:_-]+`) and may begin `0x`; a party id is never case-folded.
 */
export const CANTON_PARTY_ID = /^[A-Za-z0-9:_-]+::1220[0-9a-f]{64}$/;

export function isCantonPartyId(value: unknown): value is string {
  return typeof value === "string" && CANTON_PARTY_ID.test(value);
}

/** Whether `chainId` (a number or a base-10 string) is a Canton synthetic chain id. */
export function isCantonChainId(chainId: unknown): boolean {
  const id = chainIdNumber(chainId);
  return id !== null && Object.hasOwn(CANTON_INSTRUMENTS, id);
}

function chainIdNumber(chainId: unknown): number | null {
  if (typeof chainId === "number") return Number.isSafeInteger(chainId) ? chainId : null;
  if (typeof chainId === "string" && /^[0-9]+$/.test(chainId.trim())) {
    const n = Number(chainId.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export interface CantonDestination {
  toChainId: unknown;
  recipient: unknown;
  toToken: unknown;
}

/**
 * Refuses a destination that names Canton any way but the one SPEC.md §3.3 serves: a Canton
 * chain id with a party recipient and that network's instrument. A party id or a Canton
 * instrument on any other chain id refuses, and a facade chain id (31337, 30337) is named as
 * such. A destination that names Canton nowhere passes untouched. `fail` builds the error the
 * caller throws.
 */
export function assertCantonDestination(
  d: CantonDestination,
  fail: (message: string) => Error,
): void {
  const id = chainIdNumber(d.toChainId);
  const party = isCantonPartyId(d.recipient);
  const instrument = Object.values(CANTON_INSTRUMENTS).some((list) =>
    list.includes(d.toToken as string),
  );
  if (id !== null && Object.hasOwn(CANTON_INSTRUMENTS, id)) {
    if (!party) {
      throw fail(
        `Canton destination ${id} needs a party recipient (hint::1220<64 hex>), got ${JSON.stringify(d.recipient)}`,
      );
    }
    if (!CANTON_INSTRUMENTS[id]!.includes(d.toToken as string)) {
      throw fail(
        `${JSON.stringify(d.toToken)} is not an instrument this SDK delivers on Canton chain ${id}`,
      );
    }
    return;
  }
  if (!party && !instrument) return;
  if (id !== null && CANTON_FACADE_CHAIN_IDS.includes(id)) {
    throw fail(
      `chain ${id} is a Canton gateway facade id, never Canton's chain id; Canton MainNet is ` +
        `${CANTON_MAINNET_CHAIN_ID}`,
    );
  }
  throw fail(
    `a Canton party or instrument on chain ${JSON.stringify(d.toChainId)}, which is not a Canton ` +
      "chain id; refusing",
  );
}
