-- Field Journal cloud setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run more than once.

-- Entries: one row per journal entry; the entry itself is kept as JSON.
create table if not exists public.entries (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated    bigint not null default 0,
  deleted    boolean not null default false,
  server_ts  timestamptz not null default clock_timestamp()
);

-- Media: photos, ID photos and voice notes. The file itself lives in the "journal" storage bucket.
create table if not exists public.media (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_id   text not null,
  data       jsonb not null,
  path       text,
  updated    bigint not null default 0,
  deleted    boolean not null default false,
  server_ts  timestamptz not null default clock_timestamp()
);

create index if not exists entries_user_ts on public.entries (user_id, server_ts);
create index if not exists media_user_ts on public.media (user_id, server_ts);

-- Server timestamp on every write: phones pull "everything changed since my last sync" by this.
create or replace function public.touch_server_ts() returns trigger language plpgsql as $$
begin new.server_ts := clock_timestamp(); return new; end $$;
drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before insert or update on public.entries for each row execute function public.touch_server_ts();
drop trigger if exists media_touch on public.media;
create trigger media_touch before insert or update on public.media for each row execute function public.touch_server_ts();

-- Only the signed-in owner can see or change their rows.
alter table public.entries enable row level security;
alter table public.media enable row level security;
drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own media" on public.media;
create policy "own media" on public.media for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private storage bucket; each user can only touch files in their own folder (<user id>/...).
insert into storage.buckets (id, name, public) values ('journal', 'journal', false)
  on conflict (id) do nothing;
drop policy if exists "journal own read" on storage.objects;
create policy "journal own read" on storage.objects for select to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "journal own insert" on storage.objects;
create policy "journal own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "journal own update" on storage.objects;
create policy "journal own update" on storage.objects for update to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "journal own delete" on storage.objects;
create policy "journal own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
