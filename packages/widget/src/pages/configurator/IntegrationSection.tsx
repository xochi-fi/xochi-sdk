/**
 * The Integration section (xochi-fi/xochi-widget#48): the promo code for the
 * snippet (`promo`), checked live on a preview quote while the section is
 * open. The widget never shows the code: the frame sends it on every quote,
 * and an unusable one never blocks it. A referral code (`ref`) is set through
 * Developer only: it applies only under a publishable key, which the widget
 * does not send.
 */

import { useId } from "react";
import { PROMO_NOT_APPLIED_NOTE } from "@xochi/client";
import { codeProblem, type EmbedDefaults } from "../trade/embedParams.js";
import { useCodeCheck, type CodeCheck, type CodeOutcome } from "./useCodeCheck.js";

/** The section's row summary. */
export function integrationSummary(config: Pick<EmbedDefaults, "ref" | "promo">): string {
  const codes = [
    ...(config.ref === null ? [] : [`Referral ${config.ref}`]),
    ...(config.promo === null ? [] : [`Promo ${config.promo}`]),
  ];
  return codes.length === 0 ? "No codes" : codes.join(", ");
}

interface CodeFieldProps {
  label: string;
  placeholder: string;
  text: string;
  onText: (text: string) => void;
  hint: string;
}

function CodeField({ label, placeholder, text, onText, hint }: CodeFieldProps) {
  const id = useId();
  const hintId = useId();
  const problem = codeProblem(text);
  return (
    <div className="config-field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="config-input"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={64}
        placeholder={placeholder}
        value={text}
        aria-invalid={problem !== null}
        aria-describedby={hintId}
        onChange={(e) => onText(e.target.value)}
      />
      <p id={hintId} className={problem ? "config-hint config-hint--error" : "config-hint"}>
        {problem ?? hint}
      </p>
    </div>
  );
}

type Answer = { label: "Applied." | "Not applied." | "Not checked."; text: string };

/**
 * The promo code's answer on a priced quote: applied (with what it did), the
 * Worker's note, or neither. Neither means the Worker did not look at the code
 * at all, which it does only when promo codes are off there (xochi#584).
 */
function answer(outcome: CodeOutcome): Answer {
  if (outcome.promo)
    return {
      label: "Applied.",
      text: `${outcome.promo.code}: ${outcome.promo.discount_bps} bps off the venue and routing fees`,
    };
  if (outcome.promoNote !== undefined) return { label: "Not applied.", text: outcome.promoNote };
  return { label: "Not checked.", text: "Promo codes are off on this server." };
}

function CheckResult({ check }: { check: CodeCheck }) {
  if (check.kind === "none") return null;
  if (check.kind === "checking") return <p className="config-hint">Checking...</p>;
  if (check.kind === "no_bid") {
    // No solver priced the preview, so no code was judged: never a code verdict.
    return (
      <p className="config-hint config-hint--error">
        Not checked: no bid on this route ({check.reason}). Set an amount in Route.
      </p>
    );
  }
  if (check.kind === "failed") {
    return <p className="config-hint config-hint--error">Couldn't check: {check.reason}.</p>;
  }
  const result = answer(check.outcome);
  return (
    <div className="config-codecheck">
      <dl className="config-codecheck__list">
        <div className="config-codecheck__row">
          <dt>Promo</dt>
          <dd className={result.label === "Applied." ? "config-codecheck__applied" : undefined}>
            {result.label} {result.text}
            {/* A first-trade code is evaluated only for a signed-in trader's own
                quote (xochi#620), so this public preview always gets the
                uniform note for one, valid or not. */}
            {check.outcome.promoNote === PROMO_NOT_APPLIED_NOTE ? (
              <span className="config-codecheck__why">
                {" "}
                Unknown, expired or used up, or a first-trade code, which is checked only when a
                signed-in trader quotes.
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {result.label === "Applied." ? null : (
        <p className="config-hint">An unapplied code never blocks a quote.</p>
      )}
    </div>
  );
}

interface IntegrationSectionProps {
  config: EmbedDefaults;
  promoText: string;
  onPromo: (text: string) => void;
  /** Quiet time after typing before the preview quote. */
  delayMs: number;
}

export function IntegrationSection({
  config,
  promoText,
  onPromo,
  delayMs,
}: IntegrationSectionProps) {
  const check = useCodeCheck(config, delayMs);
  return (
    <>
      <CodeField
        label="Promo code"
        placeholder="None"
        text={promoText}
        onText={onPromo}
        hint="Lowers the venue and routing fees, never below the Institutional tier. Anyone who loads the page can read it from the embed URL."
      />
      <div aria-live="polite">
        <CheckResult check={check} />
      </div>
    </>
  );
}
