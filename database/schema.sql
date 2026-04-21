create extension if not exists pgcrypto;

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists playlists_user_id_name_lower_idx
  on public.playlists (user_id, lower(name));

create table if not exists public.playlist_songs (
  id bigint generated always as identity primary key,
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  title text not null,
  url text not null,
  duration integer not null default 0,
  position integer not null
);

create unique index if not exists playlist_songs_playlist_position_idx
  on public.playlist_songs (playlist_id, position);

create index if not exists playlist_songs_playlist_id_idx
  on public.playlist_songs (playlist_id);

create table if not exists public.guild_settings (
  guild_id text primary key,
  prefix text not null default ',',
  updated_at timestamptz not null default now()
);

create or replace function public.set_guild_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_guild_settings_updated_at on public.guild_settings;

create trigger trg_guild_settings_updated_at
before update on public.guild_settings
for each row
execute function public.set_guild_settings_updated_at();

