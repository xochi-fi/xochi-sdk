/// <reference types="node" />
import { Buffer } from "node:buffer";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeCbor,
  parseCoseSign1,
  parseNitroPayload,
  type CborValue as PortCborValue,
} from "../../src/attestation/parsers.js";
import {
  encodeCbor,
  encodeCoseSign1,
  loadVendoredParsers,
  normalize,
  realFixture,
  type CborValue,
  type VendoredParsersModule,
} from "./support.js";

let vendored: VendoredParsersModule;
beforeAll(async () => {
  vendored = await loadVendoredParsers();
});

type Result = { ok: true; value: unknown } | { ok: false; name: string; message: string };

/** Byte strings become plain Uint8Array copies so Buffer and Uint8Array results compare equal. */
function plain(value: CborValue | PortCborValue): unknown {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([k, v]) => [plain(k), plain(v)]));
  }
  return value;
}

function attempt(run: () => unknown): Result {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, name: error.name, message: error.message };
  }
}

function expectSameDecode(bytes: Uint8Array): void {
  // An unpooled copy: Buffer.from(Uint8Array) would allocate inside Node's shared pool.
  const unpooled = Buffer.from(Uint8Array.from(bytes).buffer);
  const node = attempt(() => plain(vendored.decodeCbor(unpooled)));
  const port = attempt(() => plain(decodeCbor(bytes)));
  expect(port, Buffer.from(bytes).toString("hex")).toEqual(node);
}

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/\s/g, ""), "hex"));

describe("decodeCbor port vs vendored decodeCbor", () => {
  const corpus: Record<string, string[]> = {
    "unsigned integers": [
      "00",
      "17",
      "1818",
      "190100",
      "1a01000000",
      "1b0000000100000000",
      "1bffffffffffffffff",
    ],
    "negative integers": ["20", "37", "3818", "3bffffffffffffffff"],
    "short 64-bit arguments": [
      "1b010203",
      "1b",
      "8200 1b0102030405",
      "830000 1b01020304050607",
      "820000 1b01020304050607",
    ],
    "short arguments": ["18", "1901", "1a010203", "3901"],
    "reserved additional information": ["1c", "1d", "1e", "3c", "5c", "fc"],
    "indefinite integers": ["1f", "3f"],
    "byte strings": [
      "40",
      "4401020304",
      "5f 4101 420203 ff",
      "5f ff",
      "5f 6161 ff",
      "4401",
      "5f 41",
    ],
    "text strings": ["60", "6161", "7f 6161 6162 ff", "7f 01 ff", "6261"],
    "text with a byte order mark": ["63efbbbf", "64efbbbf61"],
    "invalid UTF-8": ["62c328", "61ff", "63eda080", "63f09f98", "62c0af", "64f4908080"],
    arrays: ["80", "820102", "9f 01 02 ff", "9f ff", "82 01", "9f 01"],
    maps: [
      "a0",
      "a2 01 02 03 04",
      "a2 01 02 01 03",
      "bf 6161 01 ff",
      "a1 41 01 02",
      "a1 01",
      "bf 01",
    ],
    tags: ["c0 6161", "d818 00", "df 00", "d9 0100 40", "c0"],
    "simple values": [
      "f4",
      "f5",
      "f6",
      "f7",
      "f0",
      "f8 20",
      "f9 0000",
      "fa 00000000",
      "fb 0000000000000000",
    ],
    "breaks and ends": ["ff", "", "0000", "81 ff", "a1 ff"],
  };

  for (const [name, cases] of Object.entries(corpus)) {
    it(name, () => {
      for (const bytes of cases) expectSameDecode(hex(bytes));
    });
  }
});

