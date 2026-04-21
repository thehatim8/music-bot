const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runClear({ client, message }) {
  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  client.playerManager.clearQueue(message.guild.id);
  await message.reply({ embeds: [createSuccessEmbed("Cleared every upcoming track from the queue.", "Queue cleared")] });
}

module.exports = {
  name: "clear",
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear all upcoming tracks from the queue."),
  async executePrefix({ client, message }) {
    return runClear({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runClear({ client, message });
  }
};
