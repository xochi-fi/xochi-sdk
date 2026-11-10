/**
 * PermitBadge Component
 *
 * Displays the permit type and signed status for token authorization.
 * Shows ERC-3009 (USDC), Permit2, or EIP-2612 based on token.
 */

import { useState } from "react";
import type { PermitType } from "../types/intent.js";
import "../styles/permit-badge.css";

// ============================================================
// Types
// ============================================================

interface PermitBadgeProps {
  permitType: PermitType;
  tokenSymbol: string;
  isSigned: boolean;
  needsPermit: boolean;
  showDetails?: boolean;
}

// ============================================================
// Permit Info
// ============================================================

interface PermitInfo {
  label: string;
  shortDesc: string;
  benefit: string;
  gasless: boolean;
}

const PERMIT_INFO: Record<PermitType, PermitInfo> = {
  erc3009: {
    label: "ERC-3009",
    shortDesc: "Direct transfer authorization",
    benefit: "No approval TX needed - sign once, transfer directly. Used by USDC.",
    gasless: true,
  },
  permit2: {
    label: "Permit2",
    shortDesc: "Universal permit",
    benefit: "One approval unlocks all Permit2 apps. Widely supported.",
    gasless: true,
  },
  eip2612: {
    label: "EIP-2612",
    shortDesc: "Standard permit",
    benefit: "Gasless approval via signature. Token must support permit().",
    gasless: true,
  },
  none: {
    label: "Approval",
    shortDesc: "On-chain approval",
    benefit: "Requires approval transaction (gas fee). Fallback for older tokens.",
    gasless: false,
  },
};

// ============================================================
// Component
// ============================================================

export function PermitBadge({
  permitType,
  tokenSymbol,
  isSigned,
  needsPermit,
  showDetails = false,
}: PermitBadgeProps) {
  const [expanded, setExpanded] = useState(showDetails);

  if (!needsPermit) {
    return null;
  }

  const info = PERMIT_INFO[permitType];
  const statusText = isSigned ? "approved" : "required";

  return (
    <div className="permit-badge-wrapper" data-type={permitType} data-signed={isSigned}>
      <button
        type="button"
        className="permit-badge"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="permit-badge__token">{tokenSymbol}:</span>
        <span className="permit-badge__type">{info.label}</span>
        <span className={`permit-badge__status ${isSigned ? "signed" : "pending"}`}>
          {statusText}
        </span>
        <svg
          className="permit-badge__expand"
          viewBox="0 0 10 6"
          width="8"
          height="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          {expanded ? <path d="M1 5L5 1L9 5" /> : <path d="M1 1L5 5L9 1" />}
        </svg>
      </button>

      {expanded && (
        <div className="permit-badge__details">
          <p className="permit-badge__benefit">{info.benefit}</p>
          <div className="permit-badge__tags">
            {info.gasless && (
              <span className="permit-badge__tag permit-badge__tag--gasless">No gas fee</span>
            )}
            <span className="permit-badge__tag">Signature only</span>
          </div>
        </div>
      )}
    </div>
  );
}
