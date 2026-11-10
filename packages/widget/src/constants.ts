/**
 * Application Constants
 *
 * LocalStorage keys and frontend-specific constants. Chain, trading and
 * validation constants come from `@xochi/client`.
 */

// ============================================================
// Palette (mirrors CSS custom properties in src/styles/base.css)
// Use for inline styles and library theme configs where CSS vars aren't available.
// ============================================================

export const PALETTE = {
  obsidian: "#0a0a0c",
  pearlCream: "#e8e4dc",
  mutedGold: "#a89a80",
  mutedGoldBright: "#c4b496",
  mutedGoldDark: "#7a6e5a",
} as const;

// ============================================================
// Browser Storage Keys (Frontend-specific)
// ============================================================

export const STORAGE_KEYS = {
  /** User's verification state (score, attestations, timestamp). Read-only today. */
  verifyState: "xochi_verify_state",
  /** Cached attestations from identity providers */
  attestations: "xochi_attestations",
  /** UI theme preference */
  theme: "xochi_theme",
  /** Stealth key storage prefix */
  stealthPrefix: "xochi:stealth:",
  /** RETIRED: the settlement roadmap modal no longer exists, so nothing writes
   *  this anymore. Kept declared so the /cookies clear buttons still remove it
   *  from browsers that hold it (clearBucket only touches declared keys). */
  settlementRoadmapSeen: "xochi_settlement_roadmap_seen",
  /** Local-first swap activity log (prefix; per-wallet key appended) */
  localActivityPrefix: "xochi_local_activity:",
  /** Intent ids whose flow modal the user closed, so it never auto-reopens (prefix; per-wallet) */
  resumeDismissedPrefix: "xochi_resume_dismissed:",
  /** Authorized-agent registry + per-agent stream capability (prefix; per-wallet) */
  agentRegistryPrefix: "xochi_agent_registry:",
  /** Mobile "open in your wallet's browser" signing hint dismissed */
  mobileSigningHintDismissed: "xochi_mobile_signing_hint_dismissed",

  // sessionStorage, not localStorage. Both clear when the tab closes. They live
  // in the same table so the inventory covers every key the app writes, whichever
  // store it lands in.
  /** Passkey-issued JWT (sessionStorage; see src/lib/auth.ts) */
  authToken: "xochi_auth_token",
  /** Sign-In-With-Wallet session (sessionStorage; see src/lib/walletSession.ts) */
  walletSession: "xochi_wallet_session",
} as const;

// ============================================================
// UI Strings
// ============================================================

export const UI = {
  CONNECT_WALLET: "Connect wallet",
  CONNECT_PROMPT: "Connect wallet first",
  CONNECT_TO_VIEW: "Connect wallet to view",
} as const;

// ============================================================
// Chain Configuration (Frontend-specific UI config)
// ============================================================

/** Virtual chain ID for Aztec/Xochi private layer */
export const AZTEC_CHAIN_ID = 0 as const;
