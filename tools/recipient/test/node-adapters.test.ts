import { describe, expect, it } from "vitest";

import { SealedKeystoreKeySource } from "../src/node/data-dir.js";
import { NodeKeystoreCrypto } from "../src/node/sealed.js";

describe("CLI key source", () => {
  it("is the sealed keystore kind (never the passkey backup mode)", () => {
    const source = new SealedKeystoreKeySource(
      "/nonexistent/keystore.sealed",
      async () => "unused passphrase",
      new NodeKeystoreCrypto(),
    );
    expect(source.kind).toBe("keystore");
  });
});
