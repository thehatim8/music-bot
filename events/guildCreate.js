const { registerSlashCommands } = require("../handlers/slashCommandRegistrar");

module.exports = {
  name: "guildCreate",
  async execute(client, guild) {
    await registerSlashCommands(guild, client).catch((error) => {
      console.error(`Failed to register slash commands for guild ${guild.id}:`, error);
    });
  }
};
