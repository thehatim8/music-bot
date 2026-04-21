const { createErrorEmbed } = require("../utils/embeds");
const { parseArgs } = require("../utils/formatters");

module.exports = {
  name: "messageCreate",
  async execute(client, message) {
    if (!message.guild || message.author.bot) {
      return;
    }

    let prefix;

    try {
      prefix = await client.guildSettings.getPrefix(message.guild.id);
    } catch (error) {
      console.error("Failed to resolve guild prefix:", error);
      prefix = client.config.defaultPrefix;
    }

    if (!message.content.startsWith(prefix)) {
      return;
    }

    const content = message.content.slice(prefix.length).trim();

    if (!content.length) {
      return;
    }

    const args = parseArgs(content);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) {
      return;
    }

    const resolvedName = client.commandAliases.get(commandName) || commandName;
    const command = client.prefixCommands.get(resolvedName);

    if (!command) {
      return;
    }

    try {
      await command.executePrefix({
        client,
        message,
        args,
        prefix
      });
    } catch (error) {
      console.error(`Prefix command failed (${resolvedName}):`, error);
      await message.reply({
        embeds: [createErrorEmbed(error.message || "That command failed unexpectedly.")]
      }).catch(() => null);
    }
  }
};

