import { useEffect, useState } from "react";
import type { EmbedParams } from "@xochi/widget-lib";
import { DESTINATIONS, MODES, TABS, surfaceParams } from "./surfaceParams.js";

const LABELS: Record<string, string> = {
  trade: "Trade",
  send: "Send",
  activity: "Activity",
  claims: "Claims",
  onramp: "Buy",
  swap: "Swap",
  offramp: "Cash out",
  address: "Wallet address",
  stealth: "Stealth",
};

export function SurfaceSection({
  params,
  onChange,
}: {
  params: EmbedParams;
  onChange: (params: EmbedParams) => void;
}) {
  const config = surfaceParams(params);
  const [fiatText, setFiatText] = useState(config.fiatCurrency ?? "");
  useEffect(() => setFiatText(config.fiatCurrency ?? ""), [config.fiatCurrency]);
  const fiatValid = fiatText === "" || /^[A-Z]{3}$/.test(fiatText);
  const update = (patch: EmbedParams) => onChange(surfaceParams({ ...config, ...patch }));
  return (
    <>
      <p className="config-hint">
        These options set defaults or narrow the widget. They cannot make an unavailable rail
        available. Live capabilities and wallet approvals still apply.
      </p>
      {(
        [
          ["tabs", "Visible tabs", TABS],
          ["modes", "Trade modes", MODES],
          ["sendDestinations", "Send destinations", DESTINATIONS],
        ] as const
      ).map(([field, title, values]) => {
        const selected: readonly string[] = config[field] ?? values;
        return (
          <fieldset key={field} className="config-leg">
            <legend className="label">{title}</legend>
            <div className="config-choices">
              {values.map((value) => (
                <label key={value} className="config-choice">
                  <input
                    type="checkbox"
                    checked={selected.includes(value)}
                    disabled={selected.length === 1 && selected.includes(value)}
                    onChange={(event) =>
                      update({
                        [field]: values.filter((item) =>
                          item === value ? event.target.checked : selected.includes(item),
                        ),
                      })
                    }
                  />
                  <span className="config-choice__name">{LABELS[value]}</span>
                  {value === "claims" && (
                    <span className="config-choice__meta">
                      Appears once a wallet connects, so the preview here does not show it.
                    </span>
                  )}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
      <label className="config-field">
        Initial tab
        <select
          className="config-input"
          value={config.initialTab ?? (config.tabs ?? TABS)[0] ?? ""}
          onChange={(event) => update({ initialTab: event.target.value as (typeof TABS)[number] })}
        >
          {config.tabs?.length === 0 && <option value="">No visible tabs</option>}
          {(config.tabs ?? TABS).map((value) => (
            <option key={value} value={value}>
              {LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="config-field">
        Initial Trade mode
        <select
          className="config-input"
          value={config.initialMode ?? (config.modes ?? ["swap"])[0] ?? ""}
          onChange={(event) =>
            update({ initialMode: event.target.value as (typeof MODES)[number] })
          }
        >
          {config.modes?.length === 0 && <option value="">No visible Trade modes</option>}
          {(config.modes ?? MODES).map((value) => (
            <option key={value} value={value}>
              {LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="config-field">
        Fiat currency default
        <input
          className="config-input"
          placeholder="Provider default"
          maxLength={3}
          value={fiatText}
          aria-invalid={!fiatValid}
          onChange={(event) => {
            const value = event.target.value.toUpperCase();
            setFiatText(value);
            if (value === "" || /^[A-Z]{3}$/.test(value))
              update({ fiatCurrency: value || undefined });
          }}
        />
      </label>
      {!fiatValid && (
        <p className="config-hint config-hint--error">
          Enter a three-letter currency code to apply this default.
        </p>
      )}
      <label className="config-field">
        Ramp providers
        <select
          className="config-input"
          value={config.rampProviders === undefined ? "all" : (config.rampProviders[0] ?? "")}
          onChange={(event) =>
            update({ rampProviders: event.target.value === "peer" ? ["peer"] : undefined })
          }
        >
          {config.rampProviders?.length === 0 && <option value="">No providers</option>}
          <option value="all">No host narrowing</option>
          <option value="peer">Peer only</option>
        </select>
      </label>
    </>
  );
}
