/**
 * useRampSummaries
 *
 * The sanitized local Peer onramp summaries (ramp/recovery/summaries), kept
 * live by their pub/sub and by `storage` events from other tabs, so a purchase
 * started in Buy shows in Activity at once and a reload resumes it.
 */

import { useEffect, useState } from "react";
import {
  listRampSummaries,
  subscribeRampSummaries,
  type RampOperationSummary,
} from "../ramp/recovery/summaries.js";

export function useRampSummaries(): RampOperationSummary[] {
  const [rows, setRows] = useState<RampOperationSummary[]>(listRampSummaries);
  useEffect(() => {
    const refresh = () => setRows(listRampSummaries());
    refresh();
    window.addEventListener("storage", refresh);
    const unsubscribe = subscribeRampSummaries(refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      unsubscribe();
    };
  }, []);
  return rows;
}
