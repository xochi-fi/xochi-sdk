/**
 * The Privacy section (xochi-fi/xochi-widget#35): the settlement mode the frame
 * opens on. Stealth is offered only where the destination can carry it.
 */

import { stealthOffered, type EmbedDefaults } from "../trade/embedParams.js";
import { type EmbedSettlement } from "@xochi/widget-lib";
import { EXTENDED_CHAIN_NAMES, stealthDestinationChains } from "@xochi/client";
import type { SolverCapabilities } from "@xochi/signer";
import { joinChainNames } from "../trade/config.js";
import { MODE_META } from "../trade/settlementCopy.js";
import type { CapabilityState } from "@xochi/client";

interface PrivacySectionProps {
  config: EmbedDefaults;
  capabilities: SolverCapabilities;
  capabilityState: CapabilityState;
  onSettlement: (settlement: EmbedSettlement) => void;
}

export function PrivacySection({
  config,
  capabilities,
  capabilityState,
  onSettlement,
}: PrivacySectionProps) {
  const stealthAvailable = stealthOffered(config, capabilities, capabilityState);
  const stealthChainNames = joinChainNames(
    stealthDestinationChains(capabilities).map((chainId) => EXTENDED_CHAIN_NAMES[chainId]),
  );
  return (
    <fieldset className="config-leg">
      <legend className="label">Settlement</legend>
      <div className="config-choices">
        <label className="config-choice">
          <input
            type="radio"
            name="config-settlement"
            value="public"
            checked={config.settlement === "public"}
            onChange={() => onSettlement("public")}
          />
          <span className="config-choice__name">Public</span>
          <span className="config-choice__meta">{MODE_META.public}</span>
        </label>
        {stealthAvailable || config.settlement === "stealth" ? (
          <label className="config-choice">
            <input
              type="radio"
              name="config-settlement"
              value="stealth"
              checked={config.settlement === "stealth"}
              disabled={!stealthAvailable}
              onChange={() => onSettlement("stealth")}
            />
            <span className="config-choice__name">Stealth</span>
            <span className="config-choice__meta">{MODE_META.stealth}</span>
          </label>
        ) : null}
      </div>
      {stealthAvailable ? null : (
        <p className="config-hint">
          {stealthChainNames
            ? `Stealth needs a supported route to ${stealthChainNames}.`
            : "Stealth settlement isn't available for this destination."}
        </p>
      )}
    </fieldset>
  );
}
