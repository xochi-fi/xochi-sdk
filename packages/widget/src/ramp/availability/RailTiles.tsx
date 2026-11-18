import type { ReactNode } from "react";
import { railLogo } from "../../assets/rails/index.js";
import { formatRampTime, RAIL_NAMES, type RailCard } from "./model.js";

function RailLogo({ id }: { id: string }) {
  const logo = railLogo(id);
  if (!logo) return null;
  return (
    <span className={`ramp-tile__logo-row ramp-tile__logo-row--${id}`} aria-hidden="true">
      <span className="ramp-tile__logo">
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
        <strong className="ramp-tile__name">{name}</strong>
        <span className="ramp-tile__status">
          <small>{status}</small>
          {selected && <span aria-hidden="true">✓</span>}
        </span>
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
        aria-label={name}
        aria-description={status ?? card.status}
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

const SHORT_REASONS: Record<RailCard["state"], string> = {
  available: "",
  setup_required: "Complete setup in Peer",
  temporarily_unavailable: "No offer for this request",
  not_supported: "Try another app or amount",
  availability_unknown: "Peer could not confirm availability",
  expired: "Check again for a new offer",
};

export function UnavailableRails({ cards, own }: { cards: RailCard[]; own?: boolean }) {
  if (!cards.length) return null;
  return (
    <section className="ramp-unavailable" aria-label="Unavailable payment apps">
      {cards.map((card) => (
        <details key={card.id}>
          <summary>
            <strong>{own ? `Your ${card.name}` : card.name}</strong>
            <span>{SHORT_REASONS[card.state]}</span>
            {card.retryAfter && <span>Retry after {formatRampTime(card.retryAfter)}</span>}
          </summary>
          <p>
            <strong>{card.status}.</strong> {card.reason}
          </p>
          {card.next && <p>{card.next}</p>}
        </details>
      ))}
    </section>
  );
}
