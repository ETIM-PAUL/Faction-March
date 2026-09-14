import { useEffect, useState } from 'react';
import type { TrackedOrder } from '../hooks/useOrders';
import type { GameData } from '../hooks/useGameData';
import { useDoomedOrders } from '../hooks/useDoomedOrders';
import { TYPICAL_MARCH_TIME_MS } from '../config';
import { formatElapsed, shortAddress } from '../lib/format';

const PAGE_SIZE_OPTIONS = [5, 10, 50];

/** Orders sent but not yet proven, ticking in real time, so the UI never implies instant
 * resolution — march time is the feature, and this is where it's shown. An order that can
 * never resolve (bad zone, or a commander who never joined before the game left OPEN) is
 * flagged as stuck rather than left ticking under "running long" forever, which would
 * otherwise look identical to an order that's merely taking a while. */
export function InFlightPanel({ orders, game, gameId }: { orders: TrackedOrder[]; game: GameData; gameId: bigint | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);

  const pending = orders.filter((o) => !o.resolved);
  const resolved = orders.filter((o) => o.resolved).slice(0, 8);
  const doomed = useDoomedOrders(pending, game, gameId);

  const pageCount = Math.max(1, Math.ceil(pending.length / pageSize));
  // Clamp rather than reset to 0 -- avoids yanking the page back under someone mid-review
  // just because a page at the end emptied out (e.g. its last order resolved or settled).
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = pending.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  return (
    <div className="wire-panel">
      <div className="panel-header">
        <h2>In flight</h2>
        <span className="panel-eyebrow">march time is the feature — nothing here resolves early</span>
      </div>
      {pending.length === 0 ? (
        <p className="muted">No orders currently waiting on a proof.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Commander</th>
                <th>Zone</th>
                <th>Units</th>
                <th>Elapsed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((o) => {
                const elapsedMs = o.sentAtMs > 0 ? now - o.sentAtMs : 0;
                const pastTypical = elapsedMs > TYPICAL_MARCH_TIME_MS;
                const doomReason = doomed[o.key];
                const isDoomed = doomReason !== null && doomReason !== undefined;
                return (
                  <tr key={o.key} style={{ opacity: isDoomed ? 0.6 : 1 }}>
                    <td className="mono">{shortAddress(o.commander)}</td>
                    <td className="num">{o.zoneId}</td>
                    <td className="num">{o.units}</td>
                    <td className={`num ${pastTypical && !isDoomed ? 'warn' : ''}`}>
                      {isDoomed ? (
                        <span
                          className="pill error"
                          title={
                            doomReason === 'invalid-zone'
                              ? "This zone doesn't exist in the game — resolveOrder always reverts with InvalidZone."
                              : doomReason === 'exceeds-unit-cap'
                                ? 'This order asks for more units than a unit pool can ever hold (500 max, no amount of waiting raises that ceiling) — resolveOrder always reverts with InsufficientUnits.'
                                : 'This commander never joined before the game left OPEN, and joining is no longer possible — resolveOrder always reverts with NotJoined.'
                          }
                        >
                          {o.sentAtMs > 0 ? formatElapsed(elapsedMs) : '…'} — stuck, will never resolve
                        </span>
                      ) : (
                        <>
                          <span className="wire-dot pulse" aria-hidden="true" />
                          {o.sentAtMs > 0 ? formatElapsed(elapsedMs) : '…'}
                          {pastTypical && ' — running long (typical ~9 min)'}
                        </>
                      )}
                    </td>
                    <td>
                      <a href={`https://sepolia.etherscan.io/tx/${o.sepoliaTxHash}`} target="_blank" rel="noreferrer">
                        Sepolia tx
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pending.length > 0 && (
        <div className="field-row">
          <button className="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={clampedPage === 0}>
            ← Prev
          </button>
          <span className="muted">
            Page {clampedPage + 1} of {pageCount} ({pending.length} in flight)
          </span>
          <button className="ghost" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={clampedPage === pageCount - 1}>
            Next →
          </button>
          <label className="muted">
            Show
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              style={{ marginLeft: 6 }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {resolved.length > 0 && (
        <>
          <h3>Recently resolved</h3>
          <ul className="history-list">
            {resolved.map((o) => (
              <li key={o.key}>
                {shortAddress(o.commander)} → zone {o.zoneId}, {o.units} units — proven
                {o.resolvedAtMs && o.sentAtMs > 0 ? ` in ${formatElapsed(o.resolvedAtMs - o.sentAtMs)}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
