const SCOPE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * A recipient scope (the core passes the recipient address) names that recipient's browser stores.
 * One lowercase segment, so it can never select another store's name or an OPFS path.
 */
export function assertScope(scope: string): void {
  if (!SCOPE.test(scope)) throw new TypeError(`invalid recipient scope ${JSON.stringify(scope)}`);
}
