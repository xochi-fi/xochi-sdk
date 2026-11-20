import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BASE_USDC,
  extensionAvailability,
  quoteObservation,
  validInput,
} from "./compatibility.mjs";
import { assertPeerLock } from "../../scripts/verify-peer-graph.mjs";

const input = {
  environment: "staging",
  address: "0x1111111111111111111111111111111111111111",
  amount: "25000000",
  currency: "USD",
  platform: "venmo",
};
const orchestrator = "0x2222222222222222222222222222222222222222";
const now = Date.parse("2026-11-10T12:00:00Z");
function response() {
  return {
    success: true,
    responseObject: {
      token: { token: BASE_USDC, decimals: 6, chainId: 8453 },
      fiat: { currencyCode: "USD" },
      orchestratorAddress: orchestrator,
      quoteExpiresAt: "2026-11-10T12:01:00Z",
      quotes: [
        {
          tokenAmount: "25000000",
          intent: {
            processorName: "venmo",
            fiatCurrencyCode: "USD",
            chainId: "8453",
            orchestratorAddress: orchestrator,
          },
        },
      ],
    },
  };
}

test("validates atomic amounts without floating point coercion", () => {
  assert.equal(validInput(input), true);
  for (const amount of [
    "0",
    "01",
    "-1",
    "+1",
    "1.1",
    "1e6",
    " 1",
    "1\n",
    "",
    1,
    "9".repeat(79),
    (1n << 256n).toString(),
  ]) {
    assert.equal(validInput({ ...input, amount }), false);
  }
  assert.equal(validInput({ ...input, address: "0x" + "0".repeat(40) }), false);
  assert.equal(validInput({ ...input, environment: "unknown" }), false);
});

test("extension readiness is never executable availability", () => {
  for (const state of ["needs_install", "needs_connection", "ready", "unknown", undefined]) {
    assert.notEqual(extensionAvailability(state).state, "available");
  }
  assert.deepEqual(extensionAvailability("unknown"), {
    state: "availability_unknown",
    reason_code: "unknown_extension_state",
  });
  assert.deepEqual(extensionAvailability("needs_install"), {
    state: "setup_required",
    requirement_codes: ["peer_extension_install"],
  });
});

test("fresh exact V4 observations reject wrong asset, corridor, amount and expiry", () => {
  assert.equal(quoteObservation(response(), input, orchestrator, now), "fresh_quote_observed");
  const wrongToken = response();
  wrongToken.responseObject.token.token = input.address;
  assert.equal(quoteObservation(wrongToken, input, orchestrator, now), "invalid_response");
  const expired = response();
  expired.responseObject.quoteExpiresAt = "2026-11-10T11:59:59Z";
  assert.equal(quoteObservation(expired, input, orchestrator, now), "expired_or_undated");
  const noExpiry = response();
  delete noExpiry.responseObject.quoteExpiresAt;
  assert.equal(quoteObservation(noExpiry, input, orchestrator, now), "expired_or_undated");
  assert.equal(
    quoteObservation(response(), { ...input, amount: "1" }, orchestrator, now),
    "invalid_response",
  );
  assert.equal(
    quoteObservation(response(), { ...input, platform: "wise" }, orchestrator, now),
    "invalid_response",
  );
  assert.equal(quoteObservation(response(), input, input.address, now), "invalid_response");
  assert.equal(
    quoteObservation({ success: true, responseObject: { quotes: [] } }, input, orchestrator, now),
    "invalid_response",
  );
});

test("exact public lock rejects duplicate SDK copies and cash facade", async () => {
  const lock = JSON.parse(await readFile(new URL("./package-lock.json", import.meta.url), "utf8"));
  const duplicate = structuredClone(lock);
  duplicate.packages["node_modules/another/node_modules/@zkp2p/sdk"] =
    duplicate.packages["node_modules/@zkp2p/sdk"];
  assert.throws(() => assertPeerLock(duplicate), /exactly one SDK copy/);
  const oldSdk = structuredClone(lock);
  oldSdk.packages["node_modules/@zkp2p/sdk"].version = "0.15.0-rc.2";
  assert.throws(() => assertPeerLock(oldSdk), /Unexpected Peer SDK version/);
  const cash = structuredClone(lock);
  cash.packages["node_modules/@zkp2p/cash"] = { version: "0.8.0" };
  assert.throws(() => assertPeerLock(cash), /must not include cash/);
});
