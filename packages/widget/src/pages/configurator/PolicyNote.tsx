/**
 * The one line every lock and allow-list carries (xochi-fi/xochi-widget#39):
 * they shape the widget, but nothing enforces them until publishable keys
 * (xochi-fi/xochi#579) carry the same policy server-side.
 */
export function PolicyNote() {
  return (
    <p className="config-hint">
      Locks and allow-lists shape the widget only. They don't restrict the API.
    </p>
  );
}
