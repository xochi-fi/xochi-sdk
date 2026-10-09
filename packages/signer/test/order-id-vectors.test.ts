// Cross-implementation vector check for the v2 escrow order encoding
// (ESCROW-RFC §2/§12, M6.1): `@xochi/spec`'s order-id.json, open-auth.json,
// dest-blinding.json, fill-salt.json, fill-auth.json, fill-attestation.json,
// slash-attestation.json and fill-acceptance.json -- the same files the Riddler server's Elixir suite and
// RiddlerEscrow's Foundry suite read. Without this, the vectors would only ever
// be asserted by the generator that produced them, which is circular.
//
// A mismatch means @xochi/signer changed without regenerating the vectors, or
// the vectors were edited by hand. Regenerate deliberately; never patch them.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import {
  canonicalKey,
  computeDestCommitment,
  computeIntentIdHash,
  computeOrderId,
  DEST_BLINDING_TAG,
  DEST_TYPEHASH,
  deriveDestBlinding,
  computeFillId,
  deriveFillSalt,
  encodeAttestedProof,
  FILL_ATTESTATION_DOMAIN_NAME,
  FILL_ATTESTATION_DOMAIN_VERSION,
  FILL_ATTESTATION_TYPEHASH,
  FILL_AUTH_DOMAIN_NAME,
  FILL_AUTH_DOMAIN_VERSION,
  FILL_AUTH_TYPEHASH,
  FILL_SALT_TAG,
  fillAttestationDigest,
  fillAttestationDomainSeparator,
  fillAttestationStructHash,
  fillAuthDigest,
  fillAuthDomainSeparator,
  fillAuthStructHash,
  signFillAttestation,
  signFillAuth,
  FILL_ACCEPTANCE_DOMAIN_VERSION,
  FILL_ACCEPTANCE_TYPEHASH,
  fillAcceptanceDigest,
  fillAcceptanceDomainSeparator,
  fillAcceptanceStructHash,
  signFillAcceptance,
  signSlashAttestation,
  SLASH_ATTESTATION_DOMAIN_NAME,
  SLASH_ATTESTATION_DOMAIN_VERSION,
  SLASH_ATTESTATION_TYPEHASH,
  slashAttestationDigest,
  slashAttestationDomainSeparator,
  slashAttestationStructHash,
  OPEN_AUTH_DOMAIN_NAME,
  OPEN_AUTH_DOMAIN_VERSION,
  OPEN_AUTH_TYPEHASH,
  openAuthDigest,
  openAuthDomainSeparator,
  openAuthStructHash,
  ORDER_TYPEHASH,
  signOpenAuth,
} from "@xochi/signer";

// Pinned as literals, not through the exported constants: a test comparing a
// vector to the constant that generated it passes whenever both move together.
const DEST_TYPEHASH_LIT = ethers.id(
  "RiddlerDestCommitment(bytes32 recipientKey,bytes32 toTokenKey,uint256 toAmount,bytes32 blinding,bytes32 intentIdHash)",
);
const ORDER_TYPEHASH_LIT = ethers.id(
  "RiddlerOrder(address depositor,uint256 fromChainId,address fromToken,uint256 fromAmount,uint256 toChainId,uint256 fillDeadline,address escrow,bytes32 destCommitment)",
);
const OPEN_AUTH_TYPEHASH_LIT = ethers.id("OpenAuth(bytes32 orderId,uint256 expiry)");
const FILL_AUTH_TYPEHASH_LIT = ethers.id("FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline)");
const FILL_ATTESTATION_TYPEHASH_LIT = ethers.id("FillAttestation(bytes32 orderId,address payee)");
const SLASH_ATTESTATION_TYPEHASH_LIT = ethers.id(
  "SlashAttestation(bytes32 orderId,address solver,address beneficiary,uint256 notional,uint256 originChainId,address escrow,uint256 deadline)",
);

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) =>
  JSON.parse(fs.readFileSync(path.resolve(here, "../../spec/conformance", name), "utf8"));

