const { SlashCommandBuilder } = require("discord.js");

const { createBaseEmbed } = require("../utils/embeds");
const helpSections = require("../utils/helpData");
const { createInteractionMessage } = require("../utils/interactionMessage");

async function runHelp({ message, prefix }) {
  const embed = createBaseEmbed()
    .setTitle("Music bot help")
    .setDescription(`Slash commands and prefix commands both work here. Current prefix: **${prefix}**`)
    .addFields(
      ...helpSections.map((section) => ({
        name: section.title,
        value: section.commands.map((command) => command.replaceAll("`,", `\`${prefix}`)).join("\n")
      }))
    )
    .setFooter({ text: "Tip: quote playlist names with spaces when using prefix commands." });

  await message.reply({ embeds: [embed] });
}

module.exports = {
  name: "help",
  aliases: ["commands"],
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available slash and prefix commands."),
  async executePrefix({ message, prefix }) {
    return runHelp({ message, prefix });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const prefix = await client.guildSettings.getPrefix(interaction.guildId).catch(() => client.config.defaultPrefix);
    return runHelp({ message, prefix });
  }
};
