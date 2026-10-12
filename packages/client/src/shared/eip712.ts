/**
 * EIP-712 Types and Builders
 *
 * Typed data shapes served for signing, and the origin-pull amount reader.
 */

// ============================================================
// EIP-712 Type Definitions
// ============================================================

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  /**
   * Present on Xochi-owned structs (Intent/LimitOrder/Mandate) and token-pull
   * domains (ERC-3009/Permit2). The Riddler-served XochiIntent v3 domain omits
   * it in favor of `salt`, so it is optional -- never assume it is set.
   */
  verifyingContract?: string;
  /**
   * Present on the Riddler-served XochiIntent v3 domain (keccak256(version));
   * absent on verifyingContract-based domains. Part of the signed domain
   * separator, so it must reach the signer verbatim.
   */
  salt?: string;
}

export interface Eip712TypeField {
  name: string;
  type: string;
}

export interface Eip712TypedData<T = Record<string, unknown>> {
  domain: Eip712Domain;
  types: Record<string, Eip712TypeField[]>;
  primaryType: string;
  message: T;
}

// ============================================================
// Origin-pull amount extraction
// ============================================================

/**
 * Origin-pull primaryTypes that carry the collected amount. ERC-3009
 * (ReceiveWithAuthorization / TransferWithAuthorization) carries it top-level as
 * `value`; Permit2 (PermitWitnessTransferFrom) as `permitted.amount`. Mirrors the
 * set the solver pin recognizes.
 */
const ERC3009_PULL_TYPES: ReadonlySet<string> = new Set([
  "ReceiveWithAuthorization",
  "TransferWithAuthorization",
]);
const PERMIT2_PULL_TYPE = "PermitWitnessTransferFrom";

/** Coerce a typed-data uint256 (decimal string / number / bigint) to bigint, or null. */
function coercePullAmount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extract the origin-token amount (smallest units) a served origin-pull
 * authorization would collect. ERC-3009 carries it as `value`; Permit2 as
 * `permitted.amount`. Returns null for an unrecognized type or a
 * missing/unparseable amount so callers fail closed.
 *
 * The pulled amount is what the user's signature authorizes on-chain (ERC-3009
 * moves exactly `value`; Permit2 caps at `permitted.amount`), so binding it to
 * the intended input amount is the origin leg's value guard (#170; see
 * solverPin).
 */
export function extractPullAmount(pull: Eip712TypedData): bigint | null {
  const message = pull.message as Record<string, unknown> | undefined;
  if (!message) return null;

  if (ERC3009_PULL_TYPES.has(pull.primaryType)) {
    return coercePullAmount(message.value);
  }
  if (pull.primaryType === PERMIT2_PULL_TYPE) {
    const permitted = message.permitted as Record<string, unknown> | undefined;
    return permitted ? coercePullAmount(permitted.amount) : null;
  }
  return null;
}

// ============================================================
// Intent EIP-712 (XochiIntent v3)