type OrderVector = {
  name: string;
  why: string;
  opening: { recipient: string; toToken: string; toAmount: string; blinding: string; intentId: string };
  expected_recipient_key: string;
  expected_to_token_key: string;
  expected_intent_id_hash: string;
  expected_dest_commitment: string;
  terms: {
    depositor: string;
    fromChainId: string;
    fromToken: string;
    fromAmount: string;
    toChainId: string;
    fillDeadline: string;
    escrow: string;
  };
  expected_order_id: string;
};

const orderIds = load("order-id.json") as {
  typehashes: { DEST_TYPEHASH: string; ORDER_TYPEHASH: string };
  vectors: OrderVector[];
};

describe("order-id.json", () => {
  it("pins the typehashes", () => {
    expect(orderIds.typehashes).toEqual({ DEST_TYPEHASH: DEST_TYPEHASH_LIT, ORDER_TYPEHASH: ORDER_TYPEHASH_LIT });
    expect({ DEST_TYPEHASH, ORDER_TYPEHASH }).toEqual(orderIds.typehashes);
  });

  it.each(orderIds.vectors)("$name reproduces keys, commitment and orderId", (v) => {
    expect(canonicalKey(v.opening.recipient)).toBe(v.expected_recipient_key);
    expect(canonicalKey(v.opening.toToken)).toBe(v.expected_to_token_key);
    expect(computeIntentIdHash(v.opening.intentId)).toBe(v.expected_intent_id_hash);
    expect(computeDestCommitment(v.opening)).toBe(v.expected_dest_commitment);
    expect(computeOrderId({ ...v.terms, destCommitment: v.expected_dest_commitment })).toBe(v.expected_order_id);
  });

  it("keeps every case spec §6 requires, with well-formed fields", () => {
    const names = new Set(orderIds.vectors.map((v) => v.name));
    for (const required of [
      "baseline-evm-usdc",
      "evm-recipient-checksummed",
      "tron-base58-recipient",
      "canton-party-recipient",
      "bytes32-hex-recipient",
      "symbol-to-token",
      "zero-amounts",
      "max-uint256-amounts-and-deadline",
      "unicode-intent-id",
      "long-multiword-strings",
      "high-bit-blinding",
    ]) {
      expect(names.has(required), `vector set lost coverage: ${required}`).toBe(true);
    }
    expect(names.size).toBe(orderIds.vectors.length);
    for (const v of orderIds.vectors) {
      expect(v.why.length, v.name).toBeGreaterThan(0);
      for (const h of [v.expected_recipient_key, v.expected_to_token_key, v.expected_intent_id_hash, v.expected_dest_commitment, v.expected_order_id, v.opening.blinding]) {
        expect(h, v.name).toMatch(/^0x[0-9a-f]{64}$/);
      }
      for (const n of [v.opening.toAmount, v.terms.fromChainId, v.terms.fromAmount, v.terms.toChainId, v.terms.fillDeadline]) {
        expect(n, v.name).toMatch(/^[0-9]+$/);
      }
    }
  });

  it("gives a checksummed EVM recipient the lowercase form's key and orderId", () => {
    const byName = (n: string) => orderIds.vectors.find((v) => v.name === n)!;
    const lower = byName("baseline-evm-usdc");
    const checksummed = byName("evm-recipient-checksummed");
    expect(checksummed.opening.recipient).not.toBe(lower.opening.recipient);
    expect(checksummed.expected_recipient_key).toBe(lower.expected_recipient_key);
    expect(checksummed.expected_order_id).toBe(lower.expected_order_id);
  });
});

type OpenAuthVector = {
  name: string;
  chainId: string;
  verifyingContract: string;
  orderId: string;
  expiry: string;
  expected_struct_hash: string;
  expected_domain_separator: string;
  expected_digest: string;
  signer_private_key: string;
  signer_address: string;
  expected_signature: string;
};

