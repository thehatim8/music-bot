const dotenv = require("dotenv");
const { DEFAULT_PREFIX } = require("./constants");

dotenv.config();

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("LAVALINK_PORT must be a valid positive integer.");
  }

  return port;
}

module.exports = {
  discord: {
    token: requireEnv("DISCORD_TOKEN"),
    clientId: requireEnv("CLIENT_ID")
  },
  supabase: {
    url: requireEnv("SUPABASE_URL"),
    key: requireEnv("SUPABASE_KEY")
  },
  lavalink: {
    host: requireEnv("LAVALINK_HOST"),
    port: parsePort(requireEnv("LAVALINK_PORT")),
    password: requireEnv("LAVALINK_PASSWORD")
  },
  spotify: {
    clientId: requireEnv("SPOTIFY_CLIENT_ID"),
    clientSecret: requireEnv("SPOTIFY_CLIENT_SECRET"),
    market: process.env.SPOTIFY_MARKET?.trim() || "PK"
  },
  search: {
    // Lavalink search prefixes, tried in order. A song that fails to resolve or to
    // play on one provider is retried on the next.
    // "ytdlp" is YouTube played through yt-dlp (services/ytmusic_autoplay.py) instead of
    // Lavalink's YouTube plugin.
    providers: (process.env.SEARCH_PROVIDERS || "ytdlp,ytmsearch,ytsearch,scsearch")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  },
  ytmusicAutoplay: {
    url: process.env.YTMUSIC_AUTOPLAY_URL?.trim() || "http://127.0.0.1:3001"
  },
  ytdlp: {
    // Address Lavalink uses to fetch audio from the Python service. Only differs from
    // YTMUSIC_AUTOPLAY_URL when Lavalink runs on another machine.
    streamUrl: process.env.YTDLP_STREAM_URL?.trim() || process.env.YTMUSIC_AUTOPLAY_URL?.trim() || "http://127.0.0.1:3001"
  },
  defaultPrefix: process.env.DEFAULT_PREFIX?.trim() || DEFAULT_PREFIX
};
