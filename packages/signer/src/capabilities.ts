/**
 * Client model for `GET /xochi/capabilities`, the solver's machine-readable
 * capability matrix. The wire shape is Riddler's
 * `Xochi.Config.capability_matrix/0`, the authoritative side. Nothing here signs
 * anything; it lets a client stop hardcoding which chains are live, which token
 * uses which pull method, how far a pull's expiry may outlive the intent, and
 * which address receives an origin pull.
 *
 * **Not a trust anchor.** Capabilities arrive over the same channel as the quote,
 * so whoever can substitute a quote can substitute the matrix that "validates"
 * it -- the mistake `xochiDepositQuote` refuses by no longer defaulting
 * `attestationSigner` to a capabilities fetch. Every accessor answers *what did
 * the server say*, which is safe for anything that fails closed on its own:
 * picking a pull method, sizing an order, rendering a route list.
 *
 * So nothing here is named `assert*`, `verify*` or `check*`. A removed
 * `assertMatchesPinnedRecipients` is why, and do not re-introduce it: it compared
 * a caller's pin against the *advertisement*, which is not an input to any
 * signing path (`assertPullMatchesIntent` is where a pull's `to`/`spender` is
 * held to something), and it skipped when the advertised side was absent, so
 * omitting the field passed silently. Riddler legitimately omits a chain whose
 * solver address does not resolve, so honest-absent and hostile-absent are the
 * same bytes and only the caller can decide. `pullRecipients` is still parsed as
 * discovery data.
 *
 * Parsing is tolerant (unknown keys dropped, absent optionals conservative, an
 * unusable payload `null` rather than a throw) because a client that hard-failed
 * on an unrecognised field would break every time the solver added one. That is
 * also why nothing here may *relax* a check. It can only inform one.
 */

/**
 * Virtual machine family a chain runs. Decides address encoding and pull method.
 * `cvm` is Canton: a destination-only chain whose addresses are party ids.
 */
export type VmType = "evm" | "tvm" | "svm" | "cvm";

/**
 * Address encoding for a VM family. `hex20` is EVM; the base58 pair is not
 * interchangeable; `canton_party` is `hint::1220<64 lowercase hex>`, case-sensitive
 * with a free-text hint, so it is never case-folded even when the hint starts `0x`.
 */
export type AddressFormat = "hex20" | "base58check" | "base58" | "canton_party";

/** How the solver takes origin funds. `deposit_address` is the non-EVM path (no gasless pull). */
export type PullMethod = "erc3009" | "permit2" | "deposit_address";

export interface ChainCapability {
  chainId: number;
  chainName: string;
  /**
   * `null` when the server named a VM this client does not recognise. The row is kept
   * rather than dropped so a duplicate chain id is still seen as one, but nothing may
   * address the chain: an unknown VM is not EVM. See {@link unrecognisedVmType}.
   */
  vmType: VmType | null;
  /** `null` exactly when {@link vmType} is: a format read off an unknown VM is a guess. */
  addressFormat: AddressFormat | null;
  /** The served `vm_type` spelling when it was not recognised, else `null`. */
  unrecognisedVmType: string | null;
  /**
   * Per-chain floor a *stealth* order must clear so its fee covers the sponsored
   * ERC-4337 claim leg; L1 is materially higher than L2s. `null` when the server
   * could not price it, or on a non-EVM chain with no 4337 claim.
   */
  minStealthNotionalUsd: number | null;
}

export interface TokenChainPull {
  method: PullMethod;
  gaslessOrigin: boolean;
}

export interface TokenCapability {
  symbol: string;
  decimals: number | null;
  /**
   * The EVM-representative pull method. Prefer `originPullMethod`, which reads the
   * per-chain map: one token is `erc3009` on Base, `deposit_address` on Tron.
   */
  pullMethod: PullMethod | null;
  gaslessOrigin: boolean;
  /** `["origin"]` or `["origin", "destination"]`. */
  roles: readonly string[];
  /** chainId -> token address. Base58 verbatim on non-EVM chains. */
  addresses: Readonly<Record<number, string>>;
  /** chainId -> the real method for that chain. Additive; prefer it over `pullMethod`. */
  pullMethods: Readonly<Record<number, TokenChainPull>>;
}

