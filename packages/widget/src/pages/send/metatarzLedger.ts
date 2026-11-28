import { z } from "zod";
import {
  METATARZ_MAINNET,
  METATARZ_TESTNET,
  metatarzProvider,
  readMetatarzSession,
  type MetatarzLedgerRequest,
  type MetatarzProvider,
  type MetatarzSession,
} from "./metatarz.js";

const holdingInterface = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
const amuletAdmin = {
  [METATARZ_TESTNET]: "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337",
  [METATARZ_MAINNET]: "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
};
const holdingsLimit = 100;
const updateWindow = 32;

const offset = z.union([
  z.int().nonnegative(),
  z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number)
    .pipe(z.int().nonnegative()),
]);
const ledgerEnd = z.object({ offset });
const holdingView = z.object({
  owner: z.string(),
  instrumentId: z.object({ id: z.string(), admin: z.string() }),
});
const holdingEntry = z.object({
  contractEntry: z.union([
    z.object({
      JsActiveContract: z.object({
        createdEvent: z.object({
          interfaceViews: z.array(
            z.object({
              interfaceId: z.string(),
              viewStatus: z.object({ code: z.number() }),
              viewValue: z.unknown(),
            }),
          ),
        }),
      }),
    }),
    z.object({ JsIncompleteAssigned: z.object({}) }),
    z.object({ JsIncompleteUnassigned: z.object({}) }),
    z.object({ JsEmpty: z.object({}) }),
  ]),
});
const updateEntry = z.object({
  update: z.union([
    z.object({
      Transaction: z.object({
        value: z.object({ updateId: z.string().min(1), offset }),
      }),
    }),
    z.object({ OffsetCheckpoint: z.object({}) }),
    z.object({ Reassignment: z.object({}) }),
    z.object({ TopologyTransaction: z.object({}) }),
  ]),
});

export type LedgerCheck = {
  offset: string;
  holdings?: string;
  update?: string;
};

function providerError(error: unknown): string {
  if (error instanceof z.ZodError) return "Unexpected ledger response.";
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const detail =
    typeof message === "string"
      ? message
          .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
          .replace(
            /[^\s"'<>]+::[^\s"'<>]+|https?:\/\/\S+|(?:0x)?[a-f0-9]{32,}|[\w+/=-]{48,}/gi,
            "[redacted]",
          )
          .trim()
          .slice(0, 220)
      : "";
  return (
    [Number.isSafeInteger(code) ? String(code) : "", detail].filter(Boolean).join(" ") ||
    "Ledger request failed."
  );
}

export async function checkMetatarzLedger(
  provider: MetatarzProvider,
  connection: Extract<MetatarzSession, { kind: "connected" }>,
  target: { id: string; offset: string },
  signal: AbortSignal,
): Promise<LedgerCheck> {
  const { primaryParty: party, networkId } = connection;
  async function verifyParty() {
    const session = await readMetatarzSession(provider, false, "active", signal);
    if (
      provider !== metatarzProvider() ||
      session.kind !== "connected" ||
      session.primaryParty !== party ||
      session.networkId !== networkId
    ) {
      throw new Error("The active Canton network or party changed.");
    }
  }

  async function read(params: MetatarzLedgerRequest) {
    await verifyParty();
    signal.throwIfAborted();
    const result = await provider.request({ method: "ledgerApi", params });
    signal.throwIfAborted();
    return result;
  }

  let end: number;
  try {
    ({ offset: end } = ledgerEnd.parse(
      await read({ requestMethod: "GET", resource: "/v2/state/ledger-end" }),
    ));
  } catch (error) {
    return { offset: `Ledger end: ${providerError(error)}` };
  }

  const result: LedgerCheck = { offset: `Ledger offset: ${end}` };
  try {
    const entries = z.array(holdingEntry).parse(
      await read({
        requestMethod: "POST",
        resource: "/v2/state/active-contracts",
        query: { limit: holdingsLimit },
        body: {
          activeAtOffset: end,
          eventFormat: {
            filtersByParty: {
              [party]: {
                cumulative: [
                  {
                    identifierFilter: {
                      InterfaceFilter: {
                        value: { interfaceId: holdingInterface, includeInterfaceView: true },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const holdings = entries.flatMap(({ contractEntry }) => {
      if (!("JsActiveContract" in contractEntry)) return [];
      const view = contractEntry.JsActiveContract.createdEvent.interfaceViews.find(
        ({ interfaceId }) => interfaceId.endsWith(":Splice.Api.Token.HoldingV1:Holding"),
      );
      if (view?.viewStatus.code !== 0) throw new Error("Holding interface view unavailable.");
      return [holdingView.parse(view.viewValue)];
    });
    const count = holdings.filter(
      ({ owner, instrumentId }) =>
        owner === party &&
        instrumentId.admin === amuletAdmin[networkId] &&
        instrumentId.id === "Amulet",
    ).length;
    result.holdings = `Active CC holdings: ${count}${entries.length >= holdingsLimit ? " (first 100 entries)" : ""}`;
  } catch (error) {
    result.holdings = `Holdings: ${providerError(error)}`;
  }

  if (target.id && end === 0) result.update = "Update lookup: ledger is at offset 0.";
  if (target.id && end > 0) {
    try {
      const targetOffset = target.offset ? offset.safeParse(target.offset) : undefined;
      if (
        targetOffset &&
        (!targetOffset.success || targetOffset.data < 1 || targetOffset.data > end)
      ) {
        throw new Error("Enter an update offset between 1 and the ledger end.");
      }
      const upper = targetOffset?.data ?? end;
      const begin = targetOffset ? upper - 1 : Math.max(0, upper - updateWindow);
      const entries = z.array(updateEntry).parse(
        await read({
          requestMethod: "POST",
          resource: "/v2/updates/flats",
          body: {
            beginExclusive: begin,
            endInclusive: upper,
            updateFormat: {
              includeTransactions: {
                eventFormat: {
                  filtersByParty: {
                    [party]: {
                      cumulative: [{ identifierFilter: { WildcardFilter: { value: {} } } }],
                    },
                  },
                },
                transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
              },
            },
          },
        }),
      );
      const match = entries.find(
        ({ update }) =>
          "Transaction" in update &&
          update.Transaction.value.updateId === target.id &&
          update.Transaction.value.offset > begin &&
          update.Transaction.value.offset <= upper,
      );
      result.update = match
        ? "Update found in the party’s ledger view."
        : `No matching update visible at offsets ${begin + 1}–${upper}.`;
    } catch (error) {
      result.update = `Update lookup: ${providerError(error)}`;
    }
  }
  await verifyParty();
  return result;
}
