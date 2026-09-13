import { useEffect, useState } from 'react';
import type { TrackedOrder } from '../hooks/useOrders';
import type { GameData } from '../hooks/useGameData';
import { useDoomedOrders } from '../hooks/useDoomedOrders';
import { TYPICAL_MARCH_TIME_MS } from '../config';
import { formatElapsed, shortAddress } from '../lib/format';

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

  const pending = orders.filter((o) => !o.resolved);
  const resolved = orders.filter((o) => o.resolved).slice(0, 8);
  const doomed = useDoomedOrders(pending, game, gameId);

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
              {pending.map((o) => {
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
