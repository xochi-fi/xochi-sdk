// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/** Default page size for lists */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum items to store locally */
export const MAX_LOCAL_ITEMS = 100;

export const PAGINATION = {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxLocalItems: MAX_LOCAL_ITEMS,
} as const;

/** Estimated single-chain settlement time in seconds */
export const ESTIMATED_SINGLE_CHAIN_SEC = 30;

/** Estimated cross-chain settlement time in seconds */
export const ESTIMATED_CROSS_CHAIN_SEC = 120;
