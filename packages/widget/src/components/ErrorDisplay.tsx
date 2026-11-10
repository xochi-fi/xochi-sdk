/**
 * ErrorDisplay Component
 *
 * Displays error messages with retry functionality.
 * Supports both raw string errors and structured error objects
 * with status codes, retry timers, and categorized messaging.
 *
 * The category/copy mapping lives in `../lib/errorCategory` so the swap result
 * view can reuse the exact same friendly copy.
 */

import { useMemo, useState, useEffect } from "react";
import type { StructuredError } from "@xochi/client";
import { getErrorInfo, MAY_HAVE_MOVED_NOTICE } from "../lib/errorCategory.js";

// ============================================================
// Types
// ============================================================

interface ErrorDisplayProps {
  /** Error message or structured error object */
  error: string | StructuredError | null;
  /** Callback when retry is clicked */
  onRetry?: () => void;
  /** Whether a retry is in progress */
  isRetrying?: boolean;
  /** Optional custom class name */
  className?: string;
  /** Solver-supported origin tokens for the "what you can send" copy. */
  originTokens?: readonly string[];
  /** Machine category from the declined quote or structured HTTP failure. */
  errorCategory?: string;
  /**
   * The intent ended `may-have-moved`: show that ending's notice instead of the
   * categorized copy, and never a Retry beside it.
   */
  mayHaveMoved?: boolean;
}

// ============================================================
// Countdown Hook
// ============================================================

/**
 * Seconds remaining until an ABSOLUTE unix-seconds `retryAfter`, or null when the
 * target is absent or already past. Pure so it can seed the hook's initial state
 * (server render / first paint show the countdown without waiting for an effect).
 */
export function computeRemaining(retryAfter?: number): number | null {
  if (!retryAfter) return null;
  const diff = retryAfter - Math.floor(Date.now() / 1000);
  return diff > 0 ? diff : null;
}

/**
 * Live countdown to an absolute unix-seconds `retryAfter`. Seeds from
 * computeRemaining so the first render already reflects the wait, then ticks each
 * second. Shared by ErrorDisplay and the swap result view.
 */
export function useCountdown(retryAfter?: number): number | null {
  const [remaining, setRemaining] = useState<number | null>(() => computeRemaining(retryAfter));

  useEffect(() => {
    setRemaining(computeRemaining(retryAfter));
    if (!retryAfter) return;

    const interval = setInterval(() => setRemaining(computeRemaining(retryAfter)), 1000);
    return () => clearInterval(interval);
  }, [retryAfter]);

  return remaining;
}

// ============================================================
// Component
// ============================================================

export function ErrorDisplay({
  error,
  onRetry,
  isRetrying = false,
  className = "",
  originTokens,
  errorCategory,
  mayHaveMoved = false,
}: ErrorDisplayProps) {
  const errorInfo = useMemo(() => {
    if (!error) return null;
    return getErrorInfo(error, originTokens, errorCategory);
  }, [error, originTokens, errorCategory]);

  const countdown = useCountdown(errorInfo?.retryAfter);
  const isWaitingForRetry = countdown !== null && countdown > 0;

  if (!error || !errorInfo) return null;

  return (
    <div className={`error-display error-display--${errorInfo.category} ${className}`.trim()}>
      <div className="error-content">
        <span className="error-icon" aria-hidden="true">
          {(errorInfo.art || "[!]").trim()}
        </span>
        <div className="error-text">
          {/* The numeric HTTP code is kept off the title: it reads as jargon to a
              normie and SwapResult already omits it, so this stays consistent. */}
          <span className="error-title">
            {mayHaveMoved ? MAY_HAVE_MOVED_NOTICE.title : errorInfo.message}
          </span>
          {mayHaveMoved ? (
            <span className="error-suggestion">{MAY_HAVE_MOVED_NOTICE.detail}</span>
          ) : (
            <>
              {errorInfo.reason && <span className="error-reason">{errorInfo.reason}</span>}
              {errorInfo.suggestion && (
                <span className="error-suggestion">{errorInfo.suggestion}</span>
              )}
              {isWaitingForRetry && <span className="error-countdown">Retry in {countdown}s</span>}
            </>
          )}
        </div>
      </div>
      {onRetry && errorInfo.canRetry && !mayHaveMoved && (
        <button
          className="btn btn--ghost btn--sm error-retry-btn"
          onClick={onRetry}
          disabled={isRetrying || isWaitingForRetry}
        >
          {isRetrying
            ? "..."
            : isWaitingForRetry
              ? `${countdown}s`
              : (errorInfo.retryLabel ?? "Retry")}
        </button>
      )}
    </div>
  );
}
