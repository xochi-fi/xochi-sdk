// Non-custodial escrow primitives, order v2. RESERVED / INERT at this SPEC
// version: these compute the blinded destination commitment, the canonical
// `orderId = keccak(OrderTerms)`, the venue's OpenAuth digest, and assert the
// escrow pull-auth binding, but NOTHING here is wired into the live signing path
// (signERC3009 / signPermit2 still take orderId from `quote.gasless.orderId`).
// See @xochi/spec ESCROW-RFC.md §2/§7/§12 and SPEC.md §2.3/§5.2.
//
// Every hash is keccak256 over standard (never packed) `abi.encode` of a flat
// argument list, reproducible in Solidity and Elixir byte-for-byte.

import { ethers } from "ethers";
import type { Hex } from "./types";
import { resolvePinnedEscrow } from "./escrow-pin";

type UintLike = bigint | number | string;

// The destination side of an order. Never on-chain in the clear: only its
// commitment is (ESCROW-RFC §2.2). `recipient`/`toToken` are strings so a
// cross-VM value (base58 Tron, Canton party, symbol) survives.
export interface DestOpening {
  recipient: string;
  toToken: string;
  toAmount: UintLike;
  blinding: string; // bytes32, non-zero
  intentId: string; // non-empty
}

// The origin-side terms the escrow locks under (ESCROW-RFC §2.3).
export interface OrderTerms {
  depositor: string; // address
  fromChainId: UintLike;
  fromToken: string; // address
  fromAmount: UintLike;
  toChainId: UintLike;
  fillDeadline: UintLike;
  escrow: string; // address
  destCommitment: string; // bytes32
}

// EIP-712 domain of the RiddlerEscrow that verifies an OpenAuth.
export interface OpenAuthDomain {
  chainId: UintLike; // origin chain
  verifyingContract: string; // escrow
}

export const DEST_TYPEHASH = ethers.id(
  "RiddlerDestCommitment(bytes32 recipientKey,bytes32 toTokenKey,uint256 toAmount,bytes32 blinding,bytes32 intentIdHash)",
) as Hex;

export const ORDER_TYPEHASH = ethers.id(
  "RiddlerOrder(address depositor,uint256 fromChainId,address fromToken,uint256 fromAmount,uint256 toChainId,uint256 fillDeadline,address escrow,bytes32 destCommitment)",
) as Hex;

export const OPEN_AUTH_TYPEHASH = ethers.id("OpenAuth(bytes32 orderId,uint256 expiry)") as Hex;

export const OPEN_AUTH_DOMAIN_NAME = "RiddlerEscrow";
export const OPEN_AUTH_DOMAIN_VERSION = "1";
export const DEST_BLINDING_TAG = "riddler/dest-blinding/v1";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

// Every uint256 this module hashes or signs: a bigint, a safe-integer number or
// a plain base-10 digit string, within uint256. `BigInt` alone would coerce ""
// to 0, "0x10" to 16 and " 7" to 7, so a value Riddler refuses would hash or
// sign here as a valid-looking one. This is STRICTER than Riddler's admission
// (`EIP712.uint/1`, `OrderTerms.new/1`, `DestOpening.new/1` use
// `Integer.parse/1`, which also admits "+7" and "-0"). Fail-closed: it refuses
// some spellings Riddler admits and admits none Riddler refuses.
function toUint(label: string, v: UintLike): bigint {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === "string" && /^[0-9]+$/.test(v)) n = BigInt(v);
  else throw new Error(`${label} must be a base-10 uint256, got ${JSON.stringify(String(v))}`);
  if (n < 0n || n > MAX_UINT256) throw new Error(`${label} is out of uint256 range: ${n}`);
  return n;
}
const coder = ethers.AbiCoder.defaultAbiCoder();

// ESCROW-RFC §2.1: an EVM address maps to its left-padded 32-byte word, case
// insensitively; anything else is keccak256 of its UTF-8 bytes, verbatim.
export function canonicalKey(s: string): Hex {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error("canonicalKey: empty string is not a valid key");
  }
  if (EVM_ADDRESS.test(s)) {
    return ethers.zeroPadValue(s.toLowerCase(), 32).toLowerCase() as Hex;
  }
  return ethers.keccak256(ethers.toUtf8Bytes(s)) as Hex;
}

