// The chain/token registry the spec generators and vector suites sign against.
// Copied from the retired taker CLI's config, minus everything only the CLI
// read (server URLs, API keys, the signing key from env, the solver-address
// check): a reference fixture must not change with the shell it runs in, so
// those are fixed here and a caller that signs supplies its own PRIVATE_KEY.
import { PERMIT2_ADDRESS, type ChainConfig, type SignerConfig } from "@xochi/signer";

export const CONFIG: SignerConfig = {
  PRIVATE_KEY: "",

  CHAINS: {
    ethereum: {
      chainId: 1,
      name: "Ethereum",
      usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      usdcName: "USD Coin",
      usdcVersion: "2",
      rpc: process.env.ETH_RPC || "https://eth.llamarpc.com",
      explorerUrl: "https://etherscan.io",
      isTestnet: false,
    },
    base: {
      chainId: 8453,
      name: "Base",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      weth: "0x4200000000000000000000000000000000000006",
      usdcName: "USD Coin",
      usdcVersion: "2",
      rpc: process.env.BASE_RPC || "https://mainnet.base.org",
      explorerUrl: "https://basescan.org",
      isTestnet: false,
    },
    optimism: {
      chainId: 10,
      name: "Optimism",
      usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      usdt: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      weth: "0x4200000000000000000000000000000000000006",
      usdcName: "USD Coin",
      usdcVersion: "2",
      rpc: process.env.OP_RPC || "https://mainnet.optimism.io",
      explorerUrl: "https://optimistic.etherscan.io",
      isTestnet: false,
    },
    arbitrum: {
      chainId: 42161,
      name: "Arbitrum One",
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      usdcName: "USD Coin",
      usdcVersion: "2",
      rpc: process.env.ARB_RPC || "https://arb1.arbitrum.io/rpc",
      explorerUrl: "https://arbiscan.io",
      isTestnet: false,
    },
    polygon: {
      chainId: 137,
      name: "Polygon",
      usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      usdcName: "USD Coin",
      usdcVersion: "2",
      rpc: process.env.POLYGON_RPC || "https://polygon-rpc.com",
      explorerUrl: "https://polygonscan.com",
      isTestnet: false,
    },
    // Robinhood Chain settles USDG only. USDG has no ERC-3009 and no EIP-2612,
    // so its origin pull signs via Permit2 (hence no usdcName/usdcVersion here).
    // Mirrors Riddler chain_registry (4663) + token_registry (USDG) and xochi
    // SETTLEABLE_CHAIN_IDS. No public USDC/USDT on this chain.
    robinhood: {
      chainId: 4663,
      name: "Robinhood Chain",
      usdc: null,
      usdt: null,
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      rpc: process.env.ROBINHOOD_RPC || null,
      explorerUrl: "https://robinhoodchain.blockscout.com",
      isTestnet: false,
    },
    // Arc (5042): Circle's EVM L1 where USDC is the native gas token (18-dec at
    // protocol level, 6-dec as an ERC-20). No ETH, no WETH -- stablecoin only.
    // Mirrors Riddler chain_registry (5042) and xochi SUPPORTED_CHAIN_IDS.
    // Flag-gated server-side: Riddler omits it from the public surface until
    // ENABLE_ARC, and xochi dual-gates it on Riddler advertising solver support
    // (xochi-fi/xochi#499), so quote it only when capabilities advertise it.
    arc: {
      chainId: 5042,
      name: "Arc",
      usdc: "0x3600000000000000000000000000000000000000",
      usdt: null,
      weth: null,
      rpc: process.env.ARC_RPC || null,
      explorerUrl: "https://explorer.arc.io",
      isTestnet: false,
      flagGated: "enable_arc",
    },

    // Testnets:
    "eth-sepolia": {
      chainId: 11155111,
      name: "Ethereum Sepolia",
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      usdt: "0xaa8e23Fb1079EA71e0a56F48a2aA51851D8433D0", // matches Riddler token_registry
      weth: null, // No canonical testnet WETH wired; mainnet-only
      usdcName: "USDC",
      usdcVersion: "2",
      rpc: process.env.ETH_SEPOLIA_RPC || "https://rpc.sepolia.org",
      explorerUrl: "https://sepolia.etherscan.io",
      isTestnet: true,
    },
    "op-sepolia": {
      chainId: 11155420,
      name: "Optimism Sepolia",
      usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
      usdt: null, // No USDT liquidity on testnet
      weth: null,
      usdcName: "USDC",
      usdcVersion: "2",
      rpc: process.env.OP_SEPOLIA_RPC || "https://sepolia.optimism.io",
      explorerUrl: "https://sepolia-optimism.etherscan.io",
      isTestnet: true,
    },
    "base-sepolia": {
      chainId: 84532,
      name: "Base Sepolia",
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      usdt: null, // No USDT liquidity on testnet
      weth: null,
      usdcName: "USDC",
      usdcVersion: "2",
      rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      explorerUrl: "https://sepolia.basescan.org",
      isTestnet: true,
    },
    "arb-sepolia": {
      chainId: 421614,
      name: "Arbitrum Sepolia",
      usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      usdt: null, // No USDT liquidity on testnet
      weth: null,
      usdcName: "USD Coin",
      usdcVersion: "2",
      rpc: process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      explorerUrl: "https://sepolia.arbiscan.io",
      isTestnet: true,
    },

    // Tron has no EVM rpc and no client signing, but it is BOTH a settlement
    // destination and -- via the deposit-address path -- a first-class ORIGIN.
    // As an origin the user sends a TRC-20 to a per-intent deposit address the
    // server allocates and attests; there is nothing to sign, so `rpc: null`
    // still holds and no Tron key ever reaches @xochi/signer.
    //
    // Every T-address here is base58 and CASE-SENSITIVE. Pass them to quote
    // params verbatim: never run one through ethers.getAddress/checksum, and
    // never case-fold one. Downcasing a T-address yields a different,
    // still-plausible address (Riddler #826).
    //
    // Kept out of the conformance generator (hardcoded EVM chain lists), so
    // these entries are inert there.
    tron: {
      chainId: 728126428,
      name: "Tron",
      usdc: process.env.TRON_USDC_ADDRESS || "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
      usdt: process.env.TRON_USDT_ADDRESS || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      weth: null, // no canonical WETH on Tron
      rpc: null,
      explorerUrl: "https://tronscan.org",
      isTestnet: false,
      isTron: true,
      flagGated: "enable_tron",
    },
    // Tron Shasta (2494104990) and Nile (3448148188) were listed here and are
    // not in Riddler's registry at all: `@testnet_chain_ids` is
    // [84532, 11155111, 421614, 11155420] (`integrations/xochi/config.ex`).
    // Quoting either returned `route_unsupported`, so they were a menu of
    // failures. Re-add only alongside the server entry.
  },

  // Permit2 address is universal across all EVM chains.
  PERMIT2_ADDRESS,

  TEST_SOLVER_WALLET: null,
  VALIDATE_SOLVER_ADDRESS: false,
};

