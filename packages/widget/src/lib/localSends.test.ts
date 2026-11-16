// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../constants.js";
import {
  listLocalSends,
  parseSendRecord,
  subscribeLocalSends,
  upsertLocalSend,
  type SendActivityItem,
} from "./localSends.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x3333333333333333333333333333333333333333";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const send = (n: number, over: Partial<SendActivityItem> = {}): SendActivityItem => ({
  id: hash(n),
  type: "send",
  timestamp: 1_000 + n,
  status: "pending",
  data: {
    chainId: 8453,
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
    amount: "1500000",
    recipient: "0x2222222222222222222222222222222222222222",
    txHash: hash(n),
  },
  ...over,
});

afterEach(() => window.localStorage.clear());

describe("local send log", () => {
  it("keeps each wallet's sends under its own key, newest first", () => {
    upsertLocalSend(WALLET, send(1));
    upsertLocalSend(WALLET, send(2));
    upsertLocalSend(OTHER, send(3));
    expect(listLocalSends(WALLET).map((s) => s.id)).toEqual([hash(2), hash(1)]);
    expect(listLocalSends(OTHER).map((s) => s.id)).toEqual([hash(3)]);
    expect(
      window.localStorage.getItem(`${STORAGE_KEYS.localSendsPrefix}${WALLET.toLowerCase()}`),
    ).not.toBeNull();
    // The swap log is untouched.
    expect(
      window.localStorage.getItem(`${STORAGE_KEYS.localActivityPrefix}${WALLET.toLowerCase()}`),
    ).toBeNull();
  });

  it("updates a send's status by hash and keeps its time", () => {
    upsertLocalSend(WALLET, send(1));
    upsertLocalSend(WALLET, send(1, { status: "completed", timestamp: 9_999 }));
    expect(listLocalSends(WALLET)).toEqual([send(1, { status: "completed" })]);
  });

  it("caps the log", () => {
    for (let n = 1; n <= 60; n += 1) upsertLocalSend(WALLET, send(n));
    const ids = listLocalSends(WALLET).map((s) => s.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(hash(60));
  });

  it("notifies subscribers on a write", () => {
    let calls = 0;
    const unsubscribe = subscribeLocalSends(() => (calls += 1));
    upsertLocalSend(WALLET, send(1));
    unsubscribe();
    upsertLocalSend(WALLET, send(2));
    expect(calls).toBe(1);
  });

  it("drops stored rows that are not exactly a send", () => {
    const key = `${STORAGE_KEYS.localSendsPrefix}${WALLET.toLowerCase()}`;
    window.localStorage.setItem(
      key,
      JSON.stringify([
        send(1),
        { ...send(2), data: { ...send(2).data, amount: "1.5" } },
        { ...send(3), data: { ...send(3).data, recipient: "javascript:alert(1)" } },
        { ...send(4), id: hash(5) },
        { ...send(6), status: "unknown" },
        "garbage",
      ]),
    );
    expect(listLocalSends(WALLET).map((s) => s.id)).toEqual([hash(1)]);
    window.localStorage.setItem(key, "{not json");
    expect(listLocalSends(WALLET)).toEqual([]);
  });

  it("refuses to write a malformed row", () => {
    upsertLocalSend(WALLET, send(1, { data: { ...send(1).data, amount: "-5" } }));
    expect(listLocalSends(WALLET)).toEqual([]);
    expect(parseSendRecord(send(1))).toEqual(send(1));
  });
});