export function computeIntentIdHash(intentId: string): Hex {
  if (typeof intentId !== "string" || intentId.length === 0) {
    throw new Error("intentId must be a non-empty string");
  }
  return ethers.keccak256(ethers.toUtf8Bytes(intentId)) as Hex;
}

function assertBlinding(blinding: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(blinding)) {
    throw new Error(`blinding must be 32 bytes (0x + 64 hex), got ${blinding}`);
  }
  if (BigInt(blinding) === 0n) throw new Error("blinding must be non-zero");
}

export function computeDestCommitment(opening: DestOpening): Hex {
  assertBlinding(opening.blinding);
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32"],
      [
        DEST_TYPEHASH,
        canonicalKey(opening.recipient),
        canonicalKey(opening.toToken),
        toUint("toAmount", opening.toAmount),
        opening.blinding,
        computeIntentIdHash(opening.intentId),
      ],
    ),
  ) as Hex;
}

export function computeOrderId(terms: OrderTerms): Hex {
  return ethers.keccak256(
    coder.encode(
      [
        "bytes32",
        "address",
        "uint256",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "address",
        "bytes32",
      ],
      [
        ORDER_TYPEHASH,
        terms.depositor.toLowerCase(),
        toUint("fromChainId", terms.fromChainId),
        terms.fromToken.toLowerCase(),
        toUint("fromAmount", terms.fromAmount),
        toUint("toChainId", terms.toChainId),
        toUint("fillDeadline", terms.fillDeadline),
        terms.escrow.toLowerCase(),
        terms.destCommitment,
      ],
    ),
  ) as Hex;
}

// Venue-side only (ESCROW-RFC §2.2). The client never derives a blinding.
export function deriveDestBlinding(
  key: string | Uint8Array,
  fromChainId: UintLike,
  escrow: string,
  intentId: string,
): Hex {
  if (!EVM_ADDRESS.test(escrow)) throw new Error(`escrow must be an EVM address, got ${escrow}`);
  if (intentId.length === 0) throw new Error("intentId must be a non-empty string");
  const keyBytes = typeof key === "string" ? ethers.getBytes(key) : key;
  if (keyBytes.length === 0) throw new Error("blinding key must be non-empty");
  const msg = ethers.concat([
    ethers.toUtf8Bytes(DEST_BLINDING_TAG),
    ethers.toBeHex(toUint("fromChainId", fromChainId), 32),
    escrow.toLowerCase(),
    ethers.toUtf8Bytes(intentId),
  ]);
  return ethers.computeHmac("sha256", keyBytes, msg).toLowerCase() as Hex;
}

function typedDomain(domain: OpenAuthDomain): ethers.TypedDataDomain {
  return {
    name: OPEN_AUTH_DOMAIN_NAME,
    version: OPEN_AUTH_DOMAIN_VERSION,
    chainId: toUint("domain.chainId", domain.chainId),
    verifyingContract: domain.verifyingContract,
  };
}

const OPEN_AUTH_TYPES = {
  OpenAuth: [
    { name: "orderId", type: "bytes32" },
    { name: "expiry", type: "uint256" },
  ],
};

export function openAuthDomainSeparator(domain: OpenAuthDomain): Hex {
  return ethers.TypedDataEncoder.hashDomain(typedDomain(domain)) as Hex;
}

export function openAuthStructHash(orderId: string, expiry: UintLike): Hex {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "uint256"],
      [OPEN_AUTH_TYPEHASH, orderId, toUint("expiry", expiry)],
    ),
  ) as Hex;
}

export function openAuthDigest(domain: OpenAuthDomain, orderId: string, expiry: UintLike): Hex {
  return ethers.keccak256(
    ethers.concat(["0x1901", openAuthDomainSeparator(domain), openAuthStructHash(orderId, expiry)]),
  ) as Hex;
}