const openAuth = load("open-auth.json") as {
  domain: { name: string; version: string };
  typehash: string;
  vectors: OpenAuthVector[];
};

describe("open-auth.json", () => {
  it("pins the domain and typehash", () => {
    expect(openAuth.domain).toEqual({ name: "RiddlerEscrow", version: "1" });
    expect(openAuth.typehash).toBe(OPEN_AUTH_TYPEHASH_LIT);
    expect({ name: OPEN_AUTH_DOMAIN_NAME, version: OPEN_AUTH_DOMAIN_VERSION, typehash: OPEN_AUTH_TYPEHASH }).toEqual({ ...openAuth.domain, typehash: openAuth.typehash });
  });

  it.each(openAuth.vectors)("$name reproduces digest and a recoverable signature", async (v) => {
    const domain = { chainId: v.chainId, verifyingContract: v.verifyingContract };
    expect(openAuthStructHash(v.orderId, v.expiry)).toBe(v.expected_struct_hash);
    expect(openAuthDomainSeparator(domain)).toBe(v.expected_domain_separator);
    expect(openAuthDigest(domain, v.orderId, v.expiry)).toBe(v.expected_digest);
    const wallet = new ethers.Wallet(v.signer_private_key);
    expect((await signOpenAuth(wallet, domain, v.orderId, v.expiry)).toLowerCase()).toBe(v.expected_signature);
    expect(ethers.recoverAddress(v.expected_digest, v.expected_signature)).toBe(wallet.address);
    expect(wallet.address).toBe(v.signer_address);
  });
});

const blinding = load("dest-blinding.json") as {
  domain_tag: string;
  key: string;
  vectors: { name: string; fromChainId: string; escrow: string; intentId: string; expected_blinding: string }[];
};

describe("dest-blinding.json", () => {
  it("pins the domain tag", () => {
    expect(blinding.domain_tag).toBe("riddler/dest-blinding/v1");
    expect(DEST_BLINDING_TAG).toBe(blinding.domain_tag);
  });

  it.each(blinding.vectors)("$name reproduces its blinding", (v) => {
    expect(deriveDestBlinding(blinding.key, v.fromChainId, v.escrow, v.intentId)).toBe(v.expected_blinding);
  });
});

const fillSalt = load("fill-salt.json") as {
  domain_tag: string;
  vectors: { name: string; key: string; orderId: string; expected_fill_salt: string; expected_fill_id: string }[];
};

describe("fill-salt.json", () => {
  it("pins the domain tag", () => {
    expect(fillSalt.domain_tag).toBe("riddler/fill-salt/v1");
    expect(FILL_SALT_TAG).toBe(fillSalt.domain_tag);
  });

  it.each(fillSalt.vectors)("$name reproduces fillSalt and fillId", (v) => {
    expect(deriveFillSalt(v.key, v.orderId)).toBe(v.expected_fill_salt);
    expect(computeFillId(v.orderId, v.expected_fill_salt)).toBe(v.expected_fill_id);
  });
});

type SignedVector = {
  name: string;
  chainId: string;
  verifyingContract: string;
  expected_struct_hash: string;
  expected_domain_separator: string;
  expected_digest: string;
  signer_private_key: string;
  signer_address: string;
  expected_signature: string;
};

const fillAuth = load("fill-auth.json") as {
  domain: { name: string; version: string };
  typehash: string;
  vectors: (SignedVector & { fillId: string; filler: string; to: string; token: string; amount: string; deadline: string })[];
};

