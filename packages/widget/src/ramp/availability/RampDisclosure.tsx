import { useId, useState } from "react";
import type { RampDirection } from "@xochi/client";
import { InfoButton } from "../../components/InfoButton.js";
import { rampFacts } from "./model.js";

const summaries = {
  onramp: "Public on Base. The seller sees your payment name.",
  offramp: "Your own account. Base deposit is public.",
} satisfies Record<RampDirection, string>;

export function RampFacts({
  direction,
  id,
  hidden,
}: {
  direction: RampDirection;
  id?: string;
  hidden?: boolean;
}) {
  return (
    <ul id={id} hidden={hidden} className="ramp-facts__list">
      {rampFacts(direction).map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}

export function RampDisclosure({ direction }: { direction: RampDirection }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="ramp-facts" aria-label="Before you choose">
      <div className="ramp-facts__summary">
        <span>{summaries[direction]}</span>
        <InfoButton
          label={direction === "onramp" ? "Buy disclosures" : "Cash out disclosures"}
          controls={id}
          expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        />
      </div>
      <RampFacts id={id} direction={direction} hidden={!expanded} />
    </section>
  );
}
