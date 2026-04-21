const { registerSlashCommands } = require("../handlers/slashCommandRegistrar");

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    console.log(`Logged in as ${client.user.tag}`);

    await client.application.commands.set([]);

    await Promise.allSettled(
      client.guilds.cache.map((guild) => registerSlashCommands(guild, client))
    );

    client.user.setActivity("music in voice channels", { type: 2 });
  }
};