describe("fill-auth.json", () => {
  it("pins the domain and typehash", () => {
    expect(fillAuth.domain).toEqual({ name: "RiddlerFiller", version: "1" });
    expect(fillAuth.typehash).toBe(FILL_AUTH_TYPEHASH_LIT);
    expect({ name: FILL_AUTH_DOMAIN_NAME, version: FILL_AUTH_DOMAIN_VERSION, typehash: FILL_AUTH_TYPEHASH }).toEqual({ ...fillAuth.domain, typehash: fillAuth.typehash });
  });

  it.each(fillAuth.vectors)("$name reproduces digest and a recoverable signature", async (v) => {
    const domain = { chainId: v.chainId, verifyingContract: v.verifyingContract };
    expect(fillAuthStructHash(v)).toBe(v.expected_struct_hash);
    expect(fillAuthDomainSeparator(domain)).toBe(v.expected_domain_separator);
    expect(fillAuthDigest(domain, v)).toBe(v.expected_digest);
    const wallet = new ethers.Wallet(v.signer_private_key);
    expect((await signFillAuth(wallet, domain, v)).toLowerCase()).toBe(v.expected_signature);
    expect(ethers.recoverAddress(v.expected_digest, v.expected_signature)).toBe(wallet.address);
    expect(wallet.address).toBe(v.signer_address);
  });
});

const fillAttestation = load("fill-attestation.json") as {
  domain: { name: string; version: string };
  typehash: string;
  vectors: (SignedVector & { orderId: string; payee: string; expected_proof: string })[];
};

describe("fill-attestation.json", () => {
  it("pins the domain and typehash", () => {
    expect(fillAttestation.domain).toEqual({ name: "RiddlerFillAttestation", version: "1" });
    expect(fillAttestation.typehash).toBe(FILL_ATTESTATION_TYPEHASH_LIT);
    expect({ name: FILL_ATTESTATION_DOMAIN_NAME, version: FILL_ATTESTATION_DOMAIN_VERSION, typehash: FILL_ATTESTATION_TYPEHASH }).toEqual({ ...fillAttestation.domain, typehash: fillAttestation.typehash });
  });

  it.each(fillAttestation.vectors)("$name reproduces digest, signature and proof", async (v) => {
    const domain = { chainId: v.chainId, verifyingContract: v.verifyingContract };
    expect(fillAttestationStructHash(v.orderId, v.payee)).toBe(v.expected_struct_hash);
    expect(fillAttestationDomainSeparator(domain)).toBe(v.expected_domain_separator);
    expect(fillAttestationDigest(domain, v.orderId, v.payee)).toBe(v.expected_digest);
    const wallet = new ethers.Wallet(v.signer_private_key);
    expect((await signFillAttestation(wallet, domain, v.orderId, v.payee)).toLowerCase()).toBe(v.expected_signature);
    expect(ethers.recoverAddress(v.expected_digest, v.expected_signature)).toBe(wallet.address);
    expect(wallet.address).toBe(v.signer_address);
    expect(encodeAttestedProof(v.payee, v.expected_signature)).toBe(v.expected_proof);
    const [payee, sig] = ethers.AbiCoder.defaultAbiCoder().decode(["address", "bytes"], v.expected_proof);
    expect(payee.toLowerCase()).toBe(v.payee.toLowerCase());
    expect(sig).toBe(v.expected_signature);
  });
});

const slashAttestation = load("slash-attestation.json") as {
  domain: { name: string; version: string };
  typehash: string;
  vectors: (SignedVector & {
    claim: { orderId: string; solver: string; beneficiary: string; notional: string; originChainId: string; escrow: string; deadline: string };
  })[];
};

describe("slash-attestation.json", () => {
  it("pins the domain and typehash", () => {
    // A literal: SolverBond v2's whole domain is version "2" (ESCROW-RFC §6).
    expect(slashAttestation.domain).toEqual({ name: "RiddlerSolverBond", version: "2" });
    expect(slashAttestation.typehash).toBe(SLASH_ATTESTATION_TYPEHASH_LIT);
    expect({ name: SLASH_ATTESTATION_DOMAIN_NAME, version: SLASH_ATTESTATION_DOMAIN_VERSION, typehash: SLASH_ATTESTATION_TYPEHASH }).toEqual({ ...slashAttestation.domain, typehash: slashAttestation.typehash });
  });

  it.each(slashAttestation.vectors)("$name reproduces digest and a recoverable signature", async (v) => {
    const domain = { chainId: v.chainId, verifyingContract: v.verifyingContract };
    expect(slashAttestationStructHash(v.claim)).toBe(v.expected_struct_hash);
    expect(slashAttestationDomainSeparator(domain)).toBe(v.expected_domain_separator);
    expect(slashAttestationDigest(domain, v.claim)).toBe(v.expected_digest);
    const wallet = new ethers.Wallet(v.signer_private_key);
    expect((await signSlashAttestation(wallet, domain, v.claim)).toLowerCase()).toBe(v.expected_signature);
    expect(ethers.recoverAddress(v.expected_digest, v.expected_signature)).toBe(wallet.address);
    expect(wallet.address).toBe(v.signer_address);
  });
});

