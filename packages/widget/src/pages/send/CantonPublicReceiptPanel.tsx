import { CANTON_MAINNET_CHAIN_ID } from "@xochi/client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { checkCantonPublicReceipt, type PublicReceiptEvidence } from "./cantonPublicReceipt.js";

const fields = [
  ["updateId", "Update ID"],
  ["sender", "Expected sender"],
  ["recipient", "Expected recipient"],
  ["amount", "Expected CC amount"],
] as const;
const messages: Record<PublicReceiptEvidence["kind"], string> = {
  "public-scan-match": "Matching delivery on public MainNet Scan.",
  mismatch: "Public MainNet Scan delivery does not match.",
  unavailable: "Public MainNet Scan evidence unavailable.",
  malformed: "Receipt details or Scan evidence are invalid.",
  unsupported: "Scan evidence has an unsupported transfer format.",
};

type Draft = Record<(typeof fields)[number][0], string>;
const empty: Draft = { updateId: "", sender: "", recipient: "", amount: "" };

export function CantonPublicReceipt() {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="send-metatarz">
      <button
        type="button"
        className="send-secondary send-metatarz__toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        Public MainNet receipt
      </button>
      <div id={id} hidden={!open}>
        {open && <ReceiptForm />}
      </div>
    </div>
  );
}

function ReceiptForm() {
  const id = useId();
  const [draft, setDraft] = useState(empty);
  const [message, setMessage] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || fields.some(([key]) => !draft[key].trim())) return;
    const request = new AbortController();
    pending.current = request;
    setMessage("Checking public Scan…");
    const result = await checkCantonPublicReceipt(
      { updateId: draft.updateId.trim() },
      {
        chainId: CANTON_MAINNET_CHAIN_ID,
        sender: draft.sender.trim(),
        recipient: draft.recipient.trim(),
        amount: draft.amount.trim(),
      },
      fetch,
      request.signal,
    );
    if (!request.signal.aborted) {
      pending.current = null;
      setMessage(messages[result.kind]);
    }
  }

  return (
    <form className="send-receipt" onSubmit={(event) => void check(event)}>
      {fields.map(([key, label]) => (
        <div key={key}>
          <label className="send-field__label" htmlFor={`${id}-${key}`}>
            {label}
          </label>
          <div className="send-input">
            <input
              id={`${id}-${key}`}
              className="send-field__control"
              required
              maxLength={key === "amount" ? 39 : 255}
              inputMode={key === "amount" ? "decimal" : "text"}
              spellCheck={false}
              autoComplete="off"
              value={draft[key]}
              onChange={(event) => {
                pending.current?.abort();
                pending.current = null;
                setMessage("");
                setDraft({ ...draft, [key]: event.target.value });
              }}
            />
          </div>
        </div>
      ))}
      <button type="submit" className="send-secondary" disabled={pending.current !== null}>
        Check receipt
      </button>
      <div role="status">{message}</div>
    </form>
  );
}
