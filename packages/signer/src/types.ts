// Signing-relevant types for @xochi/signer. Pure types, zero runtime code.
// Wire/response bodies are deliberately permissive (`unknown` at the edge): the
// server-served EIP-712 signable MUST reach the signer untouched, so over-typing
// it would invite coercing casts that change the digest.

export type Hex = `0x${string}`;

// Per-chain shape the ERC-3009/Permit2 signers read (a subset of the taker
// SDK's RiddlerConfig.CHAINS entries).
export interface ChainConfig {
  chainId: number;
  name: string;
  usdc: string | null;
  usdt: string | null;
  usdg?: string | null;
  weth: string | null;
  usdcName?: string; // EIP-712 domain name (ERC-3009)
  usdcVersion?: string; // EIP-712 domain version (ERC-3009)
  rpc: string | null;
  explorerUrl: string;
  isTestnet: boolean;
  isTron?: boolean;
  /**
   * Server-side protocol flag this chain waits on (Riddler
   * `@flag_gated_chain_ids`). While the flag is off the venue omits the chain
   * from `/chains`, `/routes` and `/capabilities` and refuses routes through
   * it, so an entry here means "addressable once enabled", NOT "quotable now".
   * Resolve the live set from `/xochi/capabilities` (`servedChainKeys`),
   * never from this table alone.
   */
  flagGated?: "enable_tron" | "enable_arc";
}

// The server-served EIP-712 blob. Values are intentionally loose -- they must
// reach the signer UNTOUCHED (never through a coercing/transforming validator).
// ethers derives the domain hash (incl. `salt`) from `domain`.
//
// "Untouched" is about not REWRITING, not about not LOOKING. The signers refuse
// a blob whose schema is not one they recognise (`assertKnownSchema`) and the
// taker SDK refuses one whose values are not what was requested; neither mutates,
// so the bytes that reach `signTypedData` are the server's either way. Sign-as-is
// without either check is a signing oracle.
export interface Eip712Domain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

export interface Eip712TypeField {
  name: string;
  type: string;
}

export interface Eip712Signable {
  domain: Eip712Domain;
  primaryType?: string;
  types: Record<string, Eip712TypeField[]>;
  message: Record<string, unknown>;
}

export interface SignResult {
  signature: string;
  signedObject: string | null;
}

// Minimal config surface the ERC-3009/Permit2 signers read from the config
// object. The taker SDK's runtime `RiddlerConfig`/`CONFIG` structurally
// satisfies this (it has these fields plus SERVERS/DEFAULT_SERVER), so a
// consumer can pass its own config object as-is.
//
// NOTE: signERC3009/signPermit2 also read `config.PRIVATE_KEY` (to construct
// the signing wallet) -- that field is included below even though it is not
// itself chain/solver config, because it is genuinely required for the
// signers to run.
export interface SignerConfig {
  CHAINS: Record<string, ChainConfig>;
  PERMIT2_ADDRESS: string;
  TEST_SOLVER_WALLET: string | null;
  VALIDATE_SOLVER_ADDRESS: boolean;
  PRIVATE_KEY: string;
}