// The type strings as SolverBond v2 and RiddlerFiller declare them -- literals,
// so a change to the signer's copy cannot pass by regenerating the vectors.
const FILL_ACCEPTANCE_TYPE =
  "FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)";
const FILL_AUTH_TYPE = "FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline)";

const typesOf = (primary: string, type: string) => ({
  [primary]: type
    .slice(primary.length + 1, -1)
    .split(",")
    .map((f) => {
      const [t, name] = f.split(" ");
      return { name: name!, type: t! };
    }),
});

type Acceptance = { orderId: string; originChainId: string; escrow: string; filler: string; deadline: string; fillAuth: string };
type FillAuthPreimage = { fillId: string; filler: string; to: string; token: string; amount: string; deadline: string };

const fillAcceptance = load("fill-acceptance.json") as {
  domain: { name: string; version: string };
  type: string;
  typehash: string;
  fill_auth_domain: { name: string; version: string };
  fill_auth_type: string;
  fill_auth_typehash: string;
  vectors: (SignedVector & {
    fill_auth_domain: { chainId: string; verifyingContract: string };
    fill_auth: FillAuthPreimage;
    expected_fill_auth_digest: string;
    acceptance: Acceptance;
  })[];
};

describe("fill-acceptance.json", () => {
  it("pins both domains, type strings and typehashes by value", () => {
    expect(fillAcceptance.domain).toEqual({ name: "RiddlerSolverBond", version: "2" });
    expect(fillAcceptance.type).toBe(FILL_ACCEPTANCE_TYPE);
    expect(fillAcceptance.typehash).toBe(ethers.id(FILL_ACCEPTANCE_TYPE));
    expect(FILL_ACCEPTANCE_TYPEHASH).toBe(ethers.id(FILL_ACCEPTANCE_TYPE));
    expect(fillAcceptance.fill_auth_domain).toEqual({ name: "RiddlerFiller", version: "1" });
    expect(fillAcceptance.fill_auth_type).toBe(FILL_AUTH_TYPE);
    expect(fillAcceptance.fill_auth_typehash).toBe(ethers.id(FILL_AUTH_TYPE));
  });

  it("covers distinct bond and filler domains and uint256 max", () => {
    const bonds = new Set(fillAcceptance.vectors.map((v) => `${v.chainId}:${v.verifyingContract.toLowerCase()}`));
    const fillers = new Set(fillAcceptance.vectors.map((v) => `${v.fill_auth_domain.chainId}:${v.fill_auth_domain.verifyingContract.toLowerCase()}`));
    expect(bonds.size).toBeGreaterThan(1);
    expect(fillers.size).toBeGreaterThan(1);
    expect(fillAcceptance.vectors.some((v) => v.fill_auth.amount === (2n ** 256n - 1n).toString())).toBe(true);
  });

  it.each(fillAcceptance.vectors)("$name reproduces both steps and a signature recovering to the filler", async (v) => {
    // Step 1: the FillAuth commitment, by the signer AND by ethers' own encoder.
    const fillerDomain = v.fill_auth_domain;
    expect(fillAuthDigest(fillerDomain, v.fill_auth)).toBe(v.expected_fill_auth_digest);
    expect(
      ethers.TypedDataEncoder.hash({ name: "RiddlerFiller", version: "1", ...fillerDomain }, typesOf("FillAuth", FILL_AUTH_TYPE), v.fill_auth),
    ).toBe(v.expected_fill_auth_digest);
    expect(v.acceptance.fillAuth).toBe(v.expected_fill_auth_digest);
    expect(v.acceptance.filler).toBe(v.fill_auth.filler);
    expect(v.acceptance.deadline).toBe(v.fill_auth.deadline);
    // Step 2: the acceptance.
    const domain = { chainId: v.chainId, verifyingContract: v.verifyingContract };
    expect(fillAcceptanceStructHash(v.acceptance)).toBe(v.expected_struct_hash);
    expect(fillAcceptanceDomainSeparator(domain)).toBe(v.expected_domain_separator);
    expect(fillAcceptanceDigest(domain, v.acceptance)).toBe(v.expected_digest);
    expect(
      ethers.TypedDataEncoder.hash(
        { name: "RiddlerSolverBond", version: "2", ...domain },
        typesOf("FillAcceptance", FILL_ACCEPTANCE_TYPE),
        v.acceptance,
      ),
    ).toBe(v.expected_digest);
    const wallet = new ethers.Wallet(v.signer_private_key);
    expect((await signFillAcceptance(wallet, domain, v.acceptance)).toLowerCase()).toBe(v.expected_signature);
    expect(ethers.recoverAddress(v.expected_digest, v.expected_signature)).toBe(wallet.address);
    expect(wallet.address).toBe(v.signer_address);
    expect(ethers.getAddress(v.acceptance.filler)).toBe(v.signer_address);
  });
});

