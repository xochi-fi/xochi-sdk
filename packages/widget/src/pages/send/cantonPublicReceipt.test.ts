import { readFileSync } from "node:fs";
import { CANTON_MAINNET_CHAIN_ID } from "@xochi/client";
import { expect, it, vi } from "vitest";
import { checkCantonPublicReceipt } from "./cantonPublicReceipt.js";

const example = JSON.parse(
  readFileSync(
    new URL("../../test/fixtures/canton-mainnet-public-delivery.json", import.meta.url),
    "utf8",
  ),
);
const completion = {
  updateId: "12206da9ccc65eb84d9b26f583176fb47c7e0a9d7103f49da1f20a739c81771f1ca2",
};
const expected = {
  chainId: CANTON_MAINNET_CHAIN_ID,
  sender: "user_06Af0605::12207aebff402bab27d81f9dd90f7b4152eac113c3590de88d0613bc2fc5dcc8a3e9",
  recipient: "user_C9FCf6B2::1220c9db965444bfae7bea31ef155fec1e6730562324925dc6ebcaa095ba53e37cbd",
  amount: "13.2834594833",
};
const feed = (body = example) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));

it("binds the completion to the genuine 13.2834594833 CC delivery", async () => {
  const client = feed();
  await expect(checkCantonPublicReceipt(completion, expected, client)).resolves.toEqual({
    kind: "public-scan-match",
  });
  expect(client).toHaveBeenCalledExactlyOnceWith(
    `https://api.cantonnodes.com/v2/updates/${completion.updateId}`,
    expect.objectContaining({ credentials: "omit", redirect: "error" }),
  );
});

it.each([
  { recipient: expected.recipient.replace("C9FC", "c9fc") },
  { amount: "13.2834594834" },
  { amount: "309.0607062194" },
  { sender: expected.recipient },
])("rejects a mismatch against independent expectations %j", async (override) => {
  await expect(
    checkCantonPublicReceipt(completion, { ...expected, ...override }, feed()),
  ).resolves.toEqual({ kind: "mismatch" });
});

it("binds the response ID and MainNet synchronizer", async () => {
  const wrongId = { updateId: `1220${"a".repeat(64)}` };
  await expect(checkCantonPublicReceipt(wrongId, expected, feed())).resolves.toEqual({
    kind: "mismatch",
  });
  await expect(
    checkCantonPublicReceipt(completion, expected, feed({ ...example, synchronizer_id: "other" })),
  ).resolves.toEqual({ kind: "mismatch" });
});

it("excludes change even if its owner and amount look like the expected delivery", async () => {
  const evidence = structuredClone(example);
  const root = evidence.events_by_id[evidence.root_event_ids[0]];
  const output = root.exercise_result.output.value;
  const change = root.exercise_result.senderChangeCids[0];
  const created = Object.values(evidence.events_by_id).find(
    (node) => (node as { contract_id: string }).contract_id === change,
  ) as { create_arguments: { owner: string; amount: { initialAmount: string } } };
  created.create_arguments.owner = expected.recipient;
  created.create_arguments.amount.initialAmount = expected.amount;
  output.receiverHoldingCids = [change];
  await expect(checkCantonPublicReceipt(completion, expected, feed(evidence))).resolves.toEqual({
    kind: "malformed",
  });
});

it("checks delivered amount and authentic template independently of the factory arguments", async () => {
  const evidence = structuredClone(example);
  const created = evidence.events_by_id[`${completion.updateId}:3`];
  created.create_arguments.amount.initialAmount = "13.2834594834";
  await expect(checkCantonPublicReceipt(completion, expected, feed(evidence))).resolves.toEqual({
    kind: "mismatch",
  });
  created.create_arguments.amount.initialAmount = expected.amount;
  created.template_id = created.template_id.replace(/^[^:]+/, "fake");
  await expect(checkCantonPublicReceipt(completion, expected, feed(evidence))).resolves.toEqual({
    kind: "mismatch",
  });
});

it("distinguishes unavailable and malformed evidence", async () => {
  await expect(checkCantonPublicReceipt(completion, expected, feed({}))).resolves.toEqual({
    kind: "malformed",
  });
  await expect(
    checkCantonPublicReceipt(completion, expected, vi.fn().mockRejectedValue(new TypeError())),
  ).resolves.toEqual({ kind: "unavailable" });
  await expect(
    checkCantonPublicReceipt(
      completion,
      expected,
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    ),
  ).resolves.toEqual({ kind: "unavailable" });
  await expect(
    checkCantonPublicReceipt(
      completion,
      expected,
      vi.fn().mockResolvedValue(new Response("bad JSON")),
    ),
  ).resolves.toEqual({ kind: "malformed" });
});

it("cannot use an authentic output from a separate root", async () => {
  const evidence = structuredClone(example);
  const deliveryId = `${completion.updateId}:3`;
  const preapproval = evidence.events_by_id[`${completion.updateId}:1`];
  preapproval.child_event_ids = preapproval.child_event_ids.filter(
    (id: string) => id !== deliveryId,
  );
  evidence.root_event_ids.push(deliveryId);
  await expect(checkCantonPublicReceipt(completion, expected, feed(evidence))).resolves.toEqual({
    kind: "malformed",
  });
});

it("rejects unsupported chains and excess CC precision before fetching", async () => {
  const client = feed();
  await expect(
    checkCantonPublicReceipt(completion, { ...expected, chainId: 1 }, client),
  ).resolves.toEqual({
    kind: "unsupported",
  });
  await expect(
    checkCantonPublicReceipt(completion, { ...expected, amount: "13.28345948330" }, client),
  ).resolves.toEqual({
    kind: "malformed",
  });
  expect(client).not.toHaveBeenCalled();
});
