/**
 * AuthorizedAgents
 *
 * Lists the agents this wallet has authorized to act on its behalf, each with a
 * private stream key. Authorized agents can stream their swap activity into
 * the feed live; the server never learns the link. Each row can reveal a
 * copyable setup so you can hand the key to your own agent out of band.
 *
 * Phase 3.0: the client-side registry + a manual authorize/revoke + the handoff.
 * The signed Mandate flow that auto-populates this lands with the agent-auth
 * surface.
 */

import { useRef, useState } from "react";
import { isAddress } from "viem";
import { truncateAddress } from "../utils/format.js";
import { useAgentRegistry } from "../hooks/useAgentRegistry.js";
import { isAgentActive, type AuthorizedAgent } from "../lib/agentRegistry.js";
import { buildAgentConnectSnippet, revealedTopic } from "../lib/agentConnect.js";
import { API_URL, TIMEOUTS } from "../config.js";

type CopyState = "idle" | "copied" | "fallback";

/** One authorized agent, with a reveal-gated connection handoff. */
function AgentRow({
  agent,
  onRevoke,
}: {
  agent: AuthorizedAgent;
  onRevoke: (agentWallet: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [keyCopy, setKeyCopy] = useState<CopyState>("idle");
  const [snippetCopy, setSnippetCopy] = useState<CopyState>("idle");
  const keyRef = useRef<HTMLInputElement>(null);
  const snippetRef = useRef<HTMLTextAreaElement>(null);

  const active = isAgentActive(agent, Date.now());
  const shownTopic = revealedTopic(agent.topicId, revealed);
  const snippet = buildAgentConnectSnippet(API_URL, agent.topicId);

  const copy = async (
    text: string,
    el: HTMLInputElement | HTMLTextAreaElement | null,
    set: (s: CopyState) => void,
  ): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      set("copied");
      setTimeout(() => set("idle"), TIMEOUTS.clipboardFeedback);
    } catch (err) {
      // Clipboard blocked (permissions, insecure context). Select the text so
      // the user can copy it by hand instead of failing silently.
      console.error("[agents] clipboard copy failed:", err);
      el?.focus();
      el?.select();
      set("fallback");
    }
  };

  return (
    <li className="agents-list__item">
      <div className="agents-list__row">
        <span className="agents-list__main">
          <span className="agents-list__label">{agent.label}</span>
          <span className="agents-list__wallet">{truncateAddress(agent.agentWallet)}</span>
        </span>
        <span className={`agents-list__badge ${active ? "active" : "expired"}`}>
          {active ? "active" : "expired"}
        </span>
        <button
          type="button"
          className="agents-list__connect"
          onClick={() => setRevealed((v) => !v)}
          aria-expanded={revealed}
        >
          {revealed ? "Hide" : "Show connection details"}
        </button>
        <button
          type="button"
          className="agents-list__revoke"
          onClick={() => onRevoke(agent.agentWallet)}
          aria-label={`Revoke ${agent.label}`}
        >
          Revoke
        </button>
      </div>

      {revealed && shownTopic !== null && (
        <div className="agents-connect">
          <p className="agents-connect__warning">
            Anyone with this key can post activity to this feed. Share it only with a trusted agent.
          </p>

          <div className="agents-connect__field">
            <span className="agents-connect__field-label">Stream key</span>
            <div className="agents-connect__row">
              <input
                ref={keyRef}
                className="agents-connect__value"
                value={shownTopic}
                readOnly
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={`Stream key for ${agent.label}`}
              />
              <button
                type="button"
                className="agents-connect__copy"
                onClick={() => void copy(shownTopic, keyRef.current, setKeyCopy)}
              >
                {keyCopy === "copied" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="agents-connect__field">
            <span className="agents-connect__field-label">Agent setup</span>
            <div className="agents-connect__row">
              <textarea
                ref={snippetRef}
                className="agents-connect__value agents-connect__value--block"
                value={snippet}
                readOnly
                rows={2}
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={`Setup for ${agent.label}`}
              />
              <button
                type="button"
                className="agents-connect__copy"
                onClick={() => void copy(snippet, snippetRef.current, setSnippetCopy)}
              >
                {snippetCopy === "copied" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {(keyCopy === "fallback" || snippetCopy === "fallback") && (
            <p className="agents-connect__status">
              Copy did not work. The text is selected, press Cmd+C to copy it.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function AuthorizedAgents() {
  const { agents, authorize, revoke } = useAgentRegistry();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [wallet, setWallet] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmedWallet = wallet.trim();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Give the agent a name.");
      return;
    }
    if (!isAddress(trimmedWallet)) {
      setError("Enter a valid agent wallet address.");
      return;
    }
    // TODO(agent-auth): populate from signed Mandate
    authorize({ label: trimmedLabel, agentWallet: trimmedWallet, mandateHash: null, scopes: [] });
    setLabel("");
    setWallet("");
    setError(null);
    setAdding(false);
  };

  return (
    <div className="agents-section">
      <div className="agents-section__header">
        <span className="agents-section__title">Agents</span>
        {!adding && (
          <button type="button" className="agents-section__add" onClick={() => setAdding(true)}>
            Authorize
          </button>
        )}
      </div>

      {agents.length === 0 && !adding && (
        <p className="agents-section__empty">
          No authorized agents. An authorized agent streams its activity privately.
        </p>
      )}

      {agents.length > 0 && (
        <ul className="agents-list">
          {agents.map((a) => (
            <AgentRow key={a.agentWallet} agent={a} onRevoke={revoke} />
          ))}
        </ul>
      )}

      {adding && (
        <div className="agents-add">
          <input
            className="agents-add__input"
            type="text"
            placeholder="Name (e.g. my rebalancer)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoComplete="off"
          />
          <input
            className="agents-add__input"
            type="text"
            placeholder="Agent wallet (0x...)"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {error && <span className="agents-add__error">{error}</span>}
          <div className="agents-add__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn btn--sm" onClick={submit}>
              Authorize
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
