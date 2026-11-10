/**
 * The recipient receipt step on a shielded payout row: where to run the
 * command, what it needs, and a Copy that puts only the command on the
 * clipboard. The session token is never copied: the recipient supplies the
 * same XOCHI_JWT and options they used for `enroll`.
 *
 * Copy follows the agents panel (AuthorizedAgents): a refused clipboard selects
 * the command and says to copy it by hand. Both outcomes are announced.
 */

import { useRef, useState } from "react";
import { TIMEOUTS } from "../config.js";

type CopyState = "idle" | "copied" | "fallback";

const FALLBACK = "Copy did not work. The text is selected, press Cmd+C to copy it.";

export function ReceiptCommand({ command }: { command: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const codeRef = useRef<HTMLElement>(null);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), TIMEOUTS.clipboardFeedback);
    } catch (err) {
      // Clipboard blocked (permissions, insecure context, an embed without
      // clipboard-write). Select the command so it can be copied by hand.
      console.error("[activity] clipboard copy failed:", err);
      if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
      setCopyState("fallback");
    }
  };

  return (
    <div className="expanded-receipt">
      <div className="expanded-receipt__row">
        <p className="expanded-receipt__text">
          {"On the recipient's machine, run "}
          <code ref={codeRef}>{command}</code>
          {" with the same options and "}
          <code>XOCHI_JWT</code>
          {" you used for "}
          <code>enroll</code>.
        </p>
        <button
          type="button"
          className="agents-connect__copy"
          aria-label={copyState === "copied" ? "Copied receipt command" : "Copy receipt command"}
          onClick={() => void copy()}
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={copyState === "fallback" ? "agents-connect__status" : "sr-only"} role="status">
        {copyState === "copied"
          ? "Receipt command copied"
          : copyState === "fallback"
            ? FALLBACK
            : ""}
      </p>
    </div>
  );
}
