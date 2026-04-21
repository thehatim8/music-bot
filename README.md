# Discord Music Bot

A production-ready Discord music bot built with `discord.js v14`, `Shoukaku` + `Lavalink`, Spotify metadata resolution, and Supabase-backed playlists.

## Features

- Prefix music commands with default prefix `,`
- One slash command: `/setprefix`
- Guild-only message handling, DMs are ignored
- YouTube search, direct YouTube URLs, and full YouTube playlist queueing
- Spotify track and playlist URL support by resolving Spotify metadata into YouTube playback
- Supabase playlist storage with add, remove, list, info, and play commands
- Clean embed responses for playback, queue, and validation errors
- Idle cleanup and voice-channel cleanup for safer long-running operation

## Folder Structure

```text
.
|-- commands
|   |-- clear.js
|   |-- loop.js
|   |-- pause.js
|   |-- play.js
|   |-- playlist.js
|   |-- queue.js
|   |-- resume.js
|   |-- seek.js
|   |-- setprefix.js
|   |-- shuffle.js
|   |-- skip.js
|   `-- stop.js
|-- database
|   |-- GuildSettingsRepository.js
|   |-- PlaylistRepository.js
|   |-- schema.sql
|   `-- supabase.js
|-- events
|   |-- interactionCreate.js
|   |-- messageCreate.js
|   |-- ready.js
|   `-- voiceStateUpdate.js
|-- handlers
|   |-- commandHandler.js
|   `-- eventHandler.js
|-- music
|   |-- MusicService.js
|   |-- PlayerManager.js
|   `-- SpotifyService.js
|-- utils
|   |-- async.js
|   |-- config.js
|   |-- constants.js
|   |-- embeds.js
|   |-- formatters.js
|   `-- validators.js
|-- .env.example
|-- .gitignore
|-- index.js
`-- package.json
```

## Commands

Every music and playlist action now has both a slash command and a prefix command. Use `/help` or `,help` to see the full list in Discord.

### Playback

- `,play <query or url>`
- `,pause`
- `,resume`
- `,skip`
- `,stop`
- `,seek <seconds>`

### Queue

- `,queue`
- `,clear`
- `,shuffle`
- `,loop <track|queue|off>`

### Playlists

- `,playlist create <name>`
- `,playlist delete <name>`
- `,playlist add <name> <song>`
- `,playlist remove <name> <index>`
- `,playlist play <name>`
- `,playlist list`
- `,playlist info <name>`

Tip: quote playlist names with spaces, for example `,playlist create "Road Trip"` or `,playlist add "Road Trip" never gonna give you up`.

## Supabase Setup

1. Create a new Supabase project.
2. Open the SQL editor.
3. Run the SQL from [database/schema.sql](/d:/music-bot/database/schema.sql:1).
4. Copy your project URL and service role key into `.env`.

### SQL Schema

```sql
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

create table if not exists public.guild_settings (
  guild_id text primary key,
  prefix text not null default ',',
  updated_at timestamptz not null default now()
);
```

`guild_settings` is included so `/setprefix` persists across restarts.

## Lavalink Setup

You need a Lavalink v4 server with YouTube support enabled. The bot resolves Spotify links itself, but Lavalink still needs a YouTube-capable source plugin to play the final audio.

### Example `application.yml`

```yaml
server:
  port: 2333
  address: 0.0.0.0
  http2:
    enabled: false

plugins:
  youtube:
    enabled: true
    allowSearch: true
    allowDirectVideoIds: true
    allowDirectPlaylistIds: true
    clients:
      - MUSIC
      - ANDROID_VR
      - WEB
      - WEBEMBEDDED

lavalink:
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:1.16.0"
      snapshot: false

  server:
    password: "changeme123"
    sources:
      youtube: false
      bandcamp: true
      soundcloud: true
      twitch: false
      vimeo: false
      nico: false
      http: true
      local: false
    filters:
      volume: true
      equalizer: true
      karaoke: true
      timescale: true
      tremolo: true
      vibrato: true
      distortion: true
      rotation: true
      channelMix: true
      lowPass: true
```

After starting Lavalink, confirm it is listening on the same host, port, and password as your `.env` values.

### Important YouTube Notes

- Use the official client list above. If your current config contains `TVHTML5_SIMPLY`, replace it with `WEBEMBEDDED`.
- The file [lavalink/application.yml.example](/d:/music-bot/lavalink/application.yml.example:1) is the repo copy you can use as your base config.
- If playback still fails with errors like `This video requires login` or `Sign in to confirm you're not a bot`, the plugin's official guidance is to add either a `poToken` plus `visitorData`, or OAuth. Both are optional and both are workarounds rather than guaranteed fixes.
- OAuth can help, but the upstream plugin warns that it may still fail and should only be used with a burner Google account.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=
CLIENT_ID=
SUPABASE_URL=
SUPABASE_KEY=
LAVALINK_HOST=
LAVALINK_PORT=2333
LAVALINK_PASSWORD=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

## How To Run Locally

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. Fill in `.env`.
4. Start Lavalink.
5. Start the bot:

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

## Notes

- The bot ignores DMs completely.
- Slash commands are registered per guild on startup so they show up faster while testing.
- Spotify albums are not implemented because your requirements only asked for track and playlist URLs.
- Saved playlist entries store resolved playable URLs and durations so replaying them is fast and reliable.
- Now playing messages include built-in playback controls for previous, pause or resume, skip, and stop.
