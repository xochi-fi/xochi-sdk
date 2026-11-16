/**
 * BuyPanel
 *
 * Trade's Buy mode (API `onramp`): buying crypto with fiat through Peer. Not
 * available in this build, so it renders a text-only state with no control
 * that could start anything. Live availability replaces this panel later.
 */

export function BuyPanel() {
  return (
    <div className="send-card">
      <section className="send-unavailable" aria-label="Buy">
        <h2 className="send-card__title">Buy</h2>
        <p>
          Not available yet. Buying crypto with a payment app is not live in this widget, so nothing
          here can start a purchase.
        </p>
        <p className="send-note">Swap is available now from the Swap mode above.</p>
      </section>
    </div>
  );
}
