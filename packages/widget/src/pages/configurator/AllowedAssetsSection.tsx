/**
 * The Allowed assets section (xochi-fi/xochi-widget#39): which chains and
 * tokens each leg of the frame may use. Every box ticked is no list at all;
 * unticking writes the list (`fromChains`, `toChains`, `sellTokens`,
 * `buyTokens`, embedParams.ts). The lists are shown as asked, so one the frame
 * ignores stays visible here with the frame's reason.
 */

import type { SelectableChainId } from "@xochi/client";
import { type EmbedAllowField } from "@xochi/widget-lib";
import {
  chainName,
  legSymbols,
  type EmbedAllowLists,
  type EmbedIgnored,
  type EmbedOffer,
} from "../trade/embedParams.js";
import { PolicyNote } from "./PolicyNote.js";

/** Each list as this section names it, in the order it shows them. */
const LIST_LABEL: Record<EmbedAllowField, string> = {
  fromChains: "Send chains",
  sellTokens: "Send tokens",
  toChains: "Receive chains",
  buyTokens: "Receive tokens",
};

interface CheckListProps<T extends number | string> {
  legend: string;
  options: readonly T[];
  label: (value: T) => string;
  /** The list as asked; undefined is every option. */
  asked: readonly T[] | undefined;
  onChange: (next: readonly T[] | undefined) => void;
}

/** A ticked box per option. The last ticked box cannot be unticked. */
function CheckList<T extends number | string>({
  legend,
  options,
  label,
  asked,
  onChange,
}: CheckListProps<T>) {
  const ticked = asked ?? options;
  return (
    <fieldset className="config-checks">
      <legend className="config-field__label">{legend}</legend>
      {options.map((value) => {
        const on = ticked.includes(value);
        const last = on && ticked.filter((v) => options.includes(v)).length === 1;
        return (
          <label key={String(value)} className="config-check">
            <input
              type="checkbox"
              checked={on}
              disabled={last}
              title={last ? "Keep at least one" : undefined}
              onChange={() => {
                const next = on ? ticked.filter((v) => v !== value) : [...ticked, value];
                const ordered = options.filter((v) => next.includes(v));
                onChange(ordered.length === options.length ? undefined : ordered);
              }}
            />
            {label(value)}
          </label>
        );
      })}
    </fieldset>
  );
}

interface AllowedAssetsSectionProps {
  /** The frame's full offer (not narrowed): every option a list can keep. */
  offer: EmbedOffer;
  asked: EmbedAllowLists;
  ignored: EmbedIgnored;
  onLists: (lists: EmbedAllowLists) => void;
}

export function AllowedAssetsSection({
  offer,
  asked,
  ignored,
  onLists,
}: AllowedAssetsSectionProps) {
  const set = (field: EmbedAllowField, value: readonly (number | string)[] | undefined): void => {
    onLists({ ...asked, [field]: value });
  };
  const reasons = (["fromChains", "sellTokens", "toChains", "buyTokens"] as const).flatMap(
    (field) => (ignored[field] === undefined ? [] : [`${LIST_LABEL[field]}: ${ignored[field]}`]),
  );
  return (
    <>
      <PolicyNote />
      {(
        [
          ["Send", "fromChains", "sellTokens", offer.sourceChainIds, "sell"],
          ["Receive", "toChains", "buyTokens", offer.destinationChainIds, "buy"],
        ] as const
      ).map(([legend, chainField, tokenField, chainIds, leg]) => (
        <fieldset key={legend} className="config-leg">
          <legend className="label">{legend}</legend>
          <CheckList
            legend="Chains"
            options={chainIds}
            label={chainName}
            asked={asked[chainField]?.filter((id): id is SelectableChainId =>
              chainIds.some((c) => c === id),
            )}
            onChange={(next) => set(chainField, next)}
          />
          <CheckList
            legend="Tokens"
            options={legSymbols(offer, chainIds, leg)}
            label={(symbol) => symbol}
            asked={asked[tokenField]?.map(
              (s) =>
                legSymbols(offer, chainIds, leg).find((o) => o.toUpperCase() === s.toUpperCase()) ??
                s,
            )}
            onChange={(next) => set(tokenField, next)}
          />
        </fieldset>
      ))}
      {reasons.length > 0 ? (
        <div className="config-problems" role="status">
          <p className="config-problems__title">Lists not applied</p>
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}.</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
