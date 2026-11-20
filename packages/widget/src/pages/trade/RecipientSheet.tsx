import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";
import {
  resolveRecipient,
  type ResolveResult,
  type ResolvedRecipient,
} from "../../lib/recipient/index.js";
import type { SettlementType } from "../../types/index.js";
import { RecentRecipients } from "../send/RecentRecipients.js";
import { RecipientChip } from "../send/RecipientChip.js";
import { abbreviateMetaAddress } from "../send/stealthRecipient.js";
import { useRecipientDeps } from "../send/useSendRecipient.js";

export function recipientLabel(input: string): string {
  if (input.startsWith("st:eth:")) return abbreviateMetaAddress(input);
  if (input.startsWith("0x") && input.length > 14) return `${input.slice(0, 6)}…${input.slice(-4)}`;
  return input;
}

export function recipientIssue(recipient: ResolvedRecipient, mode: SettlementType): string | null {
  if (mode === "shielded" && !recipient.shieldedAlias)
    return "Enter a zk.money alias for Shielded.";
  if (mode === "stealth" && !recipient.stealthMetaAddress) {
    return `${recipient.name ?? recipientLabel(recipient.input)} hasn't set up stealth receiving`;
  }
  if (mode === "public" && !recipient.address) return "Enter a wallet address or name for Public.";
  return null;
}

export function RecipientSheet({
  selected,
  mode,
  onSelect,
  onClose,
  portalTarget,
}: {
  selected: ResolvedRecipient | null;
  mode: SettlementType;
  onSelect: (recipient: ResolvedRecipient | null, mode?: SettlementType) => void;
  onClose: () => void;
  portalTarget?: HTMLElement | null;
}) {
  const titleId = useId();
  const fieldId = useId();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  const deps = useRecipientDeps();
  const [input, setInput] = useState(selected?.input ?? "");
  const [recentPick, setRecentPick] = useState(false);
  const [lookup, setLookup] = useState<{ input: string; result: ResolveResult }>();
  const result = lookup?.input === input ? lookup.result : undefined;
  const resolved = result?.status === "resolved" ? result.recipient : undefined;
  const issue = resolved ? recipientIssue(resolved, mode) : null;
  const canUsePublic = !!resolved?.address && mode === "stealth" && !!issue;

  const chooseRecent = useEffectEvent((recipient: ResolvedRecipient) => {
    if (!recipientIssue(recipient, mode)) choose(recipient);
  });

  useEffect(() => {
    const value = input.trim();
    if (!value) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!deps) {
        setLookup({
          input,
          result: { status: "unavailable", reason: "Recipient lookup unavailable." },
        });
        return;
      }
      void resolveRecipient(value, deps, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setLookup({ input, result });
        if (recentPick && result.status === "resolved") chooseRecent(result.recipient);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, deps, recentPick]);

  function choose(recipient: ResolvedRecipient | null, nextMode?: SettlementType) {
    onSelect(recipient, nextMode);
    onClose();
  }

  return createPortal(
    <div
      ref={trapRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="modal-content swap-recipient-sheet">
        <div className="modal-header">
          <h3 className="modal-title" id={titleId}>
            To
          </h3>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (resolved && !issue && !recentPick) choose(resolved);
          }}
        >
          <label className="recipient-field__label" htmlFor={fieldId}>
            Name or address
          </label>
          <input
            ref={fieldRef}
            id={fieldId}
            className="recipient-field__input"
            value={input}
            onChange={(event) => {
              setRecentPick(false);
              setLookup(undefined);
              setInput(event.target.value);
            }}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <div className="swap-recipient-status" role="status">
            {resolved && <RecipientChip recipient={resolved} />}
            {issue ??
              (result && result.status !== "resolved"
                ? result.reason
                : input.trim() && !result
                  ? "Resolving…"
                  : null)}
          </div>
          <div className="swap-recipient-actions">
            {resolved && !issue && (
              <button className="btn btn--primary" type="submit" disabled={recentPick}>
                Use recipient
              </button>
            )}
            {canUsePublic && (
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => choose(resolved, "public")}
              >
                Use Public instead
              </button>
            )}
            <button className="btn btn--ghost" type="button" onClick={() => choose(null)}>
              Use my wallet
            </button>
          </div>
        </form>
        <RecentRecipients
          onSelect={(value) => {
            if (input === value && resolved && !issue) {
              choose(resolved);
              return;
            }
            if (input !== value || !recentPick) {
              setLookup(undefined);
              setInput(value);
              setRecentPick(true);
            }
          }}
        />
      </div>
    </div>,
    portalTarget?.ownerDocument.body ?? document.body,
  );
}
