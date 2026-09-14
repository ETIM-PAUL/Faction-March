-- Faction March: per-(game, faction) chat.
--
-- This table is deliberately unreachable from the public API. Row Level Security is
-- enabled with zero policies granted to `anon` or `authenticated`, which means Postgres
-- denies every request from those roles by default -- there is no "read your own faction"
-- policy to bypass, because there is no policy at all. The only way in is the
-- `faction-chat` Edge Function, which holds the service_role key (which bypasses RLS
-- entirely, as it always does in Postgres/Supabase) and enforces membership itself: a
-- wallet must produce a valid signature *and* actually hold a nonzero
-- FactionMarch.commanderFaction(gameId, address) on-chain before the function will read or
-- write a single row on that wallet's behalf. Postgres RLS here isn't the enforcement
-- layer, the on-chain check is; RLS is the backstop that makes bypassing the function
-- pointless even if someone had the anon key (which is already public in the bundle by
-- necessity -- see web/src/config.ts's own comment on that).

create table if not exists public.faction_messages (
  id bigint generated always as identity primary key,
  game_id bigint not null,
  faction smallint not null check (faction in (1, 2, 3)), -- FactionMarch.Faction: Alpha/Beta/Gamma
  sender_address text not null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists faction_messages_room_idx
  on public.faction_messages (game_id, faction, created_at desc);

alter table public.faction_messages enable row level security;
-- No policies created on purpose -- see header comment. anon/authenticated get nothing;
-- service_role (used only inside the Edge Function) bypasses RLS as usual.
revoke all on public.faction_messages from anon, authenticated;
