/**
 * SolverRace
 *
 * Live view of the fill race while an intent executes: one lane per competing
 * solver, a running clock, and the winner flagged when the round resolves.
 * Renders inside SwapFlowModal's progress view above IntentTimeline. The
 * timeline says where the swap is; this says who is fighting to fill it.
 *
 * HONESTY RULES. This component sits on the screen at the moment a user is
 * waiting on their money, which is exactly when a reassuring animation is most
 * tempting and least defensible:
 *
 * - Lanes render only from real `solver_bid` / `race_won` frames. No frames --
 *   Riddler has not shipped race telemetry for the route, the socket died, or
 *   the quote carried no stream topic -- renders the sealed-intent line alone,
 *   which is true unconditionally. It never invents bids or animates fake
 *   competitors.
 * - With one active solver the copy leads with speed and sealed intents rather
 *   than "competition", because there is not any.
 * - The clock freezes on the server's `elapsedMs` at race_won. The local timer
 *   is display-only and never outruns the server's number.
 * - HANDLES ONLY, no figures (register R19). Bid amounts and improvement bps
 *   arrive on the frames, and rendering them would promise money: the payout
 *   pays the signed quote exactly, and no settlement path can pay a winning
 *   bid today. Until the delivered amount is a served field and improvements
 *   are actually payable, a lane is a solver handle and a status word.
 */

import { useEffect, useRef, useState } from "react";
import type { RaceWebSocketMessage } from "../types/intent.js";

interface SolverRaceProps {
  raceEvents: RaceWebSocketMessage[];
  /** True once the intent reached a terminal or settling state (stops the clock). */
  settled: boolean;
}

interface Lane {
  solver: string;
  won: boolean;
}

/** Fold frames into one lane per solver, winner flagged and sorted first. */
function foldLanes(events: RaceWebSocketMessage[]): Lane[] {
  const bySolver = new Map<string, Lane>();
  for (const e of events) {
    if ((e.type !== "solver_bid" && e.type !== "race_won") || !e.solver) continue;
    const prev = bySolver.get(e.solver);
    bySolver.set(e.solver, {
      solver: e.solver,
      won: e.type === "race_won" || prev?.won === true,
    });
  }
  return [...bySolver.values()].sort((a, b) => Number(b.won) - Number(a.won));
}

export function SolverRace({ raceEvents, settled }: SolverRaceProps) {
  const started = raceEvents.find((e) => e.type === "race_started");
  const won = raceEvents.find((e) => e.type === "race_won");
  const lanes = foldLanes(raceEvents);

  const solversActive = started?.solversActive ?? (lanes.length > 0 ? lanes.length : null);
  const competitive = (solversActive ?? 0) >= 2 || lanes.length >= 2;

  // Local display clock from the first frame, frozen on the server's elapsedMs
  // the moment the race is won (or the swap settles without race frames).
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (raceEvents.length === 0) return;
    if (startRef.current === null) startRef.current = Date.now();
    if (won?.elapsedMs != null) {
      setElapsed(won.elapsedMs);
      return;
    }
    if (settled) return; // Keep the last shown value; never fabricate a final time.
    const id = setInterval(() => {
      if (startRef.current !== null) setElapsed(Date.now() - startRef.current);
    }, 100);
    return () => clearInterval(id);
  }, [raceEvents.length, won?.elapsedMs, settled]);

  // Nothing streamed: show only the unconditional truth.
  if (raceEvents.length === 0) {
    return (
      <div className="solver-race solver-race--quiet" aria-live="polite">
        <p className="solver-race__sealed">
          The intent is sealed. It never touches a public mempool.
        </p>
      </div>
    );
  }

  const clock =
    elapsed == null ? null : elapsed < 10_000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(2)}s`;

  return (
    <div className="solver-race" aria-live="polite">
      <div className="solver-race__head">
        <span className="solver-race__title">
          {won
            ? "Filled"
            : competitive
              ? `${solversActive ?? lanes.length} solvers racing`
              : "Solver filling the intent"}
        </span>
        {clock && <span className="solver-race__clock">{clock}</span>}
      </div>

      <p className="solver-race__sealed">
        Sealed intent. Solvers bid without seeing a public mempool.
      </p>

      {lanes.length > 0 && (
        <ul className="solver-race__lanes">
          {lanes.map((lane) => (
            <li
              key={lane.solver}
              className={`solver-race__lane${lane.won ? " solver-race__lane--won" : ""}`}
            >
              <span className="solver-race__dot" aria-hidden="true" />
              <span className="solver-race__solver">{lane.solver}</span>
              <span className="solver-race__flag">{lane.won ? "filled" : "filling"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