// Atomic-unit decimals per supported token symbol. Stablecoins are 6; WETH is
// 18. Used to size human amounts into smallest units (1 USDC = 1e6, 1 WETH =
// 1e18). Unknown tokens default to 6 (the stablecoin convention).
const TOKEN_DECIMALS: Record<string, number> = { usdc: 6, usdt: 6, usdg: 6, weth: 18 };

// Resolve a token symbol to its per-chain address. Returns null when the chain
// is unknown or the token is not configured on that chain. Throws on an
// unrecognized symbol rather than silently falling back to USDC -- a wrong-token
// resolution on a funds path is a latent loss (e.g. a `usdg` typo must not sign
// a USDC pull).
export function getTokenAddress(chainKey: string, token: string = "usdc"): string | null {
  const chain = CONFIG.CHAINS[chainKey];
  if (!chain) return null;
  switch (token.toLowerCase()) {
    case "usdc":
      return chain.usdc;
    case "usdt":
      return chain.usdt;
    case "usdg":
      return chain.usdg ?? null;
    case "weth":
      return chain.weth;
    default:
      throw new Error(`Unsupported token symbol: '${token}' (expected usdc, usdt, usdg, or weth)`);
  }
}

export function getTokenDecimals(token: string = "usdc"): number {
  return TOKEN_DECIMALS[token.toLowerCase()] ?? 6;
}

export function getChainByChainId(chainId: number): ChainConfig | null {
  return Object.values(CONFIG.CHAINS).find((chain) => chain.chainId === chainId) ?? null;
}

export function getChainKeyByChainId(chainId: number): string | null {
  return Object.entries(CONFIG.CHAINS).find(([, chain]) => chain.chainId === chainId)?.[0] ?? null;
}

// True for non-EVM Tron chains, whether used as a destination or as an origin.
// Callers must never EVM-sign against these or run their base58 addresses
// through ethers.getAddress/checksum.
//
// As an ORIGIN a Tron chain routes through the deposit-address path rather than
// an origin pull: the quote carries `deposit_address` instead of
// `pull_authorization`, and there is no signature to produce. See
// `xochiDepositQuote` in deposit.ts.
export function isTronChain(chainKey: string): boolean {
  return !!CONFIG.CHAINS[chainKey]?.isTron;
}
