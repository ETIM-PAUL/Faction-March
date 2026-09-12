import { FACTION_COLORS, FACTION_NAMES } from '../config';

export function factionName(faction: number): string {
  return FACTION_NAMES[faction] ?? `Faction(${faction})`;
}

export function factionColor(faction: number): string {
  return FACTION_COLORS[faction] ?? '#999999';
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Formats elapsed march time as m:ss, ticking every second — the clock the build plan
 * insists on showing so the UI never implies instant resolution. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatCtc(wei: bigint, decimals = 5): string {
  const asNumber = Number(wei) / 1e18;
  return asNumber.toFixed(decimals);
}