// 65-byte r||s||v, low-s (ethers always normalizes s).
export async function signOpenAuth(
  signer: ethers.Signer,
  domain: OpenAuthDomain,
  orderId: string,
  expiry: UintLike,
): Promise<Hex> {
  const sig = await signer.signTypedData(typedDomain(domain), OPEN_AUTH_TYPES, {
    orderId,
    expiry: toUint("expiry", expiry),
  });
  return ethers.Signature.from(sig).serialized as Hex;
}

function normalizeBytes32(label: string, v: string): string {
  const withPrefix = v.startsWith("0x") ? v : "0x" + v;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(`${label} must be 32 bytes (0x + 64 hex), got ${v}`);
  }
  return withPrefix.toLowerCase();
}

export type EscrowPullAuth =
  | { kind: "erc3009"; to: string; token: string; amount: UintLike; nonce: string }
  | { kind: "permit2"; spender: string; token: string; amount: UintLike; witnessOrderId: string };

// The caller's pinned RiddlerEscrow per ORIGIN chain id. MUST come from outside
// the venue channel -- a deployment manifest the integrator reviewed, not
// `escrow.address`, `order_terms.escrow` or the `escrow_address`
// /xochi/capabilities advertises, all of which the venue writes (ESCROW-RFC §7).
// A key is a positive chain id in decimal or `0x` hex, whitespace-trimmed, so
// `8453`, `"08453"`, `"0x2105"` and `" 8453 "` all pin chain 8453; any other key
// refuses the whole pin, as do two keys naming one chain with different
// escrows. Values are trimmed and must be non-zero EVM addresses. One reading
// for `assertEscrowBinding` and the pull guard (`assertPullMatchesIntent`).
export type PinnedEscrows = Readonly<Record<number, string>>;

export interface EscrowBinding {
  // The user's own intent.
  signer: string; // the address signing the pull-auth
  recipient: string;
  toToken: string; // an EVM destination token MUST be its address (caller's duty, ESCROW-RFC §2.1)
  toChainId: UintLike; // the destination chain the user asked for
  minOut: UintLike;
  // The quote.
  terms: OrderTerms;
  opening: DestOpening;
  quotedOrderId: string;
  // The pull-auth the SDK is about to sign.
  pullAuth: EscrowPullAuth;
  // REQUIRED, caller-held: the escrow the pull may name, keyed by origin chain.
  expectedEscrows: PinnedEscrows;
}

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Absent pin, uncovered chain, and a blank, malformed or zero entry all refuse:
// every value the guard compares the escrow to would otherwise be the venue's.
function pinnedEscrowFor(pin: PinnedEscrows | undefined, fromChainId: UintLike): string {
  if (pin == null || typeof pin !== "object" || Array.isArray(pin)) {
    throw new Error(
      "expectedEscrows is required: the escrow must be a caller-pinned value, never the quote's",
    );
  }
  const chain = toUint("terms.fromChainId", fromChainId);
  const escrow = resolvePinnedEscrow(pin, chain, (message) => new Error(message));
  if (escrow === undefined) {
    throw new Error(`no pinned escrow for origin chain ${chain}; refusing to sign`);
  }
  return escrow;
}

