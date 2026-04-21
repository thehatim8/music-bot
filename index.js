const path = require("node:path");
const { Client, Collection, GatewayIntentBits, Partials } = require("discord.js");

const { loadCommands } = require("./handlers/commandHandler");
const { loadEvents } = require("./handlers/eventHandler");
const PlaylistRepository = require("./database/PlaylistRepository");
const GuildSettingsRepository = require("./database/GuildSettingsRepository");
const PlayerManager = require("./music/PlayerManager");
const MusicService = require("./music/MusicService");
const config = require("./utils/config");
const { acquireProcessLock, releaseProcessLock } = require("./utils/processLock");

async function bootstrap() {
  const lockPath = path.join(__dirname, ".bot.lock");
  const lockAcquired = await acquireProcessLock(lockPath);

  if (!lockAcquired) {
    console.error("Another bot instance is already running. Stop the existing process before starting a new one.");
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  client.rootPath = __dirname;
  client.prefixCommands = new Collection();
  client.commandAliases = new Collection();
  client.slashCommands = new Collection();
  client.config = config;
  client.guildSettings = new GuildSettingsRepository(config);
  client.playlists = new PlaylistRepository(config);
  client.playerManager = new PlayerManager(client, config);
  client.music = new MusicService(client);
  client.paths = {
    commands: path.join(__dirname, "commands"),
    events: path.join(__dirname, "events")
  };

  await loadCommands(client);
  await loadEvents(client);

  client.login(config.discord.token).catch((error) => {
    console.error("Failed to log in to Discord:", error);
    void releaseProcessLock(lockPath);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received. Shutting down gracefully...`);

    try {
      await client.playerManager.destroyAll("Bot process is shutting down.");
    } catch (error) {
      console.error("Failed to destroy Lavalink players during shutdown:", error);
    }

    client.destroy();
    await releaseProcessLock(lockPath);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => {
    void releaseProcessLock(lockPath);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to bootstrap bot:", error);
  process.exit(1);
});
