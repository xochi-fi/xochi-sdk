import type { ReactNode } from "react";
import { railLogo } from "../../assets/rails/index.js";
import { formatRampTime, RAIL_NAMES, type RailCard } from "./model.js";

function RailLogo({ id }: { id: string }) {
  const logo = railLogo(id);
  if (!logo) return null;
  return (
    <span
      className="ramp-tile__logo"
      style={{ padding: 24 * logo.clearSpaceRatio }}
      aria-hidden="true"
    >
      <img src={logo.light} width={logo.width} height={logo.height} alt="" />
      {logo.dark && (
        <img
          className="ramp-tile__logo-dark"
          src={logo.dark}
          width={logo.width}
          height={logo.height}
          alt=""
        />
      )}
    </span>
  );
}

export function RailTileContent({
  id,
  name,
  status,
  selected,
}: {
  id: string;
  name: string;
  status: string;
  selected?: boolean;
}) {
  return (
    <>
      <RailLogo id={id} />
      <span className="ramp-tile__text">
        <strong>{name}</strong>
        <small>{status}</small>
        {selected && <small aria-hidden="true">✓ Selected</small>}
      </span>
    </>
  );
}

export function RailTiles({
  title,
  own,
  untested,
  children,
}: {
  title: string;
  own?: boolean;
  untested: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="ramp-tile-group">
      <legend>{title}</legend>
      <div className="ramp-tile-grid">
        {untested &&
          Object.entries(RAIL_NAMES).map(([id, name]) => (
            <div key={id} className="ramp-tile" aria-disabled="true">
              <RailTileContent
                id={id}
                name={own ? `Your ${name}` : name}
                status="Not checked yet"
              />
            </div>
          ))}
        {children}
      </div>
    </fieldset>
  );
}

export function RailChoice({
  card,
  name,
  group,
  status,
  selected,
  disabled,
  onSelect,
}: {
  card: RailCard;
  name: string;
  group: string;
  status?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="ramp-tile">
      <input
        className="sr-only"
        type="radio"
        name={group}
        value={card.id}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <RailTileContent
        id={card.id}
        name={name}
        status={status ?? card.status}
        selected={selected}
      />
    </label>
  );
}

export function UnavailableRails({ cards, own }: { cards: RailCard[]; own?: boolean }) {
  if (!cards.length) return null;
  return (
    <section className="ramp-unavailable" aria-label="Unavailable payment apps">
      {cards.map((card) => (
        <details key={card.id}>
          <summary>
            <strong>{own ? `Your ${card.name}` : card.name}</strong>
            <span>{card.status}</span>
            {card.retryAfter && <span>Retry after {formatRampTime(card.retryAfter)}</span>}
          </summary>
          <p>{card.reason}</p>
          {card.next && <p>{card.next}</p>}
        </details>
      ))}
    </section>
  );
}
