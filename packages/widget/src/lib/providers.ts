/**
 * Identity Providers
 *
 * The provider catalogue behind the trust score panel.
 *
 * Provider Categories:
 * - Humanity: Proof of unique human (Humanode, Idena, Human Passport, Worldcoin, BrightID)
 * - Identity: KYC/identity verification (ZKPassport, Privado ID, Coinbase, Civic)
 * - Reputation: On-chain history (ENS, Lens)
 * - Compliance: Regulatory compliance (Chainalysis, Xochi History)
 */

import type { Provider, ProviderCategory } from "../types/index.js";

// ============================================================
// Provider Configuration
// ============================================================

export const PROVIDERS: readonly Provider[] = [
  // Humanity
  {
    id: "humanode",
    name: "Humanode",
    category: "humanity",
    points: 15,
    description: "Biometric PoH credential",
    icon: "H",
  },
  {
    id: "idena",
    name: "Idena",
    category: "humanity",
    points: 18,
    description: "AI-resistant PoH tests",
    icon: "I",
  },
  {
    // ID kept as "gitcoin" for backward compat; rebranded to Human Passport
    // (Holonym Foundation, Feb 2025). See docs/legal/provider-audit-2026-06.md.
    id: "gitcoin",
    name: "Human Passport",
    category: "humanity",
    points: 18,
    description: "Aggregated sybil score",
    icon: "G",
  },
  {
    id: "worldcoin",
    name: "Worldcoin",
    category: "humanity",
    points: 8,
    description: "Orb-verified PoH",
    icon: "W",
  },
  {
    id: "brightid",
    name: "BrightID",
    category: "humanity",
    points: 10,
    description: "Social graph verification",
    icon: "B",
  },
  // Identity
  {
    id: "zkpassport",
    name: "ZKPassport",
    category: "identity",
    points: 30,
    description: "Government ID via ZK proof",
    icon: "Z",
  },
  {
    // ID kept as "polygonid" for backward compat; rebranded to Privado ID
    // (spun out of Polygon Labs, Jun 2024). See provider-audit-2026-06.md.
    id: "polygonid",
    name: "Privado ID",
    category: "identity",
    points: 32,
    description: "ZK identity credentials",
    icon: "P",
  },
  {
    id: "coinbase",
    name: "Coinbase Verified",
    category: "identity",
    points: 25,
    description: "Exchange-level KYC",
    icon: "C",
  },
  {
    id: "civic",
    name: "Civic",
    category: "identity",
    points: 22,
    description: "Identity verification",
    icon: "V",
  },
  // Reputation
  {
    id: "ens",
    name: "ENS",
    category: "reputation",
    points: 10,
    description: "Domain ownership",
    icon: "E",
  },
  {
    id: "lens",
    name: "Lens Protocol",
    category: "reputation",
    points: 6,
    description: "Social graph history",
    icon: "L",
  },
  // Compliance
  {
    id: "chainalysis",
    name: "Chainalysis",
    category: "compliance",
    points: 20,
    description: "Sanctions screening",
    icon: "A",
  },
  {
    id: "xochi-history",
    name: "Xochi History",
    category: "compliance",
    points: 15,
    description: "Clean trading record",
    icon: "X",
  },
];

export const CATEGORIES: readonly ProviderCategory[] = [
  "humanity",
  "identity",
  "reputation",
  "compliance",
];