// The escrow-activation guard (SPEC.md §2.3, ESCROW-RFC.md §7). Recomputes every
// key, the destCommitment and the orderId locally -- never trusting a quoted
// value -- and asserts the quote and the pull-auth bind the user's own intent
// and the caller's pinned escrow for `terms.fromChainId`. Returns the verified
// orderId. RESERVED / INERT: no signer calls this yet.
export function assertEscrowBinding(b: EscrowBinding): Hex {
  const { terms, opening, pullAuth } = b;
  const escrow = pinnedEscrowFor(b.expectedEscrows, terms.fromChainId);

  if (canonicalKey(opening.recipient) !== canonicalKey(b.recipient)) {
    throw new Error(
      `opening.recipient (${opening.recipient}) is not the intent recipient (${b.recipient})`,
    );
  }
  if (canonicalKey(opening.toToken) !== canonicalKey(b.toToken)) {
    throw new Error(
      `opening.toToken (${opening.toToken}) is not the intent toToken (${b.toToken})`,
    );
  }
  if (toUint("opening.toAmount", opening.toAmount) < toUint("minOut", b.minOut)) {
    throw new Error(`opening.toAmount (${opening.toAmount}) is below minOut (${b.minOut})`);
  }
  assertBlinding(opening.blinding);
  // The destination chain is outside destCommitment, so without this a quote
  // could keep recipient/token/amount and deliver on a chain the user never named.
  if (
    b.toChainId == null ||
    toUint("terms.toChainId", terms.toChainId) !== toUint("toChainId", b.toChainId)
  ) {
    throw new Error(
      `OrderTerms.toChainId (${terms.toChainId}) is not the intent toChainId (${b.toChainId})`,
    );
  }

  const commitment = computeDestCommitment(opening);
  if (normalizeBytes32("terms.destCommitment", terms.destCommitment) !== commitment) {
    throw new Error(
      `destCommitment mismatch: recomputed ${commitment}, terms carry ${terms.destCommitment}`,
    );
  }
  const orderId = computeOrderId(terms);
  if (normalizeBytes32("quotedOrderId", b.quotedOrderId) !== orderId) {
    throw new Error(
      `orderId mismatch: recomputed ${orderId} from OrderTerms, quote witness is ${b.quotedOrderId}`,
    );
  }

  if (!eqAddr(terms.escrow, escrow)) {
    throw new Error(
      `OrderTerms.escrow (${terms.escrow}) is not the pinned escrow for chain ${terms.fromChainId} (${escrow})`,
    );
  }
  const spender = pullAuth.kind === "erc3009" ? pullAuth.to : pullAuth.spender;
  if (!eqAddr(spender, escrow)) {
    throw new Error(
      `pull-auth spender/to (${spender}) is not the pinned escrow (${escrow}); refusing to sign`,
    );
  }
  if (!eqAddr(terms.depositor, b.signer)) {
    throw new Error(`OrderTerms.depositor (${terms.depositor}) is not the signer (${b.signer})`);
  }
  if (!eqAddr(terms.fromToken, pullAuth.token)) {
    throw new Error(
      `OrderTerms.fromToken (${terms.fromToken}) is not the pull-auth token (${pullAuth.token})`,
    );
  }
  if (
    toUint("terms.fromAmount", terms.fromAmount) !== toUint("pull-auth amount", pullAuth.amount)
  ) {
    throw new Error(
      `OrderTerms.fromAmount (${terms.fromAmount}) is not the pull-auth amount (${pullAuth.amount})`,
    );
  }
  if (
    pullAuth.kind === "erc3009" &&
    normalizeBytes32("erc3009 nonce", pullAuth.nonce) !== orderId
  ) {
    throw new Error(`erc3009 nonce (${pullAuth.nonce}) is not the orderId (${orderId})`);
  }
  if (
    pullAuth.kind === "permit2" &&
    (typeof pullAuth.witnessOrderId !== "string" ||
      normalizeBytes32("permit2 witness orderId", pullAuth.witnessOrderId) !== orderId)
  ) {
    throw new Error(
      `permit2 witness orderId (${pullAuth.witnessOrderId}) is not the orderId (${orderId})`,
    );
  }
  return orderId;
}

// ---------------------------------------------------------------------------
// Destination fill binding (ESCROW-RFC §9.4). Venue-side only: the salt key MUST
// NOT be shared with the solver panel.

export const FILL_SALT_TAG = "riddler/fill-salt/v1";

// fillSalt = HMAC-SHA256(venueKey, utf8(FILL_SALT_TAG) || orderId[32 raw bytes]).
export function deriveFillSalt(key: string | Uint8Array, orderId: string): Hex {
  const id = normalizeBytes32("orderId", orderId);
  const keyBytes = typeof key === "string" ? ethers.getBytes(key) : key;
  if (keyBytes.length === 0) throw new Error("fill salt key must be non-empty");
  const msg = ethers.concat([ethers.toUtf8Bytes(FILL_SALT_TAG), id]);
  return ethers.computeHmac("sha256", keyBytes, msg).toLowerCase() as Hex;
}

// fillId = keccak256(abi.encode(orderId, fillSalt)) -- 64 raw bytes.
export function computeFillId(orderId: string, fillSalt: string): Hex {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32"],
      [normalizeBytes32("orderId", orderId), normalizeBytes32("fillSalt", fillSalt)],
    ),
  ) as Hex;
}

