import { useRef, useState } from "react";

export function QuoteSupportCode({ code }: { code: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setFeedback("Support code copied.");
    } catch {
      field.current?.focus();
      field.current?.select();
      setFeedback("Support code selected. Copy it manually.");
    }
  }

  return (
    <div className="quote-support-code">
      <input
        ref={field}
        aria-label="Support code"
        value={code}
        readOnly
        autoComplete="off"
        spellCheck={false}
      />
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}>
        Copy support code
      </button>
      <span role="status">{feedback}</span>
    </div>
  );
}
