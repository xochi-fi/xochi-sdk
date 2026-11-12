import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { awsNitroRootDer } from "../src/oxide/enclave.js";

describe("enclave trust anchor without node:crypto", () => {
  it("decodes the AWS Nitro root to the DER the corridor pins", () => {
    const der = awsNitroRootDer();
    expect(der[0]).toBe(0x30);
    expect(keccak256(der)).toBe(OXDAI_MAINNET_REV2.oxide.rootCaCertHash);
  });
});
