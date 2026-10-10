/**
 * API types shared by the client and the Worker.
 */

import type { SettlementType } from "./intents.js";

export interface SettlementOption {
  type: SettlementType;
  available: boolean;
  reason?: string;
}