describe("parseCoseSign1 / parseNitroPayload port vs vendored", () => {
  const fixture = realFixture();

  function expectSameCose(bytes: Uint8Array): void {
    const node = attempt(() => {
      const cose = vendored.parseCoseSign1(Buffer.from(bytes));
      return Object.fromEntries(Object.entries(cose).map(([k, v]) => [k, Uint8Array.from(v)]));
    });
    const port = attempt(() => {
      const cose = parseCoseSign1(bytes);
      return Object.fromEntries(Object.entries(cose).map(([k, v]) => [k, Uint8Array.from(v)]));
    });
    expect(port).toEqual(node);
  }

  function expectSamePayload(bytes: Uint8Array): void {
    const node = attempt(() => normalize(vendored.parseNitroPayload(Buffer.from(bytes))));
    const port = attempt(() => normalize(parseNitroPayload(bytes)));
    expect(port).toEqual(node);
  }

  const realPayload = (): Map<CborValue, CborValue> => {
    const { payloadBytes } = vendored.parseCoseSign1(Buffer.from(fixture.document));
    const payload = vendored.decodeCbor(payloadBytes);
    if (!(payload instanceof Map)) throw new Error("fixture payload is not a CBOR map");
    return payload;
  };

  function withPayload(mutate: (payload: Map<CborValue, CborValue>) => void): Uint8Array {
    const payload = realPayload();
    mutate(payload);
    return encodeCbor(payload);
  }

  it("parses the real document and payload identically", () => {
    expectSameCose(fixture.document);
    const { payloadBytes } = vendored.parseCoseSign1(Buffer.from(fixture.document));
    expectSamePayload(new Uint8Array(payloadBytes));
  });

  it("refuses malformed COSE_Sign1 envelopes identically", () => {
    const parts = vendored.parseCoseSign1(Buffer.from(fixture.document));
    const sig = parts.signature;
    const payload = parts.payloadBytes;
    const envelopes: CborValue[] = [
      [Buffer.from(parts.protectedHeaders), new Map(), payload],
      [Buffer.from(parts.protectedHeaders), new Map(), payload, sig, sig],
      new Map([[1n, 2n]]),
      "COSE",
      ["a1013822", new Map(), payload, sig],
      [Buffer.from(hex("a1013822")), new Map(), "payload", sig],
      [Buffer.from(hex("a1013822")), new Map(), payload, 96n],
      [Buffer.from(hex("01")), new Map(), payload, sig],
      [Buffer.from(hex("a0")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 6545533338 34")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 6545533338")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 18 22")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 41 22")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 82 01 02")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 a0")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 f5")), new Map(), payload, sig],
      [Buffer.from(hex("a1 01 f6")), new Map(), payload, sig],
      [Buffer.from(hex("a2 01 3822 01 26")), new Map(), payload, sig],
      [Buffer.from(hex("a1 6131 3822")), new Map(), payload, sig],
      [Buffer.from(hex("a1013822 00")), new Map(), payload, sig],
    ];
    for (const envelope of envelopes) expectSameCose(encodeCbor(envelope));
    expectSameCose(
      encodeCoseSign1({
        protectedHeaders: hex("a1013822"),
        payloadBytes: hex(""),
        signature: hex(""),
      }),
    );
  });

  it("refuses malformed Nitro payloads identically", () => {
    const pcrs = (payload: Map<CborValue, CborValue>): Map<CborValue, CborValue> =>
      payload.get("pcrs") as Map<CborValue, CborValue>;
    const mutations: ((payload: Map<CborValue, CborValue>) => void)[] = [
      (p) => p.delete("pcrs"),
      (p) => p.set("pcrs", [Buffer.alloc(48)]),
      (p) => pcrs(p).delete(0n),
      (p) => pcrs(p).delete(2n),
      (p) => pcrs(p).set(1n, Buffer.alloc(47)),
      (p) => pcrs(p).set(2n, Buffer.alloc(49)),
      (p) => pcrs(p).set(0n, "pcr0"),
      (p) => p.delete("cabundle"),
      (p) => p.set("cabundle", Buffer.alloc(4)),
      (p) => p.set("cabundle", [Buffer.alloc(4), "cert"]),
      (p) => p.set("cabundle", []),
      (p) => p.delete("certificate"),
      (p) => p.set("certificate", "cert"),
      (p) => p.set("module_id", 7n),
      (p) => p.delete("module_id"),
      (p) => p.set("digest", Buffer.from("SHA384")),
      (p) => p.set("timestamp", "1793016426538"),
      (p) => p.set("timestamp", -5n),
      (p) => p.delete("timestamp"),
      (p) => p.set("public_key", Buffer.alloc(64, 1)),
      (p) => p.set("public_key", Buffer.concat([Buffer.of(4), Buffer.alloc(64, 2)])),
      (p) => p.set("public_key", Buffer.concat([Buffer.of(3), Buffer.alloc(64, 2)])),
      (p) => p.set("public_key", Buffer.alloc(33, 2)),
      (p) => p.set("public_key", "key"),
      (p) => p.set("user_data", "data"),
      (p) => p.set("user_data", Buffer.alloc(0)),
      (p) => p.set("nonce", Buffer.alloc(32, 9)),
      (p) => p.set("nonce", 1n),
      (p) => p.set("extra", [new Map(), true, null]),
    ];
    for (const mutate of mutations) expectSamePayload(withPayload(mutate));
    for (const payload of [[], "payload", 1n, new Map()] as CborValue[]) {
      expectSamePayload(encodeCbor(payload));
    }
  });
});
