/**
 * Xochi Shared Types
 *
 * Centralized type definitions used across the application.
 */

// ============================================================
// Identity & Verification Types
// ============================================================

export type { ProviderCategory } from "@xochi/client";

export interface Provider {
  id: string;
  name: string;
  category: import("@xochi/client").ProviderCategory;
  points: number;
  description: string;
  icon: string;
}

export interface VerifyState {
  score: number;
  connectedProviders: string[];
}

// ============================================================
// Type Guards
// ============================================================

export function isVerifyState(value: unknown): value is VerifyState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.score === "number" &&
    Array.isArray(obj.connectedProviders) &&
    obj.connectedProviders.every((p) => typeof p === "string")
  );
}

// ============================================================
// Re-export Intent Types
// ============================================================

export type { SettlementType } from "./intent.js";
