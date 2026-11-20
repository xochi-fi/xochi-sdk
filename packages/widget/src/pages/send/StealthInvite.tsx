import { useState } from "react";
import { SITE_URL } from "../../config.js";

export function StealthInvite() {
  const [status, setStatus] = useState("");
  const copy = async () => {
    const embedded = window.parent !== window;
    const link = embedded
      ? new URL("/trade", SITE_URL)
      : new URL(location.pathname, location.origin);
    link.searchParams.set(embedded ? "tab" : "initialTab", "send");
    link.searchParams.set("receive", "1");
    try {
      await navigator.clipboard.writeText(
        `To receive with Stealth, open ${link.href}, connect your wallet and select Set up Stealth.`,
      );
      setStatus("Invite copied");
    } catch {
      setStatus("Could not copy invite");
    }
  };

  return (
    <span className="send-invite">
      <button type="button" className="send-secondary" onClick={() => void copy()}>
        Invite to Stealth
      </button>
      {status && <span role="status">{status}</span>}
    </span>
  );
}