// SNAPSHOT-DRIFT CHECK, NOT AN ORACLE. Riddler's ExUnit and Foundry suites read
// test/support/vectors/escrow_*.json and xochi_xsp.json, which Riddler vendors
// FROM this repo (its ConformanceVectors table: "SDK -> Riddler"). The copies
// under test/vectors/riddler-escrow/ are a snapshot of Riddler's files at the
// commit in PROVENANCE. Equality here proves only that the two repos hold the
// same bytes: it catches a regeneration here that Riddler has not re-copied (or
// a Riddler copy edited in place), and it CANNOT catch a wrong encoding, which
// would be generated here and copied there identically. The independent anchors
// are the literal type strings above and the Foundry `cast` literals below.
const PARITY_SETS: [ours: string, riddler: string][] = [
  ["order-id.json", "escrow_order_id.json"],
  ["open-auth.json", "escrow_open_auth.json"],
  ["dest-blinding.json", "escrow_dest_blinding.json"],
  ["fill-salt.json", "escrow_fill_salt.json"],
  ["fill-auth.json", "escrow_fill_auth.json"],
  ["fill-attestation.json", "escrow_fill_attestation.json"],
  ["slash-attestation.json", "escrow_slash_attestation.json"],
  ["fill-acceptance.json", "escrow_fill_acceptance.json"],
  ["solver-bid-v2.json", "escrow_solver_bid_v2.json"],
  ["xsp.json", "xochi_xsp.json"],
];

describe("Riddler vendored-vector snapshot (drift check)", () => {
  const vendored = path.resolve(here, "vectors/riddler-escrow");
  it.each(PARITY_SETS)("%s is byte-identical to the snapshot of Riddler's %s", (ours, theirs) => {
    const a = fs.readFileSync(path.resolve(here, "../../spec/conformance", ours));
    const b = fs.readFileSync(path.resolve(vendored, theirs));
    expect(a.equals(b), `${ours} differs from Riddler ${theirs}`).toBe(true);
  });

  it("compares every vendored set, so a newly vendored one cannot sit unchecked", () => {
    const onDisk = fs.readdirSync(vendored).filter((f) => f.endsWith(".json")).sort();
    expect(onDisk).toEqual(PARITY_SETS.map(([, theirs]) => theirs).sort());
  });
});