// EIP-712 domain of any escrow-family contract: its chain and address.
export type EscrowContractDomain = OpenAuthDomain;

function namedDomain(
  name: string,
  version: string,
  domain: EscrowContractDomain,
): ethers.TypedDataDomain {
  return {
    name,
    version,
    chainId: toUint("domain.chainId", domain.chainId),
    verifyingContract: domain.verifyingContract,
  };
}

function typedDigest(separator: string, structHash: string): Hex {
  return ethers.keccak256(ethers.concat(["0x1901", separator, structHash])) as Hex;
}

// Every exported signer below is `async`, so a value toUint refuses rejects the
// returned promise rather than throwing synchronously at the call.
async function signTyped(
  signer: ethers.Signer,
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>,
): Promise<Hex> {
  return ethers.Signature.from(await signer.signTypedData(domain, types, value)).serialized as Hex;
}

// --- RiddlerFiller FillAuth ---

export const FILL_AUTH_DOMAIN_NAME = "RiddlerFiller";
export const FILL_AUTH_DOMAIN_VERSION = "1";
export const FILL_AUTH_TYPEHASH = ethers.id(
  "FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline)",
) as Hex;

export interface FillAuth {
  fillId: string; // bytes32
  filler: string; // address (msg.sender of fill)
  to: string; // address
  token: string; // address
  amount: UintLike;
  deadline: UintLike;
}

const FILL_AUTH_TYPES = {
  FillAuth: [
    { name: "fillId", type: "bytes32" },
    { name: "filler", type: "address" },
    { name: "to", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function fillAuthDomainSeparator(domain: EscrowContractDomain): Hex {
  return ethers.TypedDataEncoder.hashDomain(
    namedDomain(FILL_AUTH_DOMAIN_NAME, FILL_AUTH_DOMAIN_VERSION, domain),
  ) as Hex;
}

export function fillAuthStructHash(a: FillAuth): Hex {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "address", "address", "address", "uint256", "uint256"],
      [
        FILL_AUTH_TYPEHASH,
        a.fillId,
        a.filler.toLowerCase(),
        a.to.toLowerCase(),
        a.token.toLowerCase(),
        toUint("amount", a.amount),
        toUint("deadline", a.deadline),
      ],
    ),
  ) as Hex;
}

export function fillAuthDigest(domain: EscrowContractDomain, a: FillAuth): Hex {
  return typedDigest(fillAuthDomainSeparator(domain), fillAuthStructHash(a));
}

export async function signFillAuth(
  signer: ethers.Signer,
  domain: EscrowContractDomain,
  a: FillAuth,
): Promise<Hex> {
  return signTyped(
    signer,
    namedDomain(FILL_AUTH_DOMAIN_NAME, FILL_AUTH_DOMAIN_VERSION, domain),
    FILL_AUTH_TYPES,
    {
      fillId: a.fillId,
      filler: a.filler,
      to: a.to,
      token: a.token,
      amount: toUint("amount", a.amount),
      deadline: toUint("deadline", a.deadline),
    },
  );
}

// --- AttestedFillVerifier FillAttestation ---

export const FILL_ATTESTATION_DOMAIN_NAME = "RiddlerFillAttestation";
export const FILL_ATTESTATION_DOMAIN_VERSION = "1";
export const FILL_ATTESTATION_TYPEHASH = ethers.id(
  "FillAttestation(bytes32 orderId,address payee)",
) as Hex;

const FILL_ATTESTATION_TYPES = {
  FillAttestation: [
    { name: "orderId", type: "bytes32" },
    { name: "payee", type: "address" },
  ],
};

export function fillAttestationDomainSeparator(domain: EscrowContractDomain): Hex {
  return ethers.TypedDataEncoder.hashDomain(
    namedDomain(FILL_ATTESTATION_DOMAIN_NAME, FILL_ATTESTATION_DOMAIN_VERSION, domain),
  ) as Hex;
}

export function fillAttestationStructHash(orderId: string, payee: string): Hex {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "address"],
      [FILL_ATTESTATION_TYPEHASH, orderId, payee.toLowerCase()],
    ),
  ) as Hex;
}

