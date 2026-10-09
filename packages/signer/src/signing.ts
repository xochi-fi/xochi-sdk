import { ethers } from "ethers";
import { debugEnabled } from "./debug";
import type { Eip712TypeField, SignerConfig, SignResult } from "./types";

const DEBUG = debugEnabled();
function debug(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// Quote shapes are intentionally loose (server-served values must reach the
// signer untouched -- see types.ts). These interfaces only pin the fields this
// module reads/writes.
export interface QuoteRequest {
  inputAmount: string | number | bigint;
  refundAddress?: string;
  inputToken?: string;
}

export interface QuoteGasless {
  to: string;
  nonce: string | Uint8Array;
  orderId?: string;
  type?: string;
}

export interface Quote {
  request: QuoteRequest;
  quoteExpires: number;
  gasless: QuoteGasless;
}

export const ERC3009_TYPES: Record<string, Eip712TypeField[]> = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export const PERMIT2_TYPES: Record<string, Eip712TypeField[]> = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "OriginPullWitness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  OriginPullWitness: [{ name: "orderId", type: "bytes32" }],
};

function requireChain(config: SignerConfig, chainKey: string) {
  const chainConfig = config.CHAINS[chainKey];
  if (!chainConfig) {
    throw new Error(`Unknown chain: ${chainKey}`);
  }
  return chainConfig;
}

/**
 * Normalizes a quote's ERC-3009 `nonce` to the 32 bytes the `bytes32` field
 * needs.
 *
 * A 0x-hex nonce shorter than 32 bytes is LEFT-padded. That is the reference
 * normalization the server mirrors, so removing it would break any quote that
 * carries a short nonce. The Python/Go/Rust conformance runners instead reject
 * a non-32-byte nonce outright (see each `sdks/<lang>/README`) because they are
 * checked against a fixture whose vectors are all full-width; this is the one
 * input class where the reference is deliberately more permissive.
 *
 * Over-length is not the same case. There is no correct way to fit 33 bytes
 * into `bytes32`, and the previous `.slice(0, 64)` silently discarded the tail
 * -- producing a signature over a nonce the server never issued, which fails
 * later as an unexplained rejected pull rather than here as a bad input. Fail
 * loud instead: nothing legitimate produces one.
 *
 * Both accepted spellings go through the same rules. A `Uint8Array` used to skip
 * every check and hand ethers whatever it held, so a 33-byte array died on
 * ethers' generic "invalid length for bytes32" while `"0x" + 66 chars` got the
 * message naming the size, and a 16-byte array was rejected outright while
 * `"0x1234"` was left-padded and signed. Same input, two spellings, two
 * policies: the normalization is either right for both or right for neither.
 */
function normalizeErc3009Nonce(nonce: string | Uint8Array): string {
  let hex: string;
  if (typeof nonce === "string" && nonce.startsWith("0x")) {
    hex = nonce.slice(2);
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error(`ERC-3009 nonce is not valid hex: ${nonce}`);
    }
  } else {
    // Byte arrays (and anything else BytesLike) reduce to the same hex string;
    // hexlify rejects what is not BytesLike at all.
    hex = ethers.hexlify(nonce).slice(2);
  }

  if (hex.length > 64) {
    throw new Error(
      `ERC-3009 nonce is ${hex.length} hex chars (${Math.ceil(hex.length / 2)} bytes), which does ` +
        `not fit bytes32 -- refusing to truncate a nonce the server issued: ${ethers.hexlify("0x" + hex)}`,
    );
  }

  return "0x" + hex.padStart(64, "0").toLowerCase();
}