// Independent anchors: computed with Foundry `cast` (1.5.1), not @xochi/signer
// or ethers, from the literal inputs below. Reproduce with:
//
//   cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,bytes32,bytes32)" \
//     $(cast keccak "RiddlerDestCommitment(bytes32 recipientKey,bytes32 toTokenKey,uint256 toAmount,bytes32 blinding,bytes32 intentIdHash)") \
//     $(cast to-uint256 0x70997970c51812dc3a010c7d01b50e0d17dc79c8) $(cast to-uint256 0x0b2c639c533813f4aa9d7837caf62653d097ff85) \
//     99700000 0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a $(cast keccak intent-0001))
//   cast keccak $(cast abi-encode "f(bytes32,address,uint256,address,uint256,uint256,uint256,address,bytes32)" \
//     $(cast keccak "RiddlerOrder(address depositor,uint256 fromChainId,address fromToken,uint256 fromAmount,uint256 toChainId,uint256 fillDeadline,address escrow,bytes32 destCommitment)") \
//     0x1111111111111111111111111111111111111111 8453 0x833589fcd6eb6af1a2ab0fc6d6d0dd6aab3a7ac5 100000000 10 1900000000 \
//     0x3333333333333333333333333333333333333333 <destCommitment above>)
//   # domain separator for NAME/VERSION at chain 8453, contract ADDR:
//   cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" \
//     $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") \
//     $(cast keccak NAME) $(cast keccak VERSION) 8453 ADDR)
//
// A vector regenerated from a wrong encoding moves with the code; these do not.
const CAST_BASELINE = {
  opening: {
    recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    toToken: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    toAmount: "99700000",
    blinding: "0x" + "5a".repeat(32),
    intentId: "intent-0001",
  },
  terms: {
    depositor: "0x1111111111111111111111111111111111111111",
    fromChainId: "8453",
    fromToken: "0x833589fcd6eb6af1a2ab0fc6d6d0dd6aab3a7ac5",
    fromAmount: "100000000",
    toChainId: "10",
    fillDeadline: "1900000000",
    escrow: "0x3333333333333333333333333333333333333333",
  },
  destCommitment: "0xc3d5a8c1b3187b132531d6f774039fee29b712e58dbbd6d14e2a7fe14e85fe05",
  orderId: "0xe9f0165c274aefaeb888d41292fe8311c318c8b7ef7eaef285df9996e0f35f16",
};

// Every escrow-family domain at chain 8453, by `cast`. SolverBond is listed at
// BOTH versions so a separator that silently fell back to "1" is named.
const CAST_SEPARATORS = {
  openAuth: { verifyingContract: "0x3333333333333333333333333333333333333333", v1: "0x5dbf8305d61f4dbfba28be4935fa076f17bdae11fc2d67a526f19921418c8e66" },
  fillAuth: { verifyingContract: "0x4444444444444444444444444444444444444444", v1: "0xc4525d261cfdfa05e297777bf9e1cc5d93ba9054592134a5369b1dd2e937b0b1" },
  fillAttestation: { verifyingContract: "0x5555555555555555555555555555555555555555", v1: "0x2395d70aeb8baed8da6a2ff73e15e894153cc5b09082d42e0707fe40d54a5ac0" },
  solverBond: {
    verifyingContract: "0x6666666666666666666666666666666666666666",
    v1: "0xc19cdaa2390e5f04cf4cb7a6dc9fdef32ad012bb3b82f4ed2a9131dd7ed3a9d9",
    v2: "0x01cda2894e25cfe2056c510ea81932819885c72fc3f070745ec26b85f0bd2930",
  },
};

