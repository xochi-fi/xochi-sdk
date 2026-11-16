import { isChainId, type RampMoney } from "@xochi/client";
import { listLocalSwaps } from "../../lib/localActivity.js";
import type { SwapActivityItem } from "../../types/activity.js";

/** Existing Xochi activity holds its public intent reference; only a widget reference is added. */
export function findOnrampRoute(
  wallet: string,
  operationId: string,
  delivered: RampMoney,
): SwapActivityItem | undefined {
  if (delivered.asset.kind !== "crypto") return;
  const token = delivered.asset.asset_id.split(":").at(-1)?.toLowerCase();
  return listLocalSwaps(wallet).find(
    (row) =>
      row?.rampOperationId === operationId &&
      row.type === "swap" &&
      row.data &&
      /^[A-Za-z0-9_-]{1,128}$/.test(row.id) &&
      row.data.fromChainId === 8453 &&
      typeof row.data.fromToken === "string" &&
      row.data.fromToken.toLowerCase() === token &&
      row.data.fromAmount === delivered.atomic &&
      isChainId(row.data.toChainId),
  );
}
