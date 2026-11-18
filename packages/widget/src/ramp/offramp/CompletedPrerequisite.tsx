export function CompletedPrerequisite({
  receipt,
  wallet,
  peerFailed,
}: {
  receipt: string;
  wallet: string;
  peerFailed?: boolean;
}) {
  return (
    <section className="send-review" aria-label="Completed prerequisite">
      <h4>Transfer to Base complete</h4>
      <p className="send-review__mono">Route receipt: {receipt}</p>
      {peerFailed && (
        <p role="alert">
          Peer did not start a deposit. The routed Base USDC remains in this wallet. Review a fresh
          Peer estimate to retry only the cash-out.
        </p>
      )}
      <p>
        Base USDC was confirmed spendable in {wallet} on Base. Peer uses a separate approval and
        receipt. If Peer fails before deposit, the USDC remains in this wallet; after deposit, check
        the Peer order and withdraw unmatched funds. Recovery acts only on Peer and never repeats
        the completed route.
      </p>
    </section>
  );
}
