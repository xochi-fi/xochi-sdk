// ERC-3009 / Permit2 sign-only composition: the signature from @xochi/signer
// plus the locally rebuilt domain, types, message and digest, which is the shape
// `conformance/conformance.json` pins. The ACP buyer-auth lives in Riddler's
// private e2e harness.
import { ethers } from "ethers";
import {
  signERC3009,
  signPermit2,
  ERC3009_TYPES,
  PERMIT2_TYPES,
  type ChainConfig,
  type Eip712TypeField,
  type Quote,
  type SignerConfig,
} from "@xochi/signer";

// Locally-constructed EIP-712 domain for the on-chain-verified protocols
// (erc3009/permit2). Distinct from the shared `Eip712Domain` (which models the
// server-served, sign-as-is blob): `verifyingContract` here can legitimately be
// null (a chain with no USDC configured), and that null must reach
// TypedDataEncoder untouched -- no coercion to undefined.
interface LocalDomain {
  name?: string;
  version?: string;
  chainId: number;
  verifyingContract?: string | null;
}

// Domain/message helpers mirror the signer's signing.ts; the conformance suite gates drift.
function erc3009Domain(chainConfig: ChainConfig): LocalDomain {
  return {
    name: chainConfig.usdcName || "USD Coin",
    version: chainConfig.usdcVersion || "2",
    chainId: chainConfig.chainId,
    verifyingContract: chainConfig.usdc,
  };
}

function permit2Domain(chainConfig: ChainConfig, permit2Address: string): LocalDomain {
  return {
    name: "Permit2",
    chainId: chainConfig.chainId,
    verifyingContract: permit2Address,
  };
}

function erc3009Message(quote: Quote, walletAddress: string) {
  return {
    from: walletAddress,
    to: quote.gasless.to,
    value: BigInt(quote.request.inputAmount).toString(),
    validAfter: 0,
    validBefore: quote.quoteExpires,
    nonce: normalizeBytes32(quote.gasless.nonce),
  };
}

function permit2Message(quote: Quote, tokenAddress: string) {
  return {
    permitted: {
      token: tokenAddress,
      amount: BigInt(quote.request.inputAmount).toString(),
    },
    spender: quote.gasless.to,
    nonce: BigInt(quote.gasless.nonce as string).toString(),
    deadline: quote.quoteExpires,
    witness: {
      orderId: normalizeBytes32(quote.gasless.orderId as string),
    },
  };
}

function normalizeBytes32(value: string | Uint8Array): string {
  if (typeof value === "string" && value.startsWith("0x")) {
    const hex = value.slice(2);
    if (hex.length > 64) {
      throw new Error(`normalizeBytes32: input is ${hex.length / 2} bytes, expected <= 32`);
    }
    return "0x" + hex.padStart(64, "0").toLowerCase();
  }
  return ethers.hexlify(value);
}

export interface SignOnlyResult {
  protocol: "erc3009" | "permit2";
  chain_id: number;
  signer: string;
  domain: LocalDomain;
  types: Record<string, Eip712TypeField[]>;
  message: Record<string, unknown>;
  digest: string;
  signature: string;
  signed_object: string | null;
}

export async function signOnly(
  protocol: string,
  quote: Quote,
  chain: string,
  config: SignerConfig,
): Promise<SignOnlyResult> {
  const chainConfig = config.CHAINS[chain];
  if (!chainConfig) {
    throw new Error(`Unknown chain: ${chain}`);
  }

  const wallet = new ethers.Wallet(config.PRIVATE_KEY);

  switch (protocol) {
    case "erc3009": {
      const { signature, signedObject } = await signERC3009(quote, chain, config);
      const domain = erc3009Domain(chainConfig);
      const message = erc3009Message(quote, wallet.address);
      // ERC3009_TYPES is a fixed, module-level constant -- the key always
      // exists; the non-null assertion only satisfies noUncheckedIndexedAccess.
      const erc3009Types = { ReceiveWithAuthorization: ERC3009_TYPES.ReceiveWithAuthorization! };
      const digest = ethers.TypedDataEncoder.hash(domain, erc3009Types, message);
      return {
        protocol: "erc3009",
        chain_id: chainConfig.chainId,
        signer: wallet.address,
        domain,
        types: erc3009Types,
        message,
        digest,
        signature,
        signed_object: signedObject,
      };
    }

    case "permit2": {
      const tokenAddress = quote.request.inputToken || chainConfig.usdc;
      if (!tokenAddress) {
        throw new Error(`Token address not found for permit2 on ${chain}`);
      }
      const { signature, signedObject } = await signPermit2(quote, chain, config, tokenAddress);
      const domain = permit2Domain(chainConfig, config.PERMIT2_ADDRESS);
      const message = permit2Message(quote, tokenAddress);
      const digest = ethers.TypedDataEncoder.hash(domain, PERMIT2_TYPES, message);
      return {
        protocol: "permit2",
        chain_id: chainConfig.chainId,
        signer: wallet.address,
        domain,
        types: PERMIT2_TYPES,
        message,
        digest,
        signature,
        signed_object: signedObject,
      };
    }

    default:
      throw new Error(`signOnly: unsupported protocol "${protocol}"`);
  }
}
