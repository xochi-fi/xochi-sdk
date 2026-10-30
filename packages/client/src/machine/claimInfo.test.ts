/**
 * Client-side claim_info gate.
 *
 * Last check before the served factory is trusted. The client cannot verify the
 * stealth ADDRESS at quote time (the solver picks the ephemeral key, so the
 * address is only derivable once announced), which is precisely why the factory
 * has to carry the weight.
 */
import { describe, it, expect } from "vitest";
import { SIMPLE_ACCOUNT_FACTORY } from "../shared/index.js";
import { claimInfoError } from "./claimInfo.js";
import { Session, ctx, intentTypedData, logs, quote, walletCalls } from "./test/session.js";

/** Tests use Ethereum L1, one of the chains with a trusted factory. */
const MAINNET = 1;

const ATTACKER_FACTORY = "0xAbC0000000000000000000000000000000000123";

describe("claimInfoError", () => {
  it("accepts the shipped factory at salt 0", () => {
    expect(claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 0 }, MAINNET)).toBeNull();
  });

  it("rejects a factory this build does not ship", () => {
    const err = claimInfoError({ factoryAddress: ATTACKER_FACTORY, salt: 0 }, MAINNET);
    expect(err).not.toBeNull();
    expect(err?.code).toBe("untrusted_factory");
  });

  it("rejects an unexpected salt", () => {
    expect(
      claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 1 }, MAINNET),
    ).not.toBeNull();
  });

  // An omitted factory must not pass by being absent. That is the free win an
  // attacker gets if "missing" is treated as "fine".
  it("rejects claim_info with no factory at all", () => {
    expect(claimInfoError({ salt: 0 }, MAINNET)).not.toBeNull();
    expect(claimInfoError({ factoryAddress: "", salt: 0 }, MAINNET)).not.toBeNull();
  });

  // A public or shielded quote carries no claim_info; that is not an error.
  it("passes a non-stealth quote through", () => {
    expect(claimInfoError(undefined, MAINNET)).toBeNull();
    expect(claimInfoError(null, MAINNET)).toBeNull();
    expect(claimInfoError(undefined, MAINNET, "public")).toBeNull();
    expect(claimInfoError(null, MAINNET, "shielded")).toBeNull();
  });

  // A stealth request answered without claim_info names no factory at all.
  it("rejects a stealth quote with no claim_info", () => {
    expect(claimInfoError(undefined, MAINNET, "stealth")?.code).toBe("untrusted_factory");
    expect(claimInfoError(null, MAINNET, "stealth")?.code).toBe("untrusted_factory");
  });

  it("tolerates an absent salt on an otherwise trusted factory", () => {
    expect(claimInfoError({ factoryAddress: SIMPLE_ACCOUNT_FACTORY }, MAINNET)).toBeNull();
  });
});

/**
 * The same gate driven through the quote machine: the REQUESTED settlement
 * decides whether an absent `claim_info` is fine.
 */
describe("claim_info at quote ingest", () => {
  const stealthMetaAddress = {
    spendingPubKey: `0x02${"11".repeat(32)}`,
    viewingPubKey: `0x03${"22".repeat(32)}`,
    chainId: 8453,
  } as const;
  const stealthCtx = () =>
    ctx({ toChainId: 8453, settlementPreference: "stealth", stealthMetaAddress });
  const stealthIntent = () => intentTypedData({ toChainId: 8453, settlementPreference: "stealth" });

  it("refuses an executable stealth quote that carries no claim_info", () => {
    const s = new Session(stealthCtx());
    const fx = s.quoteWith(quote({ eip712Data: stealthIntent(), claimInfo: undefined }));
    expect(s.intent.status).toBe("failed");
    expect(s.intent.quote).toBeNull();
    expect(s.intent.error).toBe(
      "This private quote names no account factory to check. Send this one public, or try again later.",
    );
    expect(logs(fx, "error").some((l) => l.includes("Stealth claim info rejected"))).toBe(true);
    expect(walletCalls(s.send({ type: "SignRequested" }), "signTypedData")).toHaveLength(0);
  });

  it("accepts the same stealth quote when it names the shipped factory", () => {
    const s = new Session(stealthCtx());
    s.quoteWith(
      quote({
        eip712Data: stealthIntent(),
        claimInfo: { factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 0 },
      }),
    );
    expect(s.intent.status).toBe("quoted");
  });

  it("passes a public quote that carries no claim_info", () => {
    const s = new Session();
    s.quoteWith(quote({ claimInfo: undefined }));
    expect(s.intent.status).toBe("quoted");
    expect(s.intent.error).toBeNull();
  });
});
