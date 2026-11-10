/**
 * Fill a Tron address field from the TronLink extension.
 *
 * Used twice on the panel and deliberately not hoisted into `useSwapPanel`: the
 * recipient field and the refund field each need their own independent note, and
 * nothing here belongs to the quote. It is presentation state.
 *
 * The hook only ever hands the caller a validated base58 string. Everything the
 * extension says that is not that becomes a note, so a refusal, a locked wallet
 * and a wrong-shaped response can never arrive at the field as text.
 */
import { useCallback, useState } from "react";
import { getTronLinkProvider, readTronAddress, describeTronOutcome } from "../../lib/tronlink.js";

export interface TronFillNote {
  tone: "ok" | "error";
  text: string;
}

export interface TronLinkFill {
  busy: boolean;
  note: TronFillNote | null;
  /** Ask TronLink, and on success only, pass the address to `apply`. */
  fill: (apply: (address: string) => void) => Promise<void>;
  /** Drop the note, e.g. once the user edits the field by hand. */
  clearNote: () => void;
}

export function useTronLinkFill(): TronLinkFill {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<TronFillNote | null>(null);

  const fill = useCallback(async (apply: (address: string) => void): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const outcome = await readTronAddress(getTronLinkProvider());
      if (outcome.kind === "ok") {
        apply(outcome.address);
        setNote({ tone: "ok", text: "From TronLink. Edit or paste another." });
        return;
      }
      // The user-facing copy never carries the extension's own string; the
      // detail goes to the console so a support report has something to go on.
      if (outcome.kind === "malformed") {
        console.warn(
          "[tronlink] rejected a non-Tron address from the extension:",
          outcome.received,
        );
      } else if (outcome.kind === "failed") {
        console.warn("[tronlink] request failed:", outcome.cause);
      }
      setNote({ tone: "error", text: describeTronOutcome(outcome) });
    } finally {
      // Always clears, so a throw from `apply` cannot strand the button
      // disabled with a spinner and no way back.
      setBusy(false);
    }
  }, []);

  const clearNote = useCallback(() => setNote(null), []);

  return { busy, note, fill, clearNote };
}
