/**
 * Status-transition reducer for status-driven state.
 *
 * Validates each move against a predicate, no-ops on an invalid one, and
 * otherwise merges { status, ...updates }. Pure: the machine reports the
 * rejected move itself (an `Emit` log effect), so this never touches a console.
 */

/**
 * Apply a validated status transition to a state object. Returns the previous
 * state unchanged (same reference) when the move is invalid, otherwise the
 * merged next state. Never mutates `prev`.
 */
export function applyStatusTransition<TStatus extends string, TState extends { status: TStatus }>(
  prev: TState,
  to: TStatus,
  canTransition: (from: TStatus, to: TStatus) => boolean,
  updates?: Partial<TState>,
): TState {
  if (!canTransition(prev.status, to)) return prev;
  return { ...prev, status: to, ...updates };
}
