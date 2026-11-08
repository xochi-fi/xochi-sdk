import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BrowserKeystoreCrypto,
  MIN_PASSPHRASE_LENGTH,
} from "../../../src/browser/keystore/index.js";
import { SealError, type SealKind } from "../../../src/ports.js";

/** tools/recipient/src/sealed.ts, the CLI's implementation. Loaded at run time because it lies
 *  outside this package's rootDir, so typed here structurally. */
interface NodeSealed {
  seal(kind: SealKind, plaintext: Buffer, passphrase: string): Buffer;
  open(kind: SealKind, sealed: Buffer, passphrase: string): Buffer;
}
const NODE_SEALED = new URL("../../../../../tools/recipient/src/sealed.ts", import.meta.url);
const node = (await import(fileURLToPath(NODE_SEALED))) as NodeSealed;

const PASSPHRASE = "correct horse battery staple";
const PLAINTEXT = new TextEncoder().encode('{"secret":"0x01","salt":"0x02"}');
const KINDS: SealKind[] = ["keystore", "backup"];

/** The refusal as both implementations report it; the GCM failure's cause text is engine-specific. */
async function refusal(attempt: () => unknown): Promise<{ name: string; message: string }> {
  try {
    await attempt();
  } catch (error) {
    const { name, message } = error as Error;
    return { name, message: message.replace(/ \(.*\)$/s, "") };
  }
  throw new Error("expected a refusal");
}

describe("BrowserKeystoreCrypto against tools/recipient sealed.ts", () => {
  const browser = new BrowserKeystoreCrypto();

  it.each(KINDS)("seals a %s that the Node implementation opens", async (kind) => {
    const sealed = await browser.seal(kind, PLAINTEXT, PASSPHRASE);
    const opened = node.open(kind, Buffer.from(sealed), PASSPHRASE);
    expect(new Uint8Array(opened)).toEqual(PLAINTEXT);
  });

  it.each(KINDS)("opens a %s the Node implementation sealed", async (kind) => {
    const sealed = node.seal(kind, Buffer.from(PLAINTEXT), PASSPHRASE);
    expect(await browser.open(kind, new Uint8Array(sealed), PASSPHRASE)).toEqual(PLAINTEXT);
  });

  it("normalizes the passphrase with NFKC like the Node implementation", async () => {
    const ligatures = "\ufb01".repeat(12);
    const plain = "fi".repeat(12);
    const fromNode = node.seal("backup", Buffer.from(PLAINTEXT), plain);
    expect(await browser.open("backup", new Uint8Array(fromNode), ligatures)).toEqual(PLAINTEXT);
    const fromBrowser = await browser.seal("backup", PLAINTEXT, ligatures);
    expect(new Uint8Array(node.open("backup", Buffer.from(fromBrowser), plain))).toEqual(PLAINTEXT);
  });

  it("refuses a passphrase shorter than the minimum when sealing, like Node", async () => {
    const short = "x".repeat(MIN_PASSPHRASE_LENGTH - 1);
    const expected = await refusal(() => node.seal("backup", Buffer.from(PLAINTEXT), short));
    expect(expected).toEqual({
      name: "SealError",
      message: `passphrase shorter than ${MIN_PASSPHRASE_LENGTH} characters`,
    });
    expect(await refusal(() => browser.seal("backup", PLAINTEXT, short))).toEqual(expected);
  });

  describe("refusals when opening", () => {
    let sealed: Uint8Array;

    beforeAll(() => {
      sealed = new Uint8Array(node.seal("backup", Buffer.from(PLAINTEXT), PASSPHRASE));
    });

    const flipped = (index: number): Uint8Array => {
      const copy = sealed.slice();
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      return copy;
    };
    const short = "x".repeat(MIN_PASSPHRASE_LENGTH - 1);

    const cases: [string, () => Uint8Array, SealKind, string, string][] = [
      ["kind mismatch", () => sealed, "keystore", PASSPHRASE, "not a sealed keystore"],
      ["kind mismatch, short passphrase", () => sealed, "keystore", short, "not a sealed"],
      ["wrong passphrase", () => sealed, "backup", `${PASSPHRASE}!`, "did not open"],
      ["short passphrase", () => sealed, "backup", short, "passphrase shorter"],
      ["truncated below the header", () => sealed.slice(0, 75), "backup", PASSPHRASE, "not a"],
      ["truncated tag", () => sealed.slice(0, -1), "backup", PASSPHRASE, "did not open"],
      ["tampered magic", () => flipped(0), "backup", PASSPHRASE, "not a sealed backup"],
      ["tampered salt", () => flipped(16), "backup", PASSPHRASE, "did not open"],
      ["tampered iv", () => flipped(48), "backup", PASSPHRASE, "did not open"],
      ["tampered ciphertext", () => flipped(60), "backup", PASSPHRASE, "did not open"],
      ["tampered tag", () => flipped(sealed.length - 1), "backup", PASSPHRASE, "did not open"],
    ];

    it.each(cases)("%s: both refuse identically", async (_, bytes, kind, passphrase, says) => {
      const input = bytes();
      const expected = await refusal(() => node.open(kind, Buffer.from(input), passphrase));
      expect(expected.name).toBe("SealError");
      expect(expected.message).toContain(says);
      expect(await refusal(() => browser.open(kind, input, passphrase))).toEqual(expected);
      await expect(browser.open(kind, input, passphrase)).rejects.toBeInstanceOf(SealError);
    });
  });
});
