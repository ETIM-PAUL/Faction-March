import { useEffect, useRef, useState } from 'react';
import type { useWallet } from '../hooks/useWallet';
import { loadSession, unlockChat, listMessages, sendMessage, type ChatMessage } from '../lib/factionChat';
import { factionColor, factionName, shortAddress } from '../lib/format';

const POLL_MS = 4000;

export function FactionChat({
  wallet,
  gameId,
  myFaction,
}: {
  wallet: ReturnType<typeof useWallet>;
  gameId: bigint | null;
  myFaction: number | null;
}) {
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const gameKey = gameId?.toString() ?? null;

  // Re-check for a cached, still-valid session whenever the game or wallet changes.
  useEffect(() => {
    setUnlocked(gameKey !== null && !!wallet.address && !!loadSession(gameKey, wallet.address));
    setMessages([]);
  }, [gameKey, wallet.address]);

  useEffect(() => {
    if (!unlocked || gameKey === null || !wallet.address) return;
    let cancelled = false;
    async function poll() {
      const session = loadSession(gameKey!, wallet.address!);
      if (!session) {
        if (!cancelled) setUnlocked(false);
        return;
      }
      try {
        const msgs = await listMessages(session);
        if (!cancelled) setMessages(msgs);
      } catch {
        // transient network hiccup -- next poll tries again
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [unlocked, gameKey, wallet.address]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  async function handleUnlock() {
    if (gameKey === null || !wallet.address) return;
    setUnlocking(true);
    setError(null);
    try {
      const signer = await wallet.getSigner();
      await unlockChat(signer, wallet.address, gameKey);
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlocking(false);
    }
  }

  async function handleSend() {
    if (gameKey === null || !wallet.address) return;
    const text = draft.trim();
    if (!text) return;
    const session = loadSession(gameKey, wallet.address);
    if (!session) {
      setUnlocked(false);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendMessage(session, text);
      setDraft('');
      const msgs = await listMessages(session);
      setMessages(msgs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  if (gameId === null || !wallet.address || myFaction === null || myFaction <= 0) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Faction chat</h2>
        <span className="panel-eyebrow" style={{ color: factionColor(myFaction) }}>
          {factionName(myFaction)} only
        </span>
      </div>

      {!unlocked ? (
        <div className="field-row">
          <button onClick={handleUnlock} disabled={unlocking} title="Signs a message proving your address; a server checks it against your real on-chain faction before granting access">
            {unlocking ? 'Unlocking…' : 'Unlock chat'}
          </button>
          <span className="muted">One signature, no gas — proves you're really this game's {factionName(myFaction)}.</span>
        </div>
      ) : (
        <>
          <div ref={listRef} className="chat-list">
            {messages.length === 0 ? (
              <p className="muted">No messages yet — say hello.</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="chat-message">
                  <span className="mono chat-sender">{shortAddress(m.sender_address)}</span>
                  <span className="chat-body">{m.body}</span>
                </div>
              ))
            )}
          </div>
          <div className="field-row">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !sending) handleSend();
              }}
              maxLength={500}
              placeholder={`Message ${factionName(myFaction)}…`}
              style={{ flex: 1 }}
            />
            <button onClick={handleSend} disabled={sending || !draft.trim()}>
              {sending ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
