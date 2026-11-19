import { readRecentRecipientEntries } from "../../lib/recipient/recent.js";
import { RecipientChip } from "./RecipientChip.js";

export function RecentRecipients({ onSelect }: { onSelect: (input: string) => void }) {
  const recent = readRecentRecipientEntries();
  if (!recent.length) return null;

  return (
    <section className="recent-recipients" aria-label="Recent recipients">
      <p>Recent</p>
      {recent.map((recipient) => (
        <button
          className="recent-recipients__pick"
          key={recipient.input}
          type="button"
          onClick={() => onSelect(recipient.input)}
        >
          <RecipientChip recipient={recipient} />
        </button>
      ))}
    </section>
  );
}
