import { describe, expect, it } from "vitest";
import { linksRecoveryKind } from "../../lib/linksSignIn.js";

const OWNER = "0xAbCdEf0000000000000000000000000000000001";
const OTHER = "0xAbCdEf0000000000000000000000000000000002";

const withheld = {
  legsWithheld: true,
  ownerWallet: OWNER,
  connectedWallet: OWNER,
  sessionWallet: undefined,
};

describe("linksRecoveryKind", () => {
  it("requests a wallet sign-in only for the connected intent owner", () => {
    expect(linksRecoveryKind(withheld)).toBe("sign_in");
    expect(linksRecoveryKind({ ...withheld, sessionWallet: OWNER })).toBe("none");
  });

  it("requires a wallet switch when another wallet owns the intent", () => {
    expect(linksRecoveryKind({ ...withheld, connectedWallet: OTHER, sessionWallet: OTHER })).toBe(
      "switch_wallet",
    );
  });

  it("does not offer recovery when the record is readable", () => {
    expect(linksRecoveryKind({ ...withheld, legsWithheld: false })).toBe("none");
  });
});
