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
    clientSecret: requireEnv("SPOTIFY_CLIENT_SECRET")
  },
  defaultPrefix: process.env.DEFAULT_PREFIX?.trim() || DEFAULT_PREFIX
};