export function fillAttestationDigest(
  domain: EscrowContractDomain,
  orderId: string,
  payee: string,
): Hex {
  return typedDigest(
    fillAttestationDomainSeparator(domain),
    fillAttestationStructHash(orderId, payee),
  );
}

export async function signFillAttestation(
  signer: ethers.Signer,
  domain: EscrowContractDomain,
  orderId: string,
  payee: string,
): Promise<Hex> {
  return signTyped(
    signer,
    namedDomain(FILL_ATTESTATION_DOMAIN_NAME, FILL_ATTESTATION_DOMAIN_VERSION, domain),
    FILL_ATTESTATION_TYPES,
    {
      orderId,
      payee,
    },
  );
}

// The `proof` bytes AttestedFillVerifier decodes: abi.encode(address payee, bytes signature).
export function encodeAttestedProof(payee: string, signature: string): Hex {
  return coder.encode(["address", "bytes"], [payee.toLowerCase(), signature]).toLowerCase() as Hex;
}

// --- SolverBond domain (SlashAttestation and FillAcceptance share it) ---

export const SOLVER_BOND_DOMAIN_NAME = "RiddlerSolverBond";
// SolverBond v2 (ESCROW-RFC §6): redeployed with the FillAcceptance check, so
// every signature on its domain -- slash attestations included -- moves to "2".
export const SOLVER_BOND_DOMAIN_VERSION = "2";

// --- SolverBond SlashAttestation ---

export const SLASH_ATTESTATION_TYPEHASH = ethers.id(
  "SlashAttestation(bytes32 orderId,address solver,address beneficiary,uint256 notional,uint256 originChainId,address escrow,uint256 deadline)",
) as Hex;

// Mirrors SolverBond.SlashClaim.
export interface SlashClaim {
  orderId: string; // bytes32
  solver: string; // address
  beneficiary: string; // address
  notional: UintLike;
  originChainId: UintLike;
  escrow: string; // address
  deadline: UintLike;
}

const SLASH_ATTESTATION_TYPES = {
  SlashAttestation: [
    { name: "orderId", type: "bytes32" },
    { name: "solver", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "notional", type: "uint256" },
    { name: "originChainId", type: "uint256" },
    { name: "escrow", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

export function slashAttestationDomainSeparator(domain: EscrowContractDomain): Hex {
  return ethers.TypedDataEncoder.hashDomain(
    namedDomain(SOLVER_BOND_DOMAIN_NAME, SOLVER_BOND_DOMAIN_VERSION, domain),
  ) as Hex;
}

export function slashAttestationStructHash(c: SlashClaim): Hex {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "address", "address", "uint256", "uint256", "address", "uint256"],
      [
        SLASH_ATTESTATION_TYPEHASH,
        c.orderId,
        c.solver.toLowerCase(),
        c.beneficiary.toLowerCase(),
        toUint("notional", c.notional),
        toUint("originChainId", c.originChainId),
        c.escrow.toLowerCase(),
        toUint("deadline", c.deadline),
      ],
    ),
  ) as Hex;
}

export function slashAttestationDigest(domain: EscrowContractDomain, c: SlashClaim): Hex {
  return typedDigest(slashAttestationDomainSeparator(domain), slashAttestationStructHash(c));
}

export async function signSlashAttestation(
  signer: ethers.Signer,
  domain: EscrowContractDomain,
  c: SlashClaim,
): Promise<Hex> {
  return signTyped(
    signer,
    namedDomain(SOLVER_BOND_DOMAIN_NAME, SOLVER_BOND_DOMAIN_VERSION, domain),
    SLASH_ATTESTATION_TYPES,
    {
      orderId: c.orderId,
      solver: c.solver,
      beneficiary: c.beneficiary,
      notional: toUint("notional", c.notional),
      originChainId: toUint("originChainId", c.originChainId),
      escrow: c.escrow,
      deadline: toUint("deadline", c.deadline),
    },
  );
}

