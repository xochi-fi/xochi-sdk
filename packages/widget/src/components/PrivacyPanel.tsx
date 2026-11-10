/**
 * PrivacyPanel
 *
 * Unified privacy control panel for the Assets page.
 * Replaces: trust card, Aztec card, stealth card, info panel.
 * Progressive disclosure: compact by default, expandable for detail.
 */

import { useState } from "react";
import { Chevron } from "./Chevron.js";
import { PROVIDERS, CATEGORIES } from "../lib/providers.js";
import { getFeeRate, getTierName } from "@xochi/client";
import "../styles/privacy-panel.css";

interface PrivacyPanelProps {
  trustScore: number;
  /**
   * Whether attestation disclosures are actionable yet (Xochi's
   * VERIFICATION_BETA_LIVE flag). While it is off, the section is glassed out
   * (non-interactive, "Soon") since connecting a provider would do nothing.
   */
  disclosuresLive?: boolean;
  /**
   * Whether shielded accounts (Aztec L2 balances) are usable yet. While false
   * the panel shows an inert "Unavailable" row so the receive surface names the mode
   * without offering setup that would do nothing. Defaults to NOT live: an
   * omitted prop should never be read as a promise that the rail works.
   */
  shieldedAccountsLive?: boolean;
  connectedProviders: string[];
  isConnected: boolean;
  // Stealth
  stealthInitialized: boolean;
  stealthRegistered: boolean;
  onInitializeStealth: () => void;
  onRegisterStealth: () => void;
  stealthLoading: boolean;
}

export function PrivacyPanel({
  trustScore,
  disclosuresLive = true,
  shieldedAccountsLive = false,
  connectedProviders,
  isConnected,
  stealthInitialized,
  stealthRegistered,
  onInitializeStealth,
  onRegisterStealth,
  stealthLoading,
}: PrivacyPanelProps) {
  const [showDisclosures, setShowDisclosures] = useState(false);

  const tierName = getTierName(trustScore);
  const feeRate = getFeeRate(trustScore);

  return (
    <div className="privacy-panel">
      {/* Tier + fee summary */}
      <div className="pp-header">
        <div className="pp-tier">
          <span className={`pp-tier-badge tier-${tierName.toLowerCase()}`}>{tierName}</span>
          {/* "fee rate", not "fee". This is `headlineBps` (solver + venue +
              routing) off the schedule for the tier, and it is the only cost
              figure on the screen that never changes with route, size or
              privacy. Real cost is max(floor(destination_chain), 0.22%), and
              the floor is gas-derived, so it rises as the order shrinks: a
              small order to an Ethereum destination can cost several times what
              this badge reads while the badge stays at 0.22%. Past 150 bps
              (MAX_COST_RATIO) the order is refused rather than quoted, so the
              understatement a user can actually be shown is bounded by that
              ceiling. Naming it a rate stops it claiming to be the price; the
              quote's all-in bps is the price. Deliberately NOT "venue fee" (the
              kickoff's wording): the venue layer is one of the three summed
              here, so that label would be precise and wrong. */}
          <span className="pp-fee" title="Fee schedule rate, before network costs">
            {feeRate.toFixed(2)}% fee rate
          </span>
        </div>
        <span className="pp-score">{trustScore}/100</span>
      </div>

      {/* Disclosures (expandable; glassed out until verify/attestations are live) */}
      <div className={`pp-disclosures${disclosuresLive ? "" : " pp-disclosures--soon"}`}>
        <button
          className="pp-disclosures-toggle"
          onClick={() => disclosuresLive && setShowDisclosures(!showDisclosures)}
          disabled={!disclosuresLive}
          title={disclosuresLive ? undefined : "Attestation disclosures are unavailable"}
        >
          <span className="pp-section-label">Disclosures</span>
          {disclosuresLive ? (
            <span className="pp-disclosures-count">
              {connectedProviders.length}/{PROVIDERS.length}
            </span>
          ) : (
            <span className="pp-disclosures-soon">Unavailable</span>
          )}
          {disclosuresLive && <Chevron open={showDisclosures} />}
        </button>

        {disclosuresLive && showDisclosures && (
          <div className="pp-disclosures-detail">
            {CATEGORIES.map((cat) => {
              const catProviders = PROVIDERS.filter((p) => p.category === cat);
              const connected = catProviders.filter((p) => connectedProviders.includes(p.id));
              return (
                <div key={cat} className="pp-category">
                  <span className="pp-category-name">
                    {cat === "humanity"
                      ? "Humanity"
                      : cat === "identity"
                        ? "Identity"
                        : cat === "reputation"
                          ? "Reputation"
                          : "Compliance"}
                  </span>
                  <span className="pp-category-count">
                    {connected.length}/{catProviders.length}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Stealth status row */}
      <div className="pp-status-rows">
        <div className="pp-status-row">
          <span className="pp-status-label">Stealth</span>
          {!stealthInitialized ? (
            <button
              className="pp-status-action"
              onClick={onInitializeStealth}
              disabled={!isConnected || stealthLoading}
            >
              {stealthLoading ? "..." : "Setup"}
            </button>
          ) : stealthRegistered ? (
            <span className="pp-status-value pp-status--ok">Ready</span>
          ) : (
            <button
              className="pp-status-action"
              onClick={onRegisterStealth}
              disabled={!isConnected || stealthLoading}
            >
              {stealthLoading ? "..." : "Register"}
            </button>
          )}
        </div>

        {stealthInitialized && !stealthRegistered && (
          <p className="pp-status-hint">
            Keys are set up on this device. Register once on-chain to receive private payments.
          </p>
        )}

        {/* Shielded accounts. Inert while not offered: there is no setup to
        offer, so the row carries a chip and a sentence and no affordance.
        Naming it here rather than hiding it keeps the receive surface honest
        about the target without implying it can be turned on today. */}
        {!shieldedAccountsLive && (
          <>
            <div className="pp-status-row">
              <span className="pp-status-label">Shielded</span>
              <span className="pp-soon">Unavailable</span>
            </div>
            <p className="pp-status-hint">
              Shielded hides the recipient; the amount, token, solver and timing stay public.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
