import { useEffect, useState } from 'react';
import type { TrackedOrder } from '../hooks/useOrders';
import { TYPICAL_MARCH_TIME_MS } from '../config';
import { formatElapsed, shortAddress } from '../lib/format';

/** The screen the build plan calls "the single most important" — orders sent but not yet
 * proven, ticking in real time, so the UI never implies instant resolution. March time is
 * the feature; this is where it's shown. */
export function InFlightPanel({ orders }: { orders: TrackedOrder[] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pending = orders.filter((o) => !o.resolved);
  const resolved = orders.filter((o) => o.resolved).slice(0, 8);

  return (
    <div className="card">
      <h2>In flight</h2>
      {pending.length === 0 ? (
        <p className="muted">No orders currently waiting on a proof.</p>
      ) : (
        <table className="orders-table">
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
              return (
                <tr key={o.key}>
                  <td>{shortAddress(o.commander)}</td>
                  <td>{o.zoneId}</td>
                  <td>{o.units}</td>
                  <td className={pastTypical ? 'warn' : ''}>
                    {o.sentAtMs > 0 ? formatElapsed(elapsedMs) : '…'}
                    {pastTypical && ' (attestation usually ~9 min — this one is running long)'}
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
