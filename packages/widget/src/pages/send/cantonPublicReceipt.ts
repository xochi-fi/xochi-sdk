import { CANTON_MAINNET_CHAIN_ID, isCantonPartyId } from "@xochi/client";
import { z } from "zod";
import { parseTokenAmount } from "../../utils/format.js";

const scan = "https://api.cantonnodes.com/v2/updates/";
const updateIdPattern = /^1220[0-9a-f]{64}$/;
const namespace = "1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const admin = `DSO::${namespace}`;
// Reviewed Splice Amulet 0.1.24 and its CIP-0056 factory interface.
const amuletPackage = "17b6f7c18efec9022dde39a19039783c68490a722e8a5088b22ee034678171a2";
const factory = `${amuletPackage}:Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules`;
const factoryInterface =
  "55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281:Splice.Api.Token.TransferInstructionV1:TransferFactory";
const amulet = `${amuletPackage}:Splice.Amulet:Amulet`;
// The hosted widget CSP disallows dynamic JavaScript compilation.
const parseOptions = { jitless: true };
const nonempty = z.string().min(1);
const event = z.object({
  event_id: nonempty,
  event_type: z.enum(["created_event", "exercised_event"]),
  template_id: nonempty,
  contract_id: nonempty,
  child_event_ids: z.array(nonempty).optional(),
  consuming: z.boolean().optional(),
  interface_id: z.string().nullable().optional(),
  choice: z.string().optional(),
  choice_argument: z.unknown().optional(),
  exercise_result: z.unknown().optional(),
  create_arguments: z.unknown().optional(),
});
const update = z.object({
  update_id: nonempty,
  synchronizer_id: nonempty,
  root_event_ids: z.array(nonempty).min(1),
  events_by_id: z.record(z.string(), event),
});
const delivery = z.object({
  expectedAdmin: z.literal(admin),
  transfer: z.object({
    sender: nonempty,
    receiver: nonempty,
    amount: nonempty,
    instrumentId: z.object({ admin: z.literal(admin), id: z.literal("Amulet") }),
  }),
});
const completed = z.object({
  output: z.object({
    tag: z.literal("TransferInstructionResult_Completed"),
    value: z.object({ receiverHoldingCids: z.array(nonempty).min(1) }),
  }),
  senderChangeCids: z.array(nonempty),
});
const holding = z.object({
  dso: z.literal(admin),
  owner: nonempty,
  amount: z.object({ initialAmount: nonempty }),
});

export type PublicReceiptExpectation = {
  chainId: number;
  sender: string;
  recipient: string;
  amount: string;
};

export type PublicReceiptEvidence = {
  kind: "public-scan-match" | "mismatch" | "malformed" | "unavailable" | "unsupported";
};

function ccAtoms(value: string): bigint | undefined {
  if (!/^\d{1,28}(?:\.\d{1,10})?$/.test(value)) return;
  const atoms = parseTokenAmount(value, 10);
  return atoms > 0n ? atoms : undefined;
}

function subtree(
  roots: string[],
  events: z.infer<typeof update>["events_by_id"],
  updateId: string,
) {
  const pending = [...roots];
  const visited = new Map<string, z.infer<typeof event>>();
  while (pending.length) {
    const id = pending.pop()!;
    const node = events[id];
    if (!node || node.event_id !== id || !id.startsWith(`${updateId}:`) || visited.has(id)) return;
    if (node.event_type === "exercised_event" && !node.child_event_ids) return;
    visited.set(id, node);
    pending.push(...(node.child_event_ids ?? []));
  }
  return visited;
}

function verifyUpdate(
  raw: unknown,
  updateId: string,
  expected: PublicReceiptExpectation,
  amount: bigint,
): PublicReceiptEvidence {
  const parsed = update.safeParse(raw, parseOptions);
  if (!parsed.success) return { kind: "malformed" };
  const record = parsed.data;
  if (record.update_id !== updateId || record.synchronizer_id !== `global-domain::${namespace}`)
    return { kind: "mismatch" };
  const tree = subtree(record.root_event_ids, record.events_by_id, updateId);
  if (!tree || tree.size !== Object.keys(record.events_by_id).length) return { kind: "malformed" };
  // This prototype handles direct factory roots only. It rejects ambiguous
  // batches instead of attributing unrelated creations to a completion.
  const roots = record.root_event_ids.map((id) => tree.get(id)!);
  const transfers = roots.filter(
    (node) =>
      node.event_type === "exercised_event" &&
      node.template_id === factory &&
      node.interface_id === factoryInterface &&
      node.choice === "TransferFactory_Transfer",
  );
  const transfer = transfers.length === 1 ? transfers[0] : undefined;
  if (!transfer) return { kind: "unsupported" };
  const args = delivery.safeParse(transfer.choice_argument, parseOptions);
  const result = completed.safeParse(transfer.exercise_result, parseOptions);
  if (!args.success || !result.success) return { kind: "unsupported" };
  const intent = args.data.transfer;
  if (
    intent.sender !== expected.sender ||
    intent.receiver !== expected.recipient ||
    ccAtoms(intent.amount) !== amount
  )
    return { kind: "mismatch" };

  const children = subtree(transfer.child_event_ids!, record.events_by_id, updateId)!;
  const outputs = result.data.output.value.receiverHoldingCids;
  const change = new Set(result.data.senderChangeCids);
  if (new Set(outputs).size !== outputs.length || outputs.some((id) => change.has(id)))
    return { kind: "malformed" };
  const consumed = new Set(
    [...tree.values()].filter((node) => node.consuming).map((node) => node.contract_id),
  );
  let delivered = 0n;
  for (const id of outputs) {
    const creates = [...children.values()].filter(
      (node) => node.event_type === "created_event" && node.contract_id === id,
    );
    if (creates.length !== 1 || consumed.has(id)) return { kind: "malformed" };
    const created = creates[0];
    const payload = holding.safeParse(created.create_arguments, parseOptions);
    if (
      created.template_id !== amulet ||
      !payload.success ||
      payload.data.owner !== expected.recipient
    )
      return { kind: "mismatch" };
    const atoms = ccAtoms(payload.data.amount.initialAmount);
    if (atoms === undefined) return { kind: "malformed" };
    delivered += atoms;
  }
  return { kind: delivered === amount ? "public-scan-match" : "mismatch" };
}

/** Public Scan evidence only. Expectations come from the transfer, never Scan. */
export async function checkCantonPublicReceipt(
  completion: { updateId: string },
  expected: PublicReceiptExpectation,
  fetchUpdate: typeof fetch = fetch,
): Promise<PublicReceiptEvidence> {
  const { updateId } = completion;
  const amount = ccAtoms(expected.amount);
  if (expected.chainId !== CANTON_MAINNET_CHAIN_ID) return { kind: "unsupported" };
  if (
    !updateIdPattern.test(updateId) ||
    !isCantonPartyId(expected.sender) ||
    !isCantonPartyId(expected.recipient) ||
    amount === undefined
  )
    return { kind: "malformed" };

  let response: Response;
  try {
    response = await fetchUpdate(scan + updateId, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "unavailable" };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "malformed" };
  }
  return verifyUpdate(payload, updateId, expected, amount);
}