/** Who receives an origin pull on one chain, per method. */
export interface PullRecipients {
  erc3009: string | null;
  permit2: string | null;
}

export interface SolverCapabilities {
  crossChainOnly: boolean;
  /** `@xochi/spec` version the server implements, for gating on the layered fee model. */
  specVersion: string | null;
  orderBoundsUsd: { min: number | null; max: number | null };

  /** Pinned signer for deposit-route attestations. Discovery only -- see the module header. */
  depositAttestationSigner: string | null;
  /**
   * The attestation message version the server SIGNS, from its code constant
   * (Riddler#877). `null` on a server that predates the field. Compare it against
   * the client's own constant with {@link depositAttestationVersionSkew}.
   */
  depositAttestationVersion: string | null;
  /** Where the server publishes its conformance vectors, and the SHA-256 of those exact bytes. */
  depositAttestationVectorsUrl: string | null;
  depositAttestationVectorsSha256: string | null;

  /**
   * chainId -> {erc3009, permit2}: who the solver SAYS receives an origin pull,
   * the part of a pull authorization that moves the money (Riddler#848).
   * Advertised is not verified and this module ships no helper that pretends
   * otherwise. A chain is legitimately absent when its solver address does not
   * resolve, so absence is not evidence.
   */
  pullRecipients: Readonly<Record<number, PullRecipients>>;
  /**
   * How far the on-chain pull expiry may outlive the signed intent deadline.
   * Operator-tunable server-side (`1500` before `300`, Riddler#789 §B), which is
   * why the SDK's own `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` is a loose sanity
   * ceiling and not a parity constant. Fed to `pullExpiryBoundSeconds` (or
   * `advertisedPullDeadlineBufferSeconds` on the quote params) the enforced bound
   * is the tighter of the two, so the server can shrink its own window and never
   * widen it. `null` leaves the local ceiling in force.
   */
  pullDeadlineBufferSeconds: number | null;
  /** SimpleAccount factory owning stealth counterfactual accounts. */
  stealthFactoryAddress: string | null;

  chains: readonly ChainCapability[];
  tokens: readonly TokenCapability[];
  /**
   * Mover-backed corridors with per-corridor bounds. **Not a routability gate:**
   * the quote path gates on the advertised chain set, never on this list, and a
   * deposit-address route is quotable and fills without appearing here, so
   * pre-declining an absent pair turns away routes the solver serves
   * (Riddler#834). Use it to size a move, not to decide whether one is possible.
   */
  corridors: readonly Record<string, unknown>[];
  /** Allowlisted cross-token fill pairs. Empty when conversion is off. */
  conversionPairs: readonly Record<string, unknown>[];

  raw: Record<string, unknown>;
}

export class CapabilitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilitiesError";
  }
}

/** The address encoding a VM family uses. */
export function addressFormatForVm(vmType: VmType): AddressFormat {
  if (vmType === "tvm") return "base58check";
  if (vmType === "svm") return "base58";
  if (vmType === "cvm") return "canton_party";
  return "hex20";
}

