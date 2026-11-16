/**
 * A stealth meta-address on screen: abbreviated, with a Copy that puts the full
 * `st:eth:0x...` on the clipboard so the sender can check it against what the
 * recipient sent. A refused clipboard shows the full value selected instead, as
 * ReceiptCommand does. Both outcomes are announced.
 */

import { useRef, useState } from "react";
import { TIMEOUTS } from "../../config.js";
import { abbreviateMetaAddress } from "./stealthRecipient.js";

type CopyState = "idle" | "copied" | "fallback";

export function MetaAddressValue({ encoded }: { encoded: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const codeRef = useRef<HTMLElement>(null);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(encoded);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), TIMEOUTS.clipboardFeedback);
    } catch {
      setCopyState("fallback");
      requestAnimationFrame(() => {
        if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
      });
    }
  };

  return (
    <span className="send-meta">
      <code ref={codeRef} className="send-review__mono" title={encoded}>
        {copyState === "fallback" ? encoded : abbreviateMetaAddress(encoded)}
      </code>
      <button type="button" className="send-secondary send-meta__copy" onClick={() => void copy()}>
        {copyState === "copied" ? "Copied" : "Copy full"}
      </button>
      <span className="sr-only" aria-live="polite">
        {copyState === "copied"
          ? "Meta-address copied"
          : copyState === "fallback"
            ? "Copy did not work. The full meta-address is shown and selected."
            : ""}
      </span>
    </span>
  );
}