// --- SolverBond v2 FillAcceptance ---
//
// The solver's co-signature over the exact `:winner` FillAuth it received
// (SOLVER-RFC §5.3, ESCROW-RFC §6.1). SolverBond v2 refuses a slash without it,
// so a venue that withholds, shrinks or fabricates an award cannot get the
// solver slashed. Signed by `filler` -- the one solver key.
//
// The FillAuth enters as a COMMITMENT (`fillAuth` = its RiddlerFiller EIP-712
// digest), never in plaintext: `proposeSlash` publishes the acceptance in
// calldata on the bond chain, which can be an origin chain, and ESCROW-RFC §9.3
// C2/C3 forbid `fillId` or the destination opening beside `orderId` there. The
// digest is hiding because `fillId` commits the venue's `fillSalt`. `deadline`
// stays in the clear for SolverBond's `FillWindowOpen` check.

export const FILL_ACCEPTANCE_TYPE =
  "FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)";
export const FILL_ACCEPTANCE_TYPEHASH = ethers.id(FILL_ACCEPTANCE_TYPE) as Hex;

// Mirrors SolverBond.FillAcceptance. `orderId`/`originChainId`/`escrow` come from
// the order's terms; `filler`/`deadline` from the FillAuth; `fillAuth` is
// `fillAuthDigest(filler domain, FillAuth)` (`fillAcceptanceOf` builds it).
export interface FillAcceptance {
  orderId: string; // bytes32
  originChainId: UintLike;
  escrow: string; // address
  filler: string; // address
  deadline: UintLike;
  fillAuth: string; // bytes32: RiddlerFiller EIP-712 digest of the FillAuth
}

const FILL_ACCEPTANCE_TYPES = {
  FillAcceptance: [
    { name: "orderId", type: "bytes32" },
    { name: "originChainId", type: "uint256" },
    { name: "escrow", type: "address" },
    { name: "filler", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "fillAuth", type: "bytes32" },
  ],
};

// The acceptance of one issued FillAuth: order terms plus the FillAuth's
// `filler`, `deadline` and its digest under the RiddlerFiller domain it was
// issued on (`chainId` = destination, `verifyingContract` = RiddlerFiller).
export function fillAcceptanceOf(
  order: { orderId: string; originChainId: UintLike; escrow: string },
  fillerDomain: EscrowContractDomain,
  fillAuth: FillAuth,
): FillAcceptance {
  return {
    orderId: normalizeBytes32("orderId", order.orderId),
    originChainId: order.originChainId,
    escrow: order.escrow,
    filler: fillAuth.filler,
    deadline: fillAuth.deadline,
    fillAuth: fillAuthDigest(fillerDomain, fillAuth),
  };
}

export function fillAcceptanceDomainSeparator(domain: EscrowContractDomain): Hex {
  return ethers.TypedDataEncoder.hashDomain(
    namedDomain(SOLVER_BOND_DOMAIN_NAME, SOLVER_BOND_DOMAIN_VERSION, domain),
  ) as Hex;
}

export function fillAcceptanceStructHash(a: FillAcceptance): Hex {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "uint256", "address", "address", "uint256", "bytes32"],
      [
        FILL_ACCEPTANCE_TYPEHASH,
        normalizeBytes32("orderId", a.orderId),
        toUint("originChainId", a.originChainId),
        a.escrow.toLowerCase(),
        a.filler.toLowerCase(),
        toUint("deadline", a.deadline),
        normalizeBytes32("fillAuth", a.fillAuth),
      ],
    ),
  ) as Hex;
}

export function fillAcceptanceDigest(domain: EscrowContractDomain, a: FillAcceptance): Hex {
  return typedDigest(fillAcceptanceDomainSeparator(domain), fillAcceptanceStructHash(a));
}

export async function signFillAcceptance(
  signer: ethers.Signer,
  domain: EscrowContractDomain,
  a: FillAcceptance,
): Promise<Hex> {
  return signTyped(
    signer,
    namedDomain(SOLVER_BOND_DOMAIN_NAME, SOLVER_BOND_DOMAIN_VERSION, domain),
    FILL_ACCEPTANCE_TYPES,
    {
      orderId: normalizeBytes32("orderId", a.orderId),
      originChainId: toUint("originChainId", a.originChainId),
      escrow: a.escrow,
      filler: a.filler,
      deadline: toUint("deadline", a.deadline),
      fillAuth: normalizeBytes32("fillAuth", a.fillAuth),
    },
  );
}
