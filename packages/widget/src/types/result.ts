/**
 * Result Types
 *
 * Standardized result types for operations that can fail.
 * Provides type-safe error handling without exceptions.
 */

// ============================================================
// Core Result Type
// ============================================================

/** Successful result with data */
export interface Ok<T> {
  success: true;
  data: T;
  error?: never;
}

/** Failed result with error */
export interface Err {
  success: false;
  data?: never;
  error: string;
  /**
   * HTTP status, when the failure came from a server response rather than a
   * transport error or timeout. Lets a caller distinguish retryable (429/503)
   * from terminal (404/409) without parsing prose.
   */
  status?: number;
  /**
   * The server's `error_category`, when it sent one. Typed as `string` because
   * it is untrusted wire data and the server may add categories ahead of this
   * client; compare against the vocabularies in `@xochi/client` rather than
   * against a literal.
   */
  errorCategory?: string;
  /**
   * The parsed JSON error body, when there was one. Untrusted wire data: parse
   * it with the matching `@xochi/client` schema before reading a field. Needed
   * where a body carries more than `error` + `error_category` -- a pending
   * stealth claim's `retryAfter`, preserved for callers that consume a Result
   * rather than the raw response and its CORS-exposed Retry-After header.
   */
  body?: unknown;
}

/** Server-response detail attached to an `Err`. */
export interface ErrMeta {
  status?: number;
  errorCategory?: string;
  body?: unknown;
}

/** Result type - either Ok with data or Err with error message */
export type Result<T> = Ok<T> | Err;

// ============================================================
// Factory Functions
// ============================================================

/** Create a successful result */
export function ok<T>(data: T): Ok<T> {
  return { success: true, data };
}

/** Create a failed result */
export function err(error: string, meta?: ErrMeta): Err {
  return { success: false, error, ...meta };
}

// ============================================================
// Type Guards
// ============================================================

/** Check if result is successful */
export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.success;
}
