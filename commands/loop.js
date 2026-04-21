const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runLoop({ client, message, args }) {
  const mode = (args[0] || "").toLowerCase();

  if (!["track", "queue", "off"].includes(mode)) {
    throw new Error("Usage: `,loop <track|queue|off>`");
  }

  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  client.playerManager.setLoopMode(message.guild.id, mode);
  await message.reply({ embeds: [createSuccessEmbed(`Loop mode set to **${mode}**.`, "Loop updated")] });
}

module.exports = {
  name: "loop",
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set the loop mode.")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "track", value: "track" },
          { name: "queue", value: "queue" },
          { name: "off", value: "off" }
        )
    ),
  async executePrefix({ client, message, args }) {
    return runLoop({ client, message, args });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const args = [interaction.options.getString("mode", true)];
    return runLoop({ client, message, args });
  }
};
