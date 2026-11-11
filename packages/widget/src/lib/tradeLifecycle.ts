/**
 * The trade lifecycle events the frame reports to its host
 * (`@xochi/widget-lib` `XochiWidgetEvent`), derived from one machine step.
 *
 * Each event names its trade by `tradeRef`, a reference this frame mints from
 * random bytes when the trade starts (`@xochi/widget-lib` `mintTradeRef`) and
 * reuses on every event of that trade. It is never the intent id nor derived
 * from it: the host page can correlate a trade's events but learns nothing it
 * could look up at the Worker. Refs live in memory only, so a trade resumed
 * after a reload is reported under a fresh one.
 *
 * - `trade:submitted`: the execute call answered and the API accepted the
 *   order: the reply neither failed the intent nor left it not sent
 *   (`intent.notSent`, the Worker's answer that it ended its own claim). A
 *   thrown execute is not reported: in doubt (transport failure), the status
 *   poll that resolves it reports the terminal outcome; not accepted (the 503
 *   the machine resends), the resend's answer reports.
 * - `trade:completed` / `trade:failed`: the intent reached a terminal status.
 *   Only for a trade the user confirmed or an already-dispatched intent resumed
 *   after reload: a quote that fails or expires while being browsed is not a
 *   trade, and reporting it would tell the host a trade failed that nobody
 *   attempted. The failure reason can be the server's unbounded status text;
 *   the bridge's `emit` cuts it to the length the host accepts.
 */

import { isTerminalIntentStatus, type Model, type MsgBody } from "@xochi/client";
import { mintTradeRef, type XochiWidgetEvent } from "@xochi/widget-lib";

/**
 * The events one step produced. `attempted` maps the intent ids whose terminal
 * outcomes belong to the host to their trade refs; the caller keeps it across
 * steps and it never leaves the frame.
 */
export function tradeEvents(
  before: Model,
  after: Model,
  body: MsgBody,
  attempted: Map<string, string>,
): XochiWidgetEvent[] {
  const events: XochiWidgetEvent[] = [];
  const intentId = after.intent.intentId;
  const status = after.intent.status;
  /** The trade ref of `id`, minted the first time the trade is attempted. */
  const adopt = (id: string): string => {
    const known = attempted.get(id);
    if (known !== undefined) return known;
    const minted = mintTradeRef();
    attempted.set(id, minted);
    return minted;
  };
  if (before.sign === null && after.sign !== null && intentId !== null) adopt(intentId);

  // Confirming a deposit route starts an attempt without an execute call.
  if (
    body.type === "SignRequested" &&
    before.intent.status === "quoted" &&
    status === "awaiting_deposit" &&
    intentId !== null &&
    before.intent.intentId === intentId
  ) {
    adopt(intentId);
  }

  // A reload can adopt an attempt whose execute or deposit confirmation happened
  // in the previous session. Quote-only and terminal resumes remain silent.
  if (
    body.type === "ResumeRequested" &&
    before.intent.status === "idle" &&
    !before.intent.intentId &&
    intentId &&
    body.intentId === intentId &&
    body.status === status &&
    body.owner &&
    (status === "awaiting_deposit" ||
      status === "executing" ||
      status === "bridging" ||
      status === "settling")
  ) {
    adopt(intentId);
  }

  // Mirror the machine's execute acceptance: a late reply it ignores must not
  // become a host event for whatever intent happens to be current now.
  const execute = before.sign?.stage === "execute" ? before.sign.execute : undefined;
  if (
    body.type === "ExecuteReplied" &&
    body.result.ok &&
    before.sign?.id === body.flow &&
    execute !== undefined &&
    execute.resendAt === null &&
    intentId !== null &&
    before.intent.intentId === intentId &&
    execute.request.intentId === intentId &&
    body.result.response.intentId === intentId &&
    after.intent.status !== "failed" &&
    !after.intent.notSent
  ) {
    events.push({ name: "trade:submitted", tradeRef: adopt(intentId) });
  }

  const tradeRef = intentId === null ? undefined : attempted.get(intentId);
  if (
    status !== before.intent.status &&
    isTerminalIntentStatus(status) &&
    intentId !== null &&
    tradeRef !== undefined
  ) {
    attempted.delete(intentId);
    if (status === "completed") {
      events.push({ name: "trade:completed", tradeRef });
    } else {
      const error = after.intent.error;
      const reason =
        (typeof error === "string" ? error : error?.message) ||
        (status === "failed" ? "Trade failed" : `Trade ${status}`);
      events.push({ name: "trade:failed", tradeRef, error: reason });
    }
  }
  return events;
}