const VM_TYPES: readonly string[] = ["evm", "tvm", "svm", "cvm"];
const ADDRESS_FORMATS: readonly string[] = ["hex20", "base58check", "base58", "canton_party"];
const PULL_METHODS: readonly string[] = ["erc3009", "permit2", "deposit_address"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A finite number, or `null`. Numeric strings are accepted because JSON encoders
 * differ on large integers; `NaN`/`Infinity` are not, since they compare false
 * against everything and would disable a bound instead of reporting it unusable.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asNonNegativeInteger(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * A chain id, from a value or an object key. One predicate for both: while they
 * differed, `"0x2105"` became chain 8453 in `chains[]` and was dropped from
 * `addresses`, one spelling with two verdicts.
 *
 * Canonical decimal only. `/^\d+$/` alone accepts `"08453"`, which `Number()`
 * collapses onto `8453`; JS iterates integer-like keys first and string keys
 * after, so the padded duplicate is written LAST and deterministically wins,
 * letting a server shadow any chain's address, pull method and recipient.
 */
function asChainIdValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Assigns into a chain-keyed map, refusing a duplicate rather than letting the
 * later entry win. Two spellings of one chain id is not honestly producible, so
 * the safe reading is "malformed", not "the second one".
 */
function setChainKey<T>(out: Record<number, T>, chainId: number, value: T): void {
  if (Object.prototype.hasOwnProperty.call(out, chainId)) return;
  out[chainId] = value;
}

function asVmType(value: unknown): VmType | null {
  // Absent means EVM: `vm_type` postdates the endpoint and every chain that
  // existed before it was EVM, so treating absent as unknown would strand them.
  if (value === undefined || value === null) return "evm";
  // PRESENT but unrecognised is not absent. It used to read as "evm" too, so the
  // first served `cvm` (Canton, spec 0.8.0) parsed as an EVM chain with format
  // `hex20`, and a Canton party id was one caller away from an EVM address helper.
  // A VM this parser does not know is a chain it cannot address.
  const s = asString(value);
  return s !== null && VM_TYPES.includes(s) ? (s as VmType) : null;
}

function asAddressFormat(value: unknown): AddressFormat | null {
  const v = asString(value);
  return v !== null && ADDRESS_FORMATS.includes(v) ? (v as AddressFormat) : null;
}

/** An EVM address by SHAPE. Casing is not checked -- see erc4337.ts's `toAddress`. */
function asEvmAddress(value: unknown): string | null {
  const v = asString(value);
  return v !== null && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

function asPullMethod(value: unknown): PullMethod | null {
  const s = asString(value);
  return s !== null && PULL_METHODS.includes(s) ? (s as PullMethod) : null;
}

function parseChain(raw: unknown): ChainCapability | null {
  const r = asRecord(raw);
  if (!r) return null;
  const chainId = asChainIdValue(r.chain_id);
  if (chainId === null) return null; // a chain we cannot address is not a capability

  const chainName = asString(r.chain_name) ?? String(chainId);
  const minStealthNotionalUsd = asNumber(r.min_stealth_notional_usd);
  const vmType = asVmType(r.vm_type);
  if (vmType === null) {
    // Kept, not dropped: dropping it before `chainCapability`'s duplicate check let
    // `[{id, evm}, {id, tvm2}]` read as a lone EVM chain, the shadowing that check
    // exists to refuse. Unaddressable all the same; see asVmType.
    const served = r.vm_type;
    return {
      chainId,
      chainName,
      vmType: null,
      addressFormat: null,
      unrecognisedVmType: typeof served === "string" ? served : JSON.stringify(served),
      minStealthNotionalUsd,
    };
  }
  return {
    chainId,
    chainName,
    vmType,
    // Prefer the served format, falling back to the VM's own rather than hex20.
    // Whitelisted, not cast: an unchecked `as` let a server label a TVM chain
    // `hex20`, or emit a format that type-checks as `AddressFormat` and matches
    // no branch of an exhaustive switch. Either ends with a base58 address in an
    // EVM address helper.
    addressFormat: asAddressFormat(r.address_format) ?? addressFormatForVm(vmType),
    unrecognisedVmType: null,
    minStealthNotionalUsd,
  };
}

function parseAddresses(raw: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  const r = asRecord(raw);
  if (!r) return out;
  for (const [key, value] of Object.entries(r)) {
    const chainId = asChainIdValue(key);
    const address = asString(value);
    // Verbatim: a base58 token address is case-sensitive and must never be folded.
    if (chainId !== null && address !== null) setChainKey(out, chainId, address);
  }
  return out;
}

function parseTokenPullMethods(raw: unknown): Record<number, TokenChainPull> {
  const out: Record<number, TokenChainPull> = {};
  const r = asRecord(raw);
  if (!r) return out;
  for (const [key, value] of Object.entries(r)) {
    const chainId = asChainIdValue(key);
    const entry = asRecord(value);
    if (chainId === null || !entry) continue;
    const method = asPullMethod(entry.method);
    if (method === null) continue;
    setChainKey(out, chainId, { method, gaslessOrigin: entry.gasless_origin === true });
  }
  return out;
}

function parseToken(raw: unknown): TokenCapability | null {
  const r = asRecord(raw);
  if (!r) return null;
  const symbol = asString(r.symbol);
  if (symbol === null) return null;

  const roles = Array.isArray(r.roles)
    ? r.roles.filter((x): x is string => typeof x === "string")
    : [];

  return {
    symbol,
    decimals: asNumber(r.decimals),
    pullMethod: asPullMethod(r.pull_method),
    gaslessOrigin: (r.gasless_origin) === true,
    roles,
    addresses: parseAddresses(r.addresses),
    pullMethods: parseTokenPullMethods(r.pull_methods),
  };
}

function parsePullRecipients(raw: unknown): Record<number, PullRecipients> {
  const out: Record<number, PullRecipients> = {};
  const r = asRecord(raw);
  if (!r) return out;
  for (const [key, value] of Object.entries(r)) {
    const chainId = asChainIdValue(key);
    const entry = asRecord(value);
    if (chainId === null || !entry) continue;
    setChainKey(out, chainId, {
      erc3009: asEvmAddress(entry.erc3009),
      permit2: asEvmAddress(entry.permit2),
    });
  }
  return out;
}

function parseObjectList(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
}

/**
 * Parses a `/xochi/capabilities` body. Returns `null` only when the payload is
 * not an object; a body missing every field parses to an empty matrix. "The
 * server told us nothing" and "the server is unreachable" are not different
 * types, because a caller must handle them identically.
 */
export function parseCapabilities(raw: unknown): SolverCapabilities | null {
  const r = asRecord(raw);
  if (!r) return null;

  const bounds = asRecord(r.order_bounds_usd) ?? {};
  // A negative max makes every order "too large", the failure the absent case
  // was designed to avoid, reached by a hostile value instead of a default.
  const boundsMin = asNumber(bounds.min);
  const boundsMax = asNumber(bounds.max);

  return {
    // Restrictive on absence. `=== true` made a blank response mean "same-chain
    // fills are allowed", a caller-visible relaxation handed over by an empty body.
    // Riddler types the field as the literal `true`, so absence means "did not
    // say", and "did not say" must not widen.
    crossChainOnly: (r.cross_chain_only) !== false,
    specVersion: asString(r.spec_version),
    orderBoundsUsd: {
      min: boundsMin !== null && boundsMin >= 0 ? boundsMin : null,
      max: boundsMax !== null && boundsMax > 0 ? boundsMax : null,
    },

    depositAttestationSigner: asEvmAddress(r.deposit_attestation_signer),
    depositAttestationVersion: asString(r.deposit_attestation_version),
    depositAttestationVectorsUrl: asString(
      r.deposit_attestation_vectors_url,
    ),
    depositAttestationVectorsSha256: asString(
      r.deposit_attestation_vectors_sha256,
    ),

    pullRecipients: parsePullRecipients(r.pull_recipients),
    // `non_neg_integer()` server-side, so a negative or fractional value is not
    // honestly producible. A caller is tempted to substitute this for a local
    // ceiling, so an implausible one is dropped, not carried.
    pullDeadlineBufferSeconds: asNonNegativeInteger(r.pull_deadline_buffer_seconds),
    stealthFactoryAddress: asEvmAddress(r.stealth_factory_address),

    chains: (Array.isArray(r.chains) ? r.chains : [])
      .map(parseChain)
      .filter((x): x is ChainCapability => x !== null),
    tokens: (Array.isArray(r.tokens) ? r.tokens : [])
      .map(parseToken)
      .filter((x): x is TokenCapability => x !== null),
    corridors: parseObjectList(r.corridors),
    conversionPairs: parseObjectList(r.conversion_pairs),

    raw: r,
  };
}

/**
 * The chain entry for `chainId`, or `null` when unadvertised or duplicated. An entry
 * whose VM this client does not recognise is returned with `vmType: null`; every
 * accessor below reads that as unaddressable.
 */
export function chainCapability(
  caps: SolverCapabilities,
  chainId: number,
): ChainCapability | null {
  const matches = caps.chains.filter((c) => c.chainId === chainId);
  // A repeated chain id is malformed; `.find()` would take the first, letting a
  // prepended `{chain_id: 728126428, vm_type: "evm"}` shadow the real TVM entry.
  // Unknown-VM rows count: they are parsed, not dropped, for exactly this.
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * VM family for a chain, or `null` when unadvertised, duplicated, or advertised under a
 * VM this client does not recognise. Not defaulted to `evm`: "did not mention this
 * chain" and "this chain is EVM" are different facts, and collapsing them is one of the
 * ways a base58 address ends up in an EVM address helper.
 */
export function chainVmType(caps: SolverCapabilities, chainId: number): VmType | null {
  return chainCapability(caps, chainId)?.vmType ?? null;
}

/** Address encoding for a chain, or `null` on the same terms as {@link chainVmType}. */
export function chainAddressFormat(caps: SolverCapabilities, chainId: number): AddressFormat | null {
  return chainCapability(caps, chainId)?.addressFormat ?? null;
}

/** The token entry for a symbol, or `null` when unadvertised or duplicated. */
function tokenCapability(caps: SolverCapabilities, symbol: string): TokenCapability | null {
  const matches = caps.tokens.filter((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
  // Same reasoning as `chainCapability`: first-wins lets ordering decide which of
  // two `USDC` entries a caller gets.
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * The pull method for a token on a chain. Reads the per-chain map before the
 * token-level EVM representative, since taking the top-level value on a Tron
 * origin sends a client down a gasless path that chain has none of.
 */
export function originPullMethod(
  caps: SolverCapabilities,
  symbol: string,
  chainId: number,
): PullMethod | null {
  const token = tokenCapability(caps, symbol);
  if (!token) return null;
  if (!Number.isInteger(chainId)) return null;
  // A duplicated, unadvertised or unknown-VM chain has no pull method here: the
  // token-level fallback is an EVM representative and would name one for any chain.
  if (chainCapability(caps, chainId)?.vmType == null) return null;
  return token.pullMethods[chainId]?.method ?? token.pullMethod;
}

/**
 * The token address the SOLVER ADVERTISES for a symbol on a chain, verbatim.
 * Named `advertised` because `getTokenAddress` from `config.ts` sits in the same
 * barrel namespace and returns a pinned constant: opposite trust properties, and
 * the shorter name is the safe one. **Never use this as a signing input.**
 */
export function advertisedTokenAddress(
  caps: SolverCapabilities,
  symbol: string,
  chainId: number,
): string | null {
  const token = tokenCapability(caps, symbol);
  if (!token || !Number.isInteger(chainId)) return null;
  // Same rule as `originPullMethod`: no address for a chain this client cannot address.
  if (chainCapability(caps, chainId)?.vmType == null) return null;
  // hasOwnProperty, not `?.[]`: a JS caller passing "constructor" would otherwise
  // get a Function back from a signature typed `string | null`.
  return Object.prototype.hasOwnProperty.call(token.addresses, chainId)
    ? token.addresses[chainId]!
    : null;
}

/**
 * Reports a deposit-attestation version skew, or `null` when there is none. A
 * client one version behind fails closed on every deposit quote as `signer is not
 * the pinned solver`, which reads as an outage or a key rotation rather than a
 * client that needs upgrading (riddler-sdk#92). A server that does not publish
 * the field yields `null`: absence is not a skew, and this must not turn an old
 * deployment into an error.
 */
export function depositAttestationVersionSkew(
  caps: SolverCapabilities,
  pinnedVersion: string,
): string | null {
  const served = caps.depositAttestationVersion;
  if (!served || served === pinnedVersion) return null;
  return (
    `this client verifies ${pinnedVersion} but the solver signs ${served} -- every deposit-route ` +
    "quote will fail to verify, and it will look like a wrong signer rather than a version skew. " +
    "Upgrade the client (or the solver) so the two match."
  );
}

/**
 * Whether a notional falls outside the advertised TOP-LEVEL order bounds, as a
 * reason string or `null` when it fits. Necessary, not sufficient: Riddler's
 * `advertised_max_order_usd/0` is the largest per-token cap across the advertised
 * symbols, so a capped token or a per-corridor `max_usd` binds tighter. Passing
 * does not mean the solver will accept the order; failing means it will not. An
 * absent bound is unknown, not zero, so it is not enforced.
 */
export function orderBoundsViolation(
  caps: SolverCapabilities,
  notionalUsd: number,
): string | null {
  // NaN compares false against everything, so an unchecked notional (a missing
  // price feed, say) would report "fits".
  if (!Number.isFinite(notionalUsd)) {
    return `order notional ${notionalUsd} is not a finite number, so it cannot be bounds-checked`;
  }
  const { min, max } = caps.orderBoundsUsd;
  if (min !== null && notionalUsd < min) {
    return `order ${notionalUsd} USD is below the solver's advertised minimum of ${min} USD`;
  }
  if (max !== null && notionalUsd > max) {
    return `order ${notionalUsd} USD is above the solver's advertised maximum of ${max} USD`;
  }
  return null;
}

/**
 * The stealth notional floor for a chain, or `null` when unpriced. A stealth
 * order below it cannot cover its own sponsored claim leg, so the server will
 * decline the fill; checking first turns that refusal into a local one.
 */
export function stealthNotionalFloor(caps: SolverCapabilities, chainId: number): number | null {
  return chainCapability(caps, chainId)?.minStealthNotionalUsd ?? null;
}


/**
 * The static chain keys the venue actually serves right now.
 *
 * `CONFIG.CHAINS` is a compile-time table: it carries the things capabilities
 * cannot (RPC endpoints, ERC-3009 EIP-712 domain fields, base58 token
 * addresses), so it cannot be deleted. But it is the wrong answer to "what can
 * I quote", because two of its chains are flag-gated server-side (Riddler
 * `@flag_gated_chain_ids`: Tron behind `ENABLE_TRON`, Arc behind `ENABLE_ARC`)
 * and vanish from `/chains`, `/routes` and `/capabilities` while their flag is
 * off. A client that reads the table alone offers a route the venue answers
 * `route_unsupported` for; that drift has already produced two wrong chain
 * lists in this SDK (dead Tron testnets, missing Arc).
 *
 * So: the table supplies HOW to address a chain, the matrix supplies WHETHER.
 * Intersect them here rather than at each call site.
 *
 * Discovery data, not a check (see this module's header): it reports what the
 * server said. A caller that builds a route list, or wants to fail locally
 * instead of round-tripping, uses it; nothing signing-related may relax on it.
 */
export function servedChainKeys(
  caps: SolverCapabilities,
  chains: Record<string, { chainId: number }>,
): string[] {
  // Through `chainCapability`, so a duplicated id is unserved whatever VM its rows name:
  // a per-row filter kept `[{id, evm}, {id, <unknown VM>}]` as served. An unrecognised-VM
  // row is advertised but not addressable by this client.
  return Object.entries(chains)
    .filter(([, chain]) => chainCapability(caps, chain.chainId)?.vmType != null)
    .map(([key]) => key);
}

/**
 * Why a statically-known chain is not quotable right now, or `null` when it is.
 * Separates "the venue has this chain behind a flag" from "the venue has never
 * heard of it", because the remedies differ: wait for the flip vs fix the id.
 */
export function chainUnservedReason(
  caps: SolverCapabilities,
  chain: { chainId: number; name: string; flagGated?: string },
): string | null {
  const matches = caps.chains.filter((c) => c.chainId === chain.chainId);
  if (matches.length > 1) {
    return (
      `${chain.name} (${chain.chainId}) is advertised ${matches.length} times by this venue's ` +
      "/xochi/capabilities, so this client reads the entry as malformed and uses none of them"
    );
  }
  const only = matches[0];
  if (only?.vmType === null) {
    return (
      `${chain.name} (${chain.chainId}) is advertised with vm_type ${only.unrecognisedVmType}, which this ` +
      "client does not recognise; upgrade the SDK"
    );
  }
  if (only) return null;
  return chain.flagGated
    ? `${chain.name} (${chain.chainId}) is not advertised: the venue gates it behind ${chain.flagGated}, ` +
        "so it is addressable but not quotable until that flag is on"
    : `${chain.name} (${chain.chainId}) is not advertised by this venue's /xochi/capabilities`;
}
