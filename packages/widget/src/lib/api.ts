/**
 * API Utilities
 *
 * Shared fetch wrapper with:
 * - Automatic JSON parsing
 * - Error handling with Result type
 * - Timeout support
 *
 * SINGLE ATTEMPT, no retry, and deliberately so. This wrapper carried a
 * `retries` option that no caller ever passed (it defaulted to 0, so the loop
 * body never ran), and which was broken in three ways had anyone used it: one
 * `AbortController` outside the loop meant a timed-out first attempt left the
 * signal permanently aborted so every retry failed instantly; one `setTimeout`,
 * cleared on the first attempt, left later attempts with no timeout at all; and
 * `timeout` was silently a budget for all attempts combined rather than per
 * attempt.
 *
 * The working retry lives in `@xochi/client`'s transport (`intentAPI`), which
 * owns a per-attempt timeout, retries only 502/503/504 and honours
 * `Retry-After`. Route anything that needs retrying through there rather than
 * reviving this.
 */

import { type Result, ok, err } from "../types/result.js";
import { API_URL, TIMEOUTS } from "../config.js";
import { authFetch } from "./authFetch.js";

// ============================================================
// Types
// ============================================================

export interface FetchOptions extends Omit<RequestInit, "body"> {
  /** Request body (will be JSON stringified) */
  body?: unknown;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
}

// ============================================================
// Core Fetch Function
// ============================================================

/**
 * Fetch with automatic JSON handling and Result type.
 */
export async function apiFetch<T>(
  endpoint: string,
  options: FetchOptions = {},
): Promise<Result<T>> {
  const { body, timeout = TIMEOUTS.requestTimeout, ...fetchOptions } = options;

  const url = endpoint.startsWith("http") ? endpoint : `${API_URL}${endpoint}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const config: RequestInit = {
    ...fetchOptions,
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...fetchOptions.headers,
    },
  };

  if (body !== undefined) {
    config.body = JSON.stringify(body);
  }

  try {
    const response = await authFetch(url, config);
    // Cleared once headers are in, as before: the timeout bounds the request,
    // not the body read.
    clearTimeout(timeoutId);

    if (!response.ok) {
      // Try to extract error message from response. The status and the server's
      // `error_category` ride along so a caller can branch on the reason instead
      // of on prose -- the stealth claim path needs to tell "this record is gone,
      // retrying will not help" from "the solver is down, retry" (#469).
      try {
        const errorData = await response.json();
        return err(errorData.error || `HTTP ${response.status}: ${response.statusText}`, {
          status: response.status,
          errorCategory:
            typeof errorData.error_category === "string" ? errorData.error_category : undefined,
          body: errorData,
        });
      } catch {
        return err(`HTTP ${response.status}: ${response.statusText}`, { status: response.status });
      }
    }

    const data = await response.json();
    return ok(data as T);
  } catch (e) {
    clearTimeout(timeoutId);

    if (e instanceof Error) {
      return err(e.name === "AbortError" ? "Request timeout" : e.message);
    }
    return err("Unknown error");
  }
}

// ============================================================
// Convenience Methods
// ============================================================

/** GET request */
export function apiGet<T>(
  endpoint: string,
  options?: Omit<FetchOptions, "method" | "body">,
): Promise<Result<T>> {
  return apiFetch<T>(endpoint, { ...options, method: "GET" });
}

/** POST request */
export function apiPost<T>(
  endpoint: string,
  body?: unknown,
  options?: Omit<FetchOptions, "method">,
): Promise<Result<T>> {
  return apiFetch<T>(endpoint, { ...options, method: "POST", body });
}

// ============================================================
// Helpers
// ============================================================

/**
 * Build URL with query parameters
 */
export function buildUrl(
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return endpoint;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }

  const queryString = searchParams.toString();
  return queryString ? `${endpoint}?${queryString}` : endpoint;
}
