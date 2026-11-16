/**
 * BuyPanel
 *
 * Trade's Buy mode (API `onramp`): buying Base USDC with fiat through Peer.
 * Shows live Peer rail availability (ramp/availability); only a fresh
 * `available` offer can be chosen, and choosing one starts nothing yet.
 *
 * A purchase that no live runtime owns (after a reload, or a return from Peer
 * into a fresh view) is resumed first, from its sanitized local summary. While
 * this wallet has a submitted purchase that has not settled, no rail can be
 * chosen: another transfer must not start beside it.
 */

import { useEffect, useState } from "react";
import { useAccount, useWalletClient, usePublicClient, useSwitchChain } from "wagmi";
import { BuyOnramp } from "../../ramp/peer/BuyOnramp.js";
import { RampRails } from "../../ramp/availability/RampRails.js";
import { ResumeOnramp } from "../../ramp/recovery/ResumeOnramp.js";
import { rampOperationLive, summaryResolved } from "../../ramp/recovery/summaries.js";
import { useRampSummaries } from "../../hooks/useRampSummaries.js";

interface BuyPanelProps {
  /** Whether Buy is the visible mode; a hidden panel reads nothing from Peer. */
  active: boolean;
  fiatCurrency?: string;
}

export function BuyPanel({ active, fiatCurrency }: BuyPanelProps) {
  const { address, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient({ chainId: 8453 });
  const summaries = useRampSummaries();
  const me = address?.toLowerCase();
  const [pinned, setPinned] = useState<string>();
  const waiting = summaries.filter(
    (row) => !summaryResolved(row) && !rampOperationLive(row.operation_id),
  );
  const candidate = waiting.find((row) => row.wallet === me) ?? waiting[0];
  const kept = summaries.find((row) => row.operation_id === pinned && !row.abandoned);
  const resume = kept ?? candidate;
  useEffect(() => {
    // Keep a resumed purchase on screen through its terminal state until dismissed.
    if (!kept && candidate?.operation_id !== pinned) setPinned(candidate?.operation_id);
  }, [kept, candidate, pinned]);
  const blocked =
    resume !== undefined &&
    !(resume.terminal && resume.operation_id === kept?.operation_id) &&
    (resume.wallet === me || !resume.submitted);

  return (
    <div className="send-card">
      <h2 className="send-card__title">Buy</h2>
      {address && chainId !== 8453 && (
        <button type="button" disabled={isPending} onClick={() => switchChain({ chainId: 8453 })}>
          Switch wallet to Base for Peer purchase
        </button>
      )}
      {resume && (
        <ResumeOnramp
          key={`${resume.operation_id}:${me ?? ""}`}
          summary={resume}
          connected={address}
          wallet={chainId === 8453 ? wallet : undefined}
          publicClient={publicClient}
          onDone={() => setPinned(undefined)}
        />
      )}
      {blocked ? (
        <p className="ramp-resume__blocked">
          Resolve the purchase above before starting another. Do not start another transfer for it.
        </p>
      ) : (
        <RampRails
          direction="onramp"
          account={address}
          fiatCurrency={fiatCurrency}
          active={active}
          renderSelected={(intent, offer, lock) => (
            <BuyOnramp
              key={offer.capability_revision}
              intent={intent}
              offer={offer}
              wallet={chainId === 8453 ? wallet : undefined}
              publicClient={publicClient}
              connected={address}
              onSubmit={() => lock()}
              onReset={() => lock(false)}
            />
          )}
        />
      )}
    </div>
  );
}
