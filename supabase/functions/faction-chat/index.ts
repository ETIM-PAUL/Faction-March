// Faction March chat gatekeeper. This is the *only* thing that can ever read or write
// public.faction_messages -- the table itself has RLS enabled with zero grants to
// anon/authenticated (see the migration), so the only path in is this function, which holds
// the service_role key (kept server-side, never shipped to the browser) and enforces real
// membership before doing anything: a wallet must produce a valid EIP-191 signature over a
// freshly-issued login message *and* actually hold a nonzero
// FactionMarch.commanderFaction(gameId, address) read live from Creditcoin CC3, not from
// anything Supabase itself knows about. Deployed with --no-verify-jwt because the session
// token this mints is not a Supabase-recognized JWT -- it's a small hand-rolled HMAC token
// scoped to (address, gameId, faction), verified entirely in this function on every request.
//
// Three actions, one endpoint:
//   auth  -- {address, gameId, issuedAt, signature} -> {token, faction, expiresAt}
//   list  -- Authorization: Bearer <token> -> {messages}
//   send  -- Authorization: Bearer <token>, {body} -> {ok}

import { ethers } from 'npm:ethers@6.13.4';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SESSION_SECRET = Deno.env.get('CHAT_SESSION_SECRET')!;
const CREDITCOIN_RPC_URL = Deno.env.get('CREDITCOIN_RPC_URL') ?? 'https://rpc.cc3-testnet.creditcoin.network';
const FACTION_MARCH_ADDRESS = Deno.env.get('FACTION_MARCH_ADDRESS')!;

const FACTION_MARCH_ABI = ['function commanderFaction(uint256 gameId, address commander) view returns (uint8)'];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const encoder = new TextEncoder();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let str = '';
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(encoder.encode(text));
}

function base64UrlToText(b64url: string): string {
  let str = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function hmacSign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return bytesToBase64Url(new Uint8Array(sig));
}

interface SessionClaims {
  address: string;
  gameId: string;
  faction: number;
  exp: number; // unix seconds
}

async function mintToken(claims: SessionClaims): Promise<string> {
  const header = textToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = textToBase64Url(JSON.stringify(claims));
  const sig = await hmacSign(`${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

async function verifyToken(token: string): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = await hmacSign(`${header}.${payload}`);
  // Constant-time-ish compare isn't critical here (HMAC output, not a secret being guessed
  // character by character over many requests against a rate-unlimited endpoint would be a
  // separate concern, but this is a session token check, not the signing key itself).
  if (expected !== sig) return null;
  const claims = JSON.parse(base64UrlToText(payload)) as SessionClaims;
  if (typeof claims.exp !== 'number' || Date.now() / 1000 > claims.exp) return null;
  return claims;
}

function buildLoginMessage(address: string, gameId: string, issuedAt: string): string {
  return `Faction March chat login\naddress:${address.toLowerCase()}\ngameId:${gameId}\nissuedAt:${issuedAt}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    if (body.action === 'auth') {
      const address = String(body.address ?? '');
      const gameId = String(body.gameId ?? '');
      const issuedAt = String(body.issuedAt ?? '');
      const signature = String(body.signature ?? '');
      if (!address || !gameId || !issuedAt || !signature) return json({ error: 'Missing fields' }, 400);

      // Reject a signature over a stale login message -- bounds how long a captured
      // signature (e.g. from a compromised clipboard, not from breaking the crypto) stays
      // usable, since this scheme has no separate server-issued nonce to invalidate.
      const issuedAtMs = Date.parse(issuedAt);
      if (!issuedAtMs || Math.abs(Date.now() - issuedAtMs) > 10 * 60 * 1000) {
        return json({ error: 'Login expired -- try unlocking chat again' }, 400);
      }

      const message = buildLoginMessage(address, gameId, issuedAt);
      let recovered: string;
      try {
        recovered = ethers.verifyMessage(message, signature);
      } catch {
        return json({ error: 'Invalid signature' }, 401);
      }
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return json({ error: 'Signature does not match address' }, 401);
      }

      // The actual authorization check: read live from FactionMarch, not from anything this
      // database has cached or been told.
      const provider = new ethers.JsonRpcProvider(CREDITCOIN_RPC_URL);
      const march = new ethers.Contract(FACTION_MARCH_ADDRESS, FACTION_MARCH_ABI, provider);
      const faction = Number(await march.commanderFaction(BigInt(gameId), address));
      if (faction === 0) {
        return json({ error: 'This wallet has not joined a faction in this game' }, 403);
      }

      const exp = Math.floor(Date.now() / 1000) + 6 * 60 * 60; // 6 hours
      const token = await mintToken({ address: address.toLowerCase(), gameId, faction, exp });
      return json({ token, faction, expiresAt: exp * 1000 });
    }

    if (body.action === 'list' || body.action === 'send') {
      const authHeader = req.headers.get('Authorization') ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const claims = await verifyToken(token);
      if (!claims) return json({ error: 'Session expired -- unlock chat again' }, 401);

      if (body.action === 'list') {
        const { data, error } = await admin
          .from('faction_messages')
          .select('id, sender_address, body, created_at')
          .eq('game_id', claims.gameId)
          .eq('faction', claims.faction)
          .order('created_at', { ascending: false })
          .limit(200);
        if (error) return json({ error: error.message }, 500);
        return json({ messages: (data ?? []).slice().reverse() });
      }

      // send
      const text = String(body.body ?? '').trim();
      if (!text) return json({ error: 'Empty message' }, 400);
      if (text.length > 500) return json({ error: 'Message too long (max 500 characters)' }, 400);
      const { error } = await admin.from('faction_messages').insert({
        game_id: claims.gameId,
        faction: claims.faction,
        sender_address: claims.address,
        body: text,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
