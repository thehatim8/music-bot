const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");

const { MAX_PREFIX_LENGTH } = require("../utils/constants");
const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");

async function runSetPrefix({ client, message, prefix }) {
  if (!prefix.length || prefix.length > MAX_PREFIX_LENGTH) {
    throw new Error(`Prefix must be between 1 and ${MAX_PREFIX_LENGTH} characters long.`);
  }

  await client.guildSettings.setPrefix(message.guild.id, prefix);
  await message.reply({
    embeds: [createSuccessEmbed(`This server prefix is now **${prefix}**.`, "Prefix updated")]
  });
}

module.exports = {
  name: "setprefix",
  data: new SlashCommandBuilder()
    .setName("setprefix")
    .setDescription("Update the prefix used for text commands in this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName("prefix")
        .setDescription("New prefix to use, for example ! or ?")
        .setRequired(true)
        .setMaxLength(MAX_PREFIX_LENGTH)
    ),
  async executePrefix({ client, message, args }) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error("You need the Manage Server permission to change the prefix.");
    }

    const prefix = (args[0] || "").trim();

    if (!prefix) {
      throw new Error("Usage: `,setprefix <prefix>`");
    }

    return runSetPrefix({ client, message, prefix });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const prefix = interaction.options.getString("prefix", true).trim();
    return runSetPrefix({ client, message, prefix });
  }
};
