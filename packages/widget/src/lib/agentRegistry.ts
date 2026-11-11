/**
 * Authorized-agent registry (client-side, privacy-first).
 *
 * When a user authorizes an agent (a Mandate they signed), the client stores the
 * agent locally along with a freshly generated per-agent `topicId` -- a 128-bit
 * random capability. The agent later pushes its swap activity to that topic and
 * the client subscribes; the server only ever sees the topic as an opaque
 * routing key, never tied to a human. See docs plan `agent-stream-design.md`.
 *
 * This is Phase 3.0: the data layer + the capability. The live stream (3.1-3.3)
 * plugs into `topicId`; the Mandate-signing flow that calls `authorizeAgent`
 * lands with the agent-auth surface. Nothing here touches the server.
 */

import { STORAGE_KEYS } from "../constants.js";

export interface AuthorizedAgent {
  /** The agent's own wallet (0x). Signs stream events; verified client-side. */
  agentWallet: string;
  /** Friendly, user-chosen name, e.g. "my rebalancer". */
  label: string;
  /** Per-agent stream capability: 128-bit random, base64url. Never leaves the client except as a routing key. */
  topicId: string;
  /** keccak256 of the signed Mandate envelope, when authorized via a real mandate. */
  mandateHash: string | null;
  /** Mandate scopes granted (e.g. ["quote"]). */
  scopes: string[];
  /** Unix seconds; null = no expiry. */
  expiresAt: number | null;
  /** Creation time (ms). */
  addedAt: number;
}

export type AuthorizeInput = Pick<AuthorizedAgent, "agentWallet" | "label"> &
  Partial<Pick<AuthorizedAgent, "topicId" | "addedAt" | "mandateHash" | "scopes" | "expiresAt">>;

const keyFor = (address: string): string =>
  `${STORAGE_KEYS.agentRegistryPrefix}${address.toLowerCase()}`;

// --- capability generation ------------------------------------------------
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh 128-bit random stream capability. */
export function generateTopicId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// --- pub/sub so the UI updates when the registry changes ------------------
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeAgentRegistry(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

// --- storage --------------------------------------------------------------
function read(address: string): AuthorizedAgent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthorizedAgent[]) : [];
  } catch (err) {
    console.error("[agentRegistry] read failed", err);
    return [];
  }
}

function write(address: string, agents: AuthorizedAgent[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(address), JSON.stringify(agents));
  } catch (err) {
    console.error("[agentRegistry] write failed", err);
  }
}

/** The wallet's authorized agents, newest first. */
export function listAgents(address: string | undefined): AuthorizedAgent[] {
  if (!address) return [];
  return read(address).sort((a, b) => b.addedAt - a.addedAt);
}

/** True when the agent's mandate has not expired. */
export function isAgentActive(agent: AuthorizedAgent, nowMs: number): boolean {
  return agent.expiresAt == null || agent.expiresAt * 1000 > nowMs;
}

/**
 * Authorize an agent (idempotent by `agentWallet`). A new agent gets a fresh
 * `topicId`; re-authorizing an existing agent keeps its topic and updates the
 * other fields. Returns the stored entry.
 */
export function authorizeAgent(
  address: string | undefined,
  input: AuthorizeInput,
): AuthorizedAgent | null {
  if (!address) return null;
  const existing = read(address);
  const idx = existing.findIndex(
    (a) => a.agentWallet.toLowerCase() === input.agentWallet.toLowerCase(),
  );
  const entry: AuthorizedAgent = {
    agentWallet: input.agentWallet,
    label: input.label,
    mandateHash: input.mandateHash ?? null,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
    topicId: input.topicId ?? existing[idx]?.topicId ?? generateTopicId(),
    addedAt: input.addedAt ?? existing[idx]?.addedAt ?? Date.now(),
  };
  const next = idx >= 0 ? existing.map((a, i) => (i === idx ? entry : a)) : [entry, ...existing];
  write(address, next);
  notify();
  return entry;
}

/** Revoke an agent: drop it from the registry (client stops trusting its topic). */
export function revokeAgent(address: string | undefined, agentWallet: string): void {
  if (!address) return;
  const next = read(address).filter(
    (a) => a.agentWallet.toLowerCase() !== agentWallet.toLowerCase(),
  );
  write(address, next);
  notify();
}
