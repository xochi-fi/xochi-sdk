// @vitest-environment jsdom

import { beforeEach, expect, it } from "vitest";
import { readRecentRecipients, rememberRecipient } from "./recent.js";

beforeEach(() => localStorage.clear());

it("keeps the five newest unique recipients, newest first", () => {
  for (const input of ["one.eth", "two.eth", "three.eth", "four.eth", "five.eth", "six.eth"]) {
    rememberRecipient({ input, kind: "ens" });
  }
  rememberRecipient({ input: "two.eth", kind: "ens" });
  expect(readRecentRecipients()).toEqual([
    "two.eth",
    "six.eth",
    "five.eth",
    "four.eth",
    "three.eth",
  ]);
});

it("ignores malformed storage", () => {
  localStorage.setItem("xochi.swap.recentRecipients", "{");
  expect(readRecentRecipients()).toEqual([]);
  localStorage.setItem(
    "xochi.swap.recentRecipients",
    JSON.stringify(["alice.eth", {}, " ", "alice.eth"]),
  );
  expect(readRecentRecipients()).toEqual(["alice.eth"]);
});
