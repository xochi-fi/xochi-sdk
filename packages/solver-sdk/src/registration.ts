// Solver registration: the EIP-712 `SolverRegistration` a solver signs to be
// admitted to the panel (SOLVER-RFC §3.1). Admission is bonded and
// permissionless: the venue checks that the signature recovers to `solverId`,
// that the registration names the SolverBond it advertises, and that the key's
// active stake on that bond meets the venue's minimum. It then answers a
// short-lived session token (`SolverSession`, session.ts).
//
// Same domain as the bid (`RiddlerSolver`/"2", no chainId, no
// verifyingContract): nothing verifies a registration on-chain. What scopes a
// registration to one venue is its CONTENT -- `bondChainId` + `bond` -- and
// what scopes it in time is `issuedAtMs`, which the venue holds to a window
// around its own clock (120 s either way by default). The signature is the
// credential a session is minted from, so a captured one is replayable at the
// venue that bond belongs to only inside that window.
//
// Pinned by `@xochi/spec`'s `conformance/solver-registration.json`, which the
// Riddler server's registration verifier is held to.

import { ethers } from "ethers";

import { MAX_BID_MS, SOLVER_BID_DOMAIN } from "./bid";

// The bid's domain, by reference: one domain for every struct a solver key
// signs for the venue, told apart by type hash.
export const SOLVER_REGISTRATION_DOMAIN: ethers.TypedDataDomain = SOLVER_BID_DOMAIN;

export const SOLVER_REGISTRATION_PRIMARY_TYPE = "SolverRegistration";

export const SOLVER_REGISTRATION_TYPES: Record<string, ethers.TypedDataField[]> = {
  SolverRegistration: [
    { name: "solverId", type: "address" },
    { name: "bondChainId", type: "uint256" },
    { name: "bond", type: "address" },
    { name: "issuedAtMs", type: "uint64" },
  ],
};

export const SOLVER_REGISTRATION_TYPE =
  "SolverRegistration(address solverId,uint256 bondChainId,address bond,uint64 issuedAtMs)";

// The SolverBond a registration names: the venue advertises it as
// `admission.bond` on `GET /solver/capabilities`.
export interface SolverBondRef {
  chainId: number;
  address: string;
}

// The signed struct. Both integers travel as bare JSON numbers, so each is
// bounded to 2^53-1 (the venue refuses a larger one as malformed).
export interface SolverRegistrationMessage {
  solverId: string;
  bondChainId: number;
  bond: string;
  issuedAtMs: number;
}

// The `POST /solver/register` body.
export interface SolverRegistration extends SolverRegistrationMessage {
  signature: string;
}

export interface SolverRegistrationTypedData {
  domain: ethers.TypedDataDomain;
  types: Record<string, ethers.TypedDataField[]>;
  primaryType: string;
  message: SolverRegistrationMessage;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function checkAddress(label: string, v: unknown): string {
  // `isAddress` also refuses a mixed-case spelling whose checksum is wrong:
  // that is a typo, not an address.
  if (typeof v !== "string" || !HEX_ADDRESS.test(v) || !ethers.isAddress(v)) {
    throw new Error(
      `registration ${label} must be a 0x-prefixed 20-byte address, got ${String(v)}`,
    );
  }
  return v;
}

function checkInt(label: string, v: unknown, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > MAX_BID_MS) {
    throw new Error(
      `registration ${label} must be an integer in ${min}..${MAX_BID_MS}, got ${String(v)}`,
    );
  }
  return v;
}

// Build the typed data a registration signs over. Validates rather than
// normalizes, as `bidTypedData` does.
export function registrationTypedData(
  fields: SolverRegistrationMessage,
): SolverRegistrationTypedData {
  return {
    domain: SOLVER_REGISTRATION_DOMAIN,
    types: SOLVER_REGISTRATION_TYPES,
    primaryType: SOLVER_REGISTRATION_PRIMARY_TYPE,
    message: {
      solverId: checkAddress("solverId", fields.solverId),
      bondChainId: checkInt("bondChainId", fields.bondChainId, 1),
      bond: checkAddress("bond", fields.bond),
      issuedAtMs: checkInt("issuedAtMs", fields.issuedAtMs, 0),
    },
  };
}

// keccak256(0x1901 || domainSeparator || hashStruct(message)).
export function registrationDigest(fields: SolverRegistrationMessage): string {
  const { domain, types, message } = registrationTypedData(fields);
  return ethers.TypedDataEncoder.hash(domain, types, message);
}

// Sign a registration for `bond` at `issuedAtMs` (unix ms, the signer's clock).
// `solverId` is the wallet's address. The signature is the protocol's one
// spelling: 0x + 130 lowercase hex, 65-byte r||s||v, low-s.
export async function signRegistration(
  wallet: ethers.Wallet,
  fields: { bondChainId: number; bond: string; issuedAtMs: number },
): Promise<SolverRegistration> {
  const { domain, types, message } = registrationTypedData({
    solverId: wallet.address,
    bondChainId: fields.bondChainId,
    bond: fields.bond,
    issuedAtMs: fields.issuedAtMs,
  });
  const signature = ethers.Signature.from(
    await wallet.signTypedData(domain, types, message),
  ).serialized.toLowerCase();
  return { ...message, signature };
}