describe("Foundry cast anchors (independent of @xochi/signer)", () => {
  it("reproduces the ESCROW-RFC §2.4 baseline destCommitment and orderId", () => {
    const commitment = computeDestCommitment(CAST_BASELINE.opening);
    expect(commitment).toBe(CAST_BASELINE.destCommitment);
    expect(computeOrderId({ ...CAST_BASELINE.terms, destCommitment: commitment })).toBe(CAST_BASELINE.orderId);
  });

  it("hashes every escrow-family domain with its declared version, SolverBond at \"2\"", () => {
    const d = (verifyingContract: string) => ({ chainId: 8453, verifyingContract });
    expect(openAuthDomainSeparator(d(CAST_SEPARATORS.openAuth.verifyingContract))).toBe(CAST_SEPARATORS.openAuth.v1);
    expect(fillAuthDomainSeparator(d(CAST_SEPARATORS.fillAuth.verifyingContract))).toBe(CAST_SEPARATORS.fillAuth.v1);
    expect(fillAttestationDomainSeparator(d(CAST_SEPARATORS.fillAttestation.verifyingContract))).toBe(
      CAST_SEPARATORS.fillAttestation.v1,
    );
    const bond = d(CAST_SEPARATORS.solverBond.verifyingContract);
    expect(SLASH_ATTESTATION_DOMAIN_VERSION).toBe("2");
    expect(FILL_ACCEPTANCE_DOMAIN_VERSION).toBe("2");
    for (const sep of [slashAttestationDomainSeparator(bond), fillAcceptanceDomainSeparator(bond)]) {
      expect(sep).toBe(CAST_SEPARATORS.solverBond.v2);
      expect(sep).not.toBe(CAST_SEPARATORS.solverBond.v1);
    }
  });

  // The signers build their typed-data domain separately from the *DomainSeparator
  // functions, so each is checked by recovering against a digest whose separator
  // is the cast literal: a signer hashing a literal version instead of its
  // *_DOMAIN_VERSION constant recovers to a different address.
  it("signs every escrow-family struct under the cast-pinned domain", async () => {
    const wallet = new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const d = (verifyingContract: string) => ({ chainId: 8453, verifyingContract });
    const digest = (sep: string, struct: string) => ethers.keccak256(ethers.concat(["0x1901", sep, struct]));
    const recovers = (sep: string, struct: string, sig: string) =>
      expect(ethers.recoverAddress(digest(sep, struct), sig)).toBe(wallet.address);
    const orderId = CAST_BASELINE.orderId;
    const addr = (b: string) => "0x" + b.repeat(20);

    recovers(
      CAST_SEPARATORS.openAuth.v1,
      openAuthStructHash(orderId, "1900000000"),
      await signOpenAuth(wallet, d(CAST_SEPARATORS.openAuth.verifyingContract), orderId, "1900000000"),
    );
    const fa = { fillId: "0x" + "ab".repeat(32), filler: wallet.address, to: addr("77"), token: addr("88"), amount: "5", deadline: "1900000000" };
    recovers(CAST_SEPARATORS.fillAuth.v1, fillAuthStructHash(fa), await signFillAuth(wallet, d(CAST_SEPARATORS.fillAuth.verifyingContract), fa));
    recovers(
      CAST_SEPARATORS.fillAttestation.v1,
      fillAttestationStructHash(orderId, addr("77")),
      await signFillAttestation(wallet, d(CAST_SEPARATORS.fillAttestation.verifyingContract), orderId, addr("77")),
    );
    const bond = d(CAST_SEPARATORS.solverBond.verifyingContract);
    const claim = {
      orderId,
      solver: wallet.address,
      beneficiary: addr("99"),
      notional: "100000000",
      originChainId: "8453",
      escrow: CAST_BASELINE.terms.escrow,
      deadline: "1900000000",
    };
    recovers(CAST_SEPARATORS.solverBond.v2, slashAttestationStructHash(claim), await signSlashAttestation(wallet, bond, claim));
    const acc = {
      orderId,
      originChainId: "8453",
      escrow: CAST_BASELINE.terms.escrow,
      filler: wallet.address,
      deadline: "1900000000",
      fillAuth: "0x" + "cd".repeat(32),
    };
    recovers(CAST_SEPARATORS.solverBond.v2, fillAcceptanceStructHash(acc), await signFillAcceptance(wallet, bond, acc));
  });
});