export async function signERC3009(quote: Quote, inputChain: string, config: SignerConfig): Promise<SignResult> {
  const wallet = new ethers.Wallet(config.PRIVATE_KEY);
  const chainConfig = requireChain(config, inputChain);

  debug("\n   Signing ERC-3009 ReceiveWithAuthorization...");
  debug(`   Wallet: ${wallet.address}`);

  if (quote.request.refundAddress && wallet.address.toLowerCase() !== quote.request.refundAddress.toLowerCase()) {
    console.warn(`WARNING: Wallet address (${wallet.address}) does not match refundAddress (${quote.request.refundAddress})`);
  }

  const domain = {
    name: chainConfig.usdcName || "USD Coin",
    version: chainConfig.usdcVersion || "2",
    chainId: chainConfig.chainId,
    verifyingContract: chainConfig.usdc,
  };

  // ERC3009_TYPES is a fixed, module-level constant -- the key always exists;
  // the non-null assertion only satisfies noUncheckedIndexedAccess.
  const erc3009TypesForSigning = { ReceiveWithAuthorization: ERC3009_TYPES.ReceiveWithAuthorization! };

  const normalizedNonce = normalizeErc3009Nonce(quote.gasless.nonce);

  const solverAddress = quote.gasless.to;
  debug(`   Solver: ${solverAddress}`);

  if (config.VALIDATE_SOLVER_ADDRESS && config.TEST_SOLVER_WALLET) {
    if (solverAddress.toLowerCase() !== config.TEST_SOLVER_WALLET.toLowerCase()) {
      throw new Error(`Solver address mismatch: quote has ${solverAddress}, expected ${config.TEST_SOLVER_WALLET}`);
    }
  }

  const message = {
    from: wallet.address,
    to: solverAddress,
    value: BigInt(quote.request.inputAmount),
    validAfter: 0,
    validBefore: quote.quoteExpires,
    nonce: normalizedNonce,
  };

  if (DEBUG) {
    debug("\n   Domain:", JSON.stringify(domain));
    debug(
      "   Message:",
      JSON.stringify({
        from: message.from,
        to: message.to,
        value: message.value.toString(),
        validAfter: message.validAfter,
        validBefore: message.validBefore,
        nonce: message.nonce,
      }),
    );
    try {
      debug(`   Domain Separator: ${ethers.TypedDataEncoder.hashDomain(domain)}`);
      debug(
        `   Struct Hash: ${ethers.TypedDataEncoder.hashStruct(
          "ReceiveWithAuthorization",
          erc3009TypesForSigning,
          message,
        )}`,
      );
      debug(
        `   EIP-712 Hash: ${ethers.TypedDataEncoder.hash(
          domain,
          erc3009TypesForSigning,
          message,
        )}`,
      );
    } catch (error) {
      debug(`   Could not compute message hash: ${(error as Error).message}`);
    }
  }

  const signature = await wallet.signTypedData(
    domain,
    erc3009TypesForSigning,
    message,
  );

  debug(`   Signature: ${signature.substring(0, 20)}...`);

  if (DEBUG) {
    try {
      const recovered = ethers.verifyTypedData(
        domain,
        erc3009TypesForSigning,
        message,
        signature,
      );
      debug(`   Recovery: ${recovered === wallet.address ? "OK" : "MISMATCH " + recovered}`);
    } catch (error) {
      debug(`   Recovery failed: ${(error as Error).message}`);
    }
  }

  const nonceBytes = ethers.dataSlice(normalizedNonce, 0, 32);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const signedObject = abiCoder.encode(
    ["address", "address", "uint256", "uint256", "uint256", "bytes32"],
    [message.from, message.to, message.value, message.validAfter, message.validBefore, nonceBytes],
  );
  debug(`   signedObject length: ${signedObject.length}`);

  return { signature, signedObject };
}

