/**
 * RampRecovery
 *
 * Recovery for a Peer operation already submitted from this browser, shown in
 * Activity when the host's narrowing (`rampProviders` without `peer`, or a
 * `modes` list without Buy or Cash out) has removed
 * the surface that would otherwise resume it. Narrowing removes ways to START
 * an operation; it must never strand one that moved money (a rollback that
 * drops Peer mid-purchase is the case this covers).
 *
 * Recovery only: no rails are read and nothing new can start here. A purchase
 * resumes through ResumeOnramp; a cash-out through PaymentAppSend, mounted
 * only while its sanitized summary is open or in doubt, so the view leaves
 * Activity once the order resolves.
 */

import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { useRampSummaries } from "../../hooks/useRampSummaries.js";
import { ResumeOnramp } from "../../ramp/recovery/ResumeOnramp.js";
import { rampOperationLive, summaryBlocksNewPurchase } from "../../ramp/recovery/summaries.js";
import { PaymentAppSend } from "../../ramp/offramp/PaymentAppSend.js";
import { resumableOfframp, type OfframpActivityItem } from "../../ramp/offramp/localOfframps.js";

export function PurchaseRecovery() {
  const { address, chainId } = useAccount();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient({ chainId: 8453 });
  const me = address?.toLowerCase();
  const row = useRampSummaries().find(
    (r) => r.wallet === me && summaryBlocksNewPurchase(r) && !rampOperationLive(r.operation_id),
  );
  if (!row) return null;
  return (
    <section className="send-card" aria-label="Purchase to recover">
      <ResumeOnramp
        key={`${row.operation_id}:${me ?? ""}`}
        summary={row}
        connected={address}
        wallet={chainId === 8453 ? wallet : undefined}
        publicClient={publicClient}
        onDone={() => {}}
      />
    </section>
  );
}

export function CashOutRecovery({
  items,
  fiatCurrency,
  active,
}: {
  items: readonly OfframpActivityItem[];
  fiatCurrency?: string;
  active: boolean;
}) {
  if (!resumableOfframp(items)) return null;
  return (
    <section className="send-card" aria-label="Cash-out to recover">
      <PaymentAppSend fiatCurrency={fiatCurrency} active={active} />
    </section>
  );
}
