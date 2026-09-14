import { FACTION_CHAT_URL } from '../config';

// Client for the faction-chat Edge Function. The function is the only thing that can reach
// public.faction_messages (RLS denies anon/authenticated entirely); this file just wraps its
// three actions and caches the session token locally.

export interface ChatMessage {
  id: number;
  sender_address: string;
  body: string;
  created_at: string;
}

interface ChatSession {
  token: string;
  faction: number;
  expiresAt: number;
}

function storageKey(gameId: string, address: string): string {
  return `factionmarch.chatSession.${gameId}.${address.toLowerCase()}`;
}

export function loadSession(gameId: string, address: string): ChatSession | null {
  try {
    const raw = localStorage.getItem(storageKey(gameId, address));
    if (!raw) return null;
    const session = JSON.parse(raw) as ChatSession;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function saveSession(gameId: string, address: string, session: ChatSession): void {
  try {
    localStorage.setItem(storageKey(gameId, address), JSON.stringify(session));
  } catch {
    // best-effort -- unlocking again next visit is a fine fallback
  }
}

function buildLoginMessage(address: string, gameId: string, issuedAt: string): string {
  return `Faction March chat login\naddress:${address.toLowerCase()}\ngameId:${gameId}\nissuedAt:${issuedAt}`;
}

/** Signs a login message with the connected wallet and exchanges it for a chat session,
 * scoped server-side to whatever faction FactionMarch.commanderFaction actually returns for
 * this (gameId, address) right now. Throws with a message from the function on failure
 * (e.g. "hasn't joined a faction in this game"). */
export async function unlockChat(
  signer: { signMessage(message: string): Promise<string> },
  address: string,
  gameId: string
): Promise<ChatSession> {
  const issuedAt = new Date().toISOString();
  const message = buildLoginMessage(address, gameId, issuedAt);
  const signature = await signer.signMessage(message);

  const res = await fetch(FACTION_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'auth', address, gameId, issuedAt, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Chat unlock failed (HTTP ${res.status})`);

  const session: ChatSession = { token: body.token, faction: body.faction, expiresAt: body.expiresAt };
  saveSession(gameId, address, session);
  return session;
}

export async function listMessages(session: ChatSession): Promise<ChatMessage[]> {
  const res = await fetch(FACTION_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ action: 'list' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Failed to load messages (HTTP ${res.status})`);
  return body.messages as ChatMessage[];
}

export async function sendMessage(session: ChatSession, text: string): Promise<void> {
  const res = await fetch(FACTION_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ action: 'send', body: text }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Failed to send (HTTP ${res.status})`);
}