export async function signPermit2(
  quote: Quote,
  inputChain: string,
  config: SignerConfig,
  inputTokenAddress: string | null = null,
): Promise<SignResult> {
  const wallet = new ethers.Wallet(config.PRIVATE_KEY);
  const chainConfig = requireChain(config, inputChain);

  if (!quote.gasless || !quote.gasless.orderId) {
    throw new Error("Quote must include orderId in gasless.orderId for Permit2 witness signing");
  }

  const domain = {
    name: "Permit2",
    chainId: chainConfig.chainId,
    verifyingContract: config.PERMIT2_ADDRESS,
  };

  // PERMIT2_TYPES is a fixed, module-level constant -- these keys always
  // exist; the non-null assertions only satisfy noUncheckedIndexedAccess.
  const permit2TypesForSigning = {
    PermitWitnessTransferFrom: PERMIT2_TYPES.PermitWitnessTransferFrom!,
    TokenPermissions: PERMIT2_TYPES.TokenPermissions!,
    OriginPullWitness: PERMIT2_TYPES.OriginPullWitness!,
  };

  const nonce = BigInt(quote.gasless.nonce as string);

  let orderId = quote.gasless.orderId;
  if (!orderId.startsWith("0x")) {
    orderId = "0x" + orderId;
  }
  if (orderId.length !== 66) {
    throw new Error(`orderId must be 32 bytes (66 hex chars), got ${orderId.length} chars: ${orderId}`);
  }

  const solverAddress = quote.gasless.to;
  debug(`   Spender: ${solverAddress}`);

  if (config.VALIDATE_SOLVER_ADDRESS && config.TEST_SOLVER_WALLET) {
    if (solverAddress.toLowerCase() !== config.TEST_SOLVER_WALLET.toLowerCase()) {
      throw new Error(`Solver address mismatch: quote has ${solverAddress}, expected ${config.TEST_SOLVER_WALLET}`);
    }
  }

  const tokenAddress = inputTokenAddress || quote.request?.inputToken || chainConfig.usdc;
  if (!tokenAddress) {
    throw new Error(
      `Token address not found. Provide inputTokenAddress parameter, quote.request.inputToken, or configure USDC for ${inputChain}`,
    );
  }
  debug(`   Token: ${tokenAddress}`);

  const message = {
    permitted: {
      token: tokenAddress,
      amount: BigInt(quote.request.inputAmount),
    },
    spender: solverAddress,
    nonce: nonce,
    deadline: quote.quoteExpires,
    witness: {
      orderId: orderId,
    },
  };

  debug("   Signing Permit2 PermitWitnessTransferFrom...");
  debug(`   Wallet: ${wallet.address}`);

  if (quote.request.refundAddress && wallet.address.toLowerCase() !== quote.request.refundAddress.toLowerCase()) {
    console.warn(`WARNING: Wallet address (${wallet.address}) does not match refundAddress (${quote.request.refundAddress})`);
  }

  if (DEBUG) {
    debug("   Domain:", JSON.stringify(domain));
    debug(
      "   Message:",
      JSON.stringify({
        token: message.permitted.token,
        amount: message.permitted.amount.toString(),
        spender: message.spender,
        nonce: message.nonce.toString(),
        deadline: message.deadline,
        orderId: message.witness.orderId,
      }),
    );
    try {
      debug(`   Domain Separator: ${ethers.TypedDataEncoder.hashDomain(domain)}`);
      const witnessTypeHash = ethers.keccak256(ethers.toUtf8Bytes("OriginPullWitness(bytes32 orderId)"));
      const witnessStructHash = ethers.keccak256(ethers.concat([witnessTypeHash, orderId]));
      debug(`   Witness Struct Hash: ${witnessStructHash}`);
      debug(
        `   EIP-712 Hash: ${ethers.TypedDataEncoder.hash(
          domain,
          permit2TypesForSigning,
          message,
        )}`,
      );
    } catch (error) {
      debug(`   Could not compute message hash: ${(error as Error).message}`);
    }
  }

  const signature = await wallet.signTypedData(
    domain,
    permit2TypesForSigning,
    message,
  );

  debug(`   Signature: ${signature.substring(0, 20)}...`);

  if (DEBUG) {
    try {
      const recovered = ethers.verifyTypedData(
        domain,
        permit2TypesForSigning,
        message,
        signature,
      );
      debug(`   Recovery: ${recovered === wallet.address ? "OK" : "MISMATCH " + recovered}`);
    } catch (error) {
      debug(`   Recovery failed: ${(error as Error).message}`);
    }
  }

  // The permit struct as Riddler expects it: five static words, flat.
  //
  // Encoding this as `tuple(tuple(address,uint256),address,uint256,uint256)`
  // yields the same five words -- an all-static tuple is encoded inline, with NO
  // offset pointer -- so the offset-stripping pass this replaces never ran. It
  // was guarded by a value-dependent heuristic (`offset < 1000 && offset >= 32`)
  // that read the first word, which is `permitted.token`, as a candidate offset:
  // a token address low enough to fall in that window would have been read as an
  // offset and the encoding silently truncated. `parseInt` over 64 hex chars also
  // returns a lossy float, so that comparison was float arithmetic on a
  // fund-moving encoding.
  //
  // Encoding the fields directly makes the layout structural rather than
  // inferred. Byte-identical to what the heuristic produced; the bytes are pinned
  // by `packages/spec/conformance/conformance.json`, so a drift fails CI.
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const signedObject = abiCoder.encode(
    ["address", "uint256", "address", "uint256", "uint256"],
    [message.permitted.token, message.permitted.amount, message.spender, message.nonce, message.deadline],
  );
  debug(`   signedObject length: ${signedObject.length}`);

  return { signature, signedObject };
}
