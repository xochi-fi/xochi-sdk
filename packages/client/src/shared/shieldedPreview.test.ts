import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ShieldedFeeBreakdownSchema,
  ShieldedPreviewResponseSchema,
  ShieldedPreviewSchema,
  decodeShieldedPreview,
} from "./shieldedPreview.js";

const WIRE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../spec/wire/openapi.json",
);

const b32 = (byte: string) => "0x" + byte.repeat(32);
const a20 = (byte: string) => "0x" + byte.repeat(20);

const response = () => ({
  executable: false,
  preview_version: "xochi.shielded.preview.v1",
  preview_digest: b32("aa"),
  recipient_binding_digest: b32("bb"),
  domain: { name: "Xochi Shielded Preview", version: "1", chain_id: 84532, salt: b32("cc") },
  preview: {
    protocol_version: "xochi.shielded.preview.v1",
    environment: "staging",
    source: {
      chain_id: 84532,
      token_address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      wallet: a20("11"),
      collector: a20("c1"),
      amount: "1005000",
    },
    destination: {
      settlement_type: "shielded",
      privacy_level: "private",
      disclosure_profile: "recipient-private-public-amount-v1",
      rail: "a_tracer",
      network: {
        aztec_chain_id: "11155111",
        protocol_version: "3924331020",
        rollup_address: a20("a1"),
        l1_chain_id: "11155111",
        genesis_or_network_digest: b32("9e"),
      },
      corridor: { corridor_id: b32("c0"), revision: 1, manifest_digest: b32("4d") },
      asset_id: "aztec-testnet-xtu",
      token_address: "0x13b600d8f842babc98a7130dcb79a2d1f4f0ba22569b2fb99f3ecc3b5c39282b",
      recipient_binding_id: "bnd_0001",
      recipient_descriptor_digest: b32("d5"),
      recipient_address: b32("1c"),
      amount: "1000000",
      fee_payer: "0x" + "0f".repeat(31) + "01",
    },
    fee_breakdown: {
      gas_floor: "5000",
      solver_fee_bps: 18,
      solver_fee: "1800",
      price_impact_bps: 0,
      price_impact: "0",
      venue_fee_bps: 10,
      venue_fee: "1000",
      routing_fee_bps: 12,
      routing_fee: "1200",
      total_bps: 40,
      total_fee: "5000",
    },
    refund_address: a20("11"),
    refund_amount: "1005000",
    collect_before: 1900000000,
    settlement_service_deadline: 1900003600,
    recipient_binding_digest: b32("bb"),
    policy_revision: 1,
  },
  manifest: {
    manifest_digest: b32("4d"),
    aztec_sdk_version: "6.0.0",
    recipient_account_class_id:
      "0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15",
  },
});

describe("decodeShieldedPreview", () => {
  it("decodes a served preview", () => {
    expect(decodeShieldedPreview(response()).preview.destination.rail).toBe("a_tracer");
  });

  it("refuses an executable answer, a b_panel rail and an EVM-sized recipient", () => {
    expect(() => decodeShieldedPreview({ ...response(), executable: true })).toThrow();
    const bPanel = response();
    bPanel.preview.destination.rail = "b_panel";
    expect(() => decodeShieldedPreview(bPanel)).toThrow();
    const evm = response();
    evm.preview.destination.recipient_address = a20("1c");
    expect(() => decodeShieldedPreview(evm)).toThrow();
  });

  it("refuses a fee breakdown whose total is not max(gas_floor, layers)", () => {
    // Adding the floor on top of the layers is the wrong rule: the floor is a minimum.
    const added = response();
    added.preview.fee_breakdown.total_fee = "9000";
    expect(() => decodeShieldedPreview(added)).toThrow(/max\(gas_floor, layers\)/);
    const off = response();
    off.preview.fee_breakdown.total_fee = "5001";
    expect(() => decodeShieldedPreview(off)).toThrow(/max\(gas_floor, layers\)/);
  });

  it("names exactly the members the vendored wire contract requires", () => {
    const schemas = JSON.parse(fs.readFileSync(WIRE, "utf8")).components.schemas;
    const required = (name: string) => [...schemas[name].required].sort();
    expect(Object.keys(ShieldedPreviewResponseSchema.shape).sort()).toEqual(
      required("ShieldedPreviewResponse"),
    );
    expect(Object.keys(ShieldedPreviewSchema.shape).sort()).toEqual(required("ShieldedPreview"));
    expect(Object.keys(ShieldedFeeBreakdownSchema.shape).sort()).toEqual(
      required("ShieldedFeeBreakdown"),
    );
  });
});
