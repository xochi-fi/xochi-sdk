import { ethers } from "ethers";
import { ERC3009_TYPES, PERMIT2_TYPES } from "./signing";
import type { Eip712Signable, Eip712TypeField } from "./types";

const DEBUG = !!process.env.DEBUG;
function debug(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// Must stay byte-for-byte aligned with Riddler.Integrations.Xochi.EIP712.type_definitions/0
// (domain version "3"). v1->v2 added `recipient`; v2->v3 retyped fromToken/toToken
// from `address` to `string` so a cross-VM (base58) token survives EIP-712 encoding.
// There is no `nonce` in the signed struct -- per-wallet replay is enforced by
// intent_id atomicity server-side. The live flow signs the server-returned
// quote.eip712 (which carries the deployment-scoped domain + salt); this constant
// is the server-parity reference used by the conformance generator.
export const XOCHI_TYPES: Record<string, Eip712TypeField[]> = {
  XochiIntent: [
    { name: "intentId", type: "string" },
    { name: "quoteId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "recipient", type: "string" },
    { name: "fromChainId", type: "uint256" },
    { name: "toChainId", type: "uint256" },
    { name: "fromToken", type: "string" },
    { name: "toToken", type: "string" },
    { name: "fromAmount", type: "uint256" },
    { name: "toAmount", type: "uint256" },
    { name: "settlementPreference", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
};

/** A complete EIP-712 message schema: every type the struct references, keyed by name. */
export type Eip712Schema = Record<string, Eip712TypeField[]>;

/**
 * The two origin-pull authorizations a quote can legitimately ask for. Anything
 * else presented as a `pull_authorization` is not a pull authorization.
 */
export const PULL_AUTHORIZATION_SCHEMAS: Eip712Schema[] = [
  { ReceiveWithAuthorization: ERC3009_TYPES.ReceiveWithAuthorization! },
  {
    PermitWitnessTransferFrom: PERMIT2_TYPES.PermitWitnessTransferFrom!,
    TokenPermissions: PERMIT2_TYPES.TokenPermissions!,
    OriginPullWitness: PERMIT2_TYPES.OriginPullWitness!,
  },
];

function sameFieldList(a: Eip712TypeField[], b: Eip712TypeField[]): boolean {
  return a.length === b.length && a.every((f, i) => f.name === b[i]!.name && f.type === b[i]!.type);
}

function matchesSchema(messageTypes: Eip712Schema, schema: Eip712Schema): boolean {
  const got = Object.keys(messageTypes).sort();
  const want = Object.keys(schema).sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) return false;
  return want.every((k) => sameFieldList(messageTypes[k]!, schema[k]!));
}

/** Renders a types map as `Type(field: type, ...)` for error messages. */
function describeSchema(schema: Eip712Schema): string {
  return Object.keys(schema)
    .sort()
    .map((k) => `${k}(${schema[k]!.map((f) => `${f.name}: ${f.type}`).join(", ")})`)
    .join(" ");
}

/**
 * Refuses to sign a struct whose shape is not one this SDK recognises.
 *
 * Without this, a `signable` sourced from an HTTP response is an unconstrained
 * signing oracle: the caller's key signs whatever type list the server sends,
 * including a token approval or a permit for an unrelated contract, bounded only
 * by what that key can authorise anywhere on any chain.
 *
 * The check is exact -- same type names, same fields, same order -- and it never
 * mutates. `signable` reaches `signTypedData` byte-identical either way, which is
 * the invariant `types.ts` protects; validating and transforming are different
 * things and only the second one can change a digest.
 */
export function assertKnownSchema(
  messageTypes: Eip712Schema,
  allowed: Eip712Schema[],
  label: string,
): void {
  if (Object.keys(messageTypes).length === 0) {
    throw new Error(`${label}: signable has no message type (only EIP712Domain)`);
  }
  if (allowed.some((schema) => matchesSchema(messageTypes, schema))) return;

  throw new Error(
    `${label}: refusing to sign an unrecognised EIP-712 schema.\n` +
      `  got:      ${describeSchema(messageTypes)}\n` +
      allowed.map((s) => `  expected: ${describeSchema(s)}`).join("\n") +
      "\nA server-supplied signable that does not match a pinned schema is not a " +
      "protocol upgrade to sign through -- it is the shape of a signing-oracle attack. " +
      "If the wire format genuinely changed, update the pinned schema in lockstep with the server.",
  );
}

// Sign an EIP-712 struct served by the quote (domain, types, message). ethers
// derives the domain hash from `domain`, so the types map passed to signTypedData
// must omit EIP712Domain; the remaining types describe the message and ethers
// infers the primary type. `allowedSchemas` pins which shapes are acceptable --
// see assertKnownSchema for why signing an arbitrary server-supplied schema is
// not a thing this SDK does.
async function signStruct(
  signable: Eip712Signable,
  privateKeyHex: string,
  allowedSchemas: Eip712Schema[],
  label: string,
): Promise<string> {
  const wallet = new ethers.Wallet(privateKeyHex);

  const { EIP712Domain: _EIP712Domain, ...messageTypes } = (signable && signable.types) || {};

  assertKnownSchema(messageTypes, allowedSchemas, label);

  if (DEBUG) {
    debug("   Domain:", JSON.stringify(signable.domain));
    debug("   Message:", JSON.stringify(signable.message));
    try {
      const digest = ethers.TypedDataEncoder.hash(signable.domain, messageTypes, signable.message);
      debug(`   EIP-712 digest: ${digest}`);
    } catch (e) {
      debug(`   Could not compute digest: ${(e as Error).message}`);
    }
  }

  const signature = await wallet.signTypedData(signable.domain, messageTypes, signable.message);
  debug(`   Signature: ${signature.substring(0, 20)}...`);
  return signature;
}

export interface SignXochiIntentOptions {
  /**
   * Schemas this call will sign. Defaults to the server-parity `XOCHI_TYPES`.
   *
   * Pass an explicit list when signing a deliberately different XochiIntent
   * dialect -- the ACP buyer-auth in `acp.ts` signs `XOCHI_ACP_TYPES`, which has
   * a `nonce`, no `recipient`, and `address`-typed tokens. The two lists stay
   * separate on purpose; this option is how a caller declares which one it means
   * rather than the signer accepting both from anyone.
   */
  allowedTypes?: Eip712Schema[];
}

/**
 * Signs a XochiIntent.
 *
 * The schema is checked against `XOCHI_TYPES` unless the caller says otherwise.
 * That makes the pinned constant load-bearing at runtime rather than only in the
 * conformance generator: a server that changes the intent's field list can no
 * longer have this client sign the new shape sight-unseen. The trade is real --
 * a genuine wire change now needs a client release rather than being transparent
 * -- and it is the intended one, matching how every other wire contract in this
 * repo is versioned.
 *
 * Shape is all this checks. Whether the *values* are the ones you asked for is a
 * separate question, answered by `assertIntentMatchesRequest` in the taker SDK,
 * which is the layer that knows what was requested.
 */
export async function signXochiIntent(
  eip712: Eip712Signable,
  privateKeyHex: string,
  opts: SignXochiIntentOptions = {},
): Promise<string> {
  return signStruct(eip712, privateKeyHex, opts.allowedTypes ?? [XOCHI_TYPES], "signXochiIntent");
}

// Sign the origin-pull authorization the quote returns as `pull_authorization`:
// ERC-3009 ReceiveWithAuthorization (USDC) or Permit2 PermitWitnessTransferFrom
// (other ERC-20s). Riddler recovers this against the stored authorization before
// collecting origin funds, so /xochi/execute needs it as `pull_signature` --
// without it the request stops at the pull-signature gate.
//
// Constrained to the two real pull shapes. This call previously passed no
// expected type at all, so any typed-data struct a quote carried under
// `pull_authorization` was signed: an ERC-20 `Permit` for max-uint to an
// arbitrary spender is a valid EIP-712 struct, and nothing here would have told
// it apart from a USDC receive authorization. That put every token the key holds
// on every chain inside the blast radius of one quote response, not just the
// corridor being quoted.
export async function signPullAuthorization(
  pullAuthorization: Eip712Signable,
  privateKeyHex: string,
): Promise<string> {
  return signStruct(
    pullAuthorization,
    privateKeyHex,
    PULL_AUTHORIZATION_SCHEMAS,
    "signPullAuthorization",
  );
}
