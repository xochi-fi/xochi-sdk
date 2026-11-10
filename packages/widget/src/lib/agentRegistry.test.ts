import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  listAgents,
  authorizeAgent,
  revokeAgent,
  isAgentActive,
  generateTopicId,
  subscribeAgentRegistry,
  type AuthorizedAgent,
} from "./agentRegistry.js";

const HUMAN = "0xHuman0000000000000000000000000000000001";
const AGENT_A = "0xAaaa000000000000000000000000000000000001";
const AGENT_B = "0xBbbb000000000000000000000000000000000002";

// Node test env: shim a Map-backed localStorage on a global window.
function installFakeStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string): void => void store.set(k, v),
      removeItem: (k: string): void => void store.delete(k),
      clear: (): void => store.clear(),
      key: (i: number): string | null => [...store.keys()][i] ?? null,
      get length(): number {
        return store.size;
      },
    },
  };
}

const base = { label: "bot", mandateHash: null, scopes: ["quote"], expiresAt: null };

describe("generateTopicId", () => {
  it("produces distinct base64url capabilities", () => {
    const a = generateTopicId();
    const b = generateTopicId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(20);
  });
});

describe("agentRegistry", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it("authorizes an agent with a generated topicId", () => {
    const entry = authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_A });
    expect(entry?.topicId).toBeTruthy();
    const list = listAgents(HUMAN);
    expect(list).toHaveLength(1);
    expect(list[0].agentWallet).toBe(AGENT_A);
  });

  it("is idempotent by agentWallet (keeps topicId + addedAt, updates label)", () => {
    const first = authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_A, label: "old" });
    const second = authorizeAgent(HUMAN, {
      ...base,
      agentWallet: AGENT_A.toLowerCase(),
      label: "new",
    });
    expect(listAgents(HUMAN)).toHaveLength(1);
    expect(second?.topicId).toBe(first?.topicId);
    expect(second?.addedAt).toBe(first?.addedAt);
    expect(listAgents(HUMAN)[0].label).toBe("new");
  });

  it("gives distinct topics to distinct agents", () => {
    const a = authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_A });
    const b = authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_B });
    expect(a?.topicId).not.toBe(b?.topicId);
    expect(listAgents(HUMAN)).toHaveLength(2);
  });

  it("revokes an agent", () => {
    authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_A });
    authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_B });
    revokeAgent(HUMAN, AGENT_A.toLowerCase());
    const list = listAgents(HUMAN);
    expect(list).toHaveLength(1);
    expect(list[0].agentWallet).toBe(AGENT_B);
  });

  it("scopes agents per human wallet", () => {
    authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_A });
    expect(listAgents("0x0000000000000000000000000000000000000009")).toHaveLength(0);
  });

  it("notifies subscribers on change", () => {
    const listener = vi.fn();
    const off = subscribeAgentRegistry(listener);
    authorizeAgent(HUMAN, { ...base, agentWallet: AGENT_A });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    revokeAgent(HUMAN, AGENT_A);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("isAgentActive", () => {
  const now = 1_000_000_000_000; // fixed ms
  const agent = (expiresAt: number | null): AuthorizedAgent => ({
    agentWallet: AGENT_A,
    label: "x",
    topicId: "t",
    mandateHash: null,
    scopes: [],
    expiresAt,
    addedAt: 0,
  });

  it("treats null expiry as always active", () => {
    expect(isAgentActive(agent(null), now)).toBe(true);
  });

  it("is active before expiry and inactive after", () => {
    expect(isAgentActive(agent(now / 1000 + 60), now)).toBe(true);
    expect(isAgentActive(agent(now / 1000 - 60), now)).toBe(false);
  });
});
