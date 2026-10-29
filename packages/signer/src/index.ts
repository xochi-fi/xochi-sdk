// Public library entry point -- a pure, side-effect-free re-export barrel of
// network-free EIP-712 / stealth signing primitives. No HTTP, no CLI.

export * from "./types";
export * from "./signing";
export * from "./xochi-signing";
export * from "./stealth";
export * from "./erc4337";
export * from "./escrow";
export * from "./xsp";
export * from "./shielded";
export * from "./shielded-recipient";
export * from "./shielded-recipient-acks";
export * from "./shielded-readiness";
export * from "./permit2";
export * from "./intent-verify";
export * from "./claim-verify";
export * from "./deposit-verify";
export * from "./capabilities";
export { sameAddressish, sameNumeric } from "./compare";
