/**
 * Classify a caught error for @xochi/client, which never sees an Error object
 * (its messages are JSON so a session can be logged and replayed).
 */

import type { ErrorReport } from "@xochi/client";
import { ApiError } from "@xochi/client";
import { isUserRejection } from "./eip712.js";

/**
 * An ApiError becomes a StructuredError so the UI can categorize by code or
 * machine category and (on 429/503) run the retry countdown; any other Error
 * degrades to its message; a non-Error throw carries no value, and the machine
 * supplies the fallback copy for the step that failed. `notAccepted` is set only from
 * `ApiError.notAccepted` (`@xochi/client`'s transport: the Worker's
 * not-accepted execute answer), never from anything else: it is the one flag
 * that lets the machine resend an execute (client README "Fund safety").
 */
export function reportError(err: unknown): ErrorReport {
  const value =
    err instanceof ApiError
      ? {
          message: err.message,
          code: err.code,
          retryAfter: err.retryAfter,
          ...(err.errorCategory ? { errorCategory: err.errorCategory } : {}),
        }
      : err instanceof Error
        ? err.message
        : null;
  return {
    rejected: isUserRejection(err),
    value,
    detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    ...(err instanceof ApiError && err.notAccepted ? { notAccepted: true } : {}),
  };
}
