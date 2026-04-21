const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runStop({ client, message }) {
  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  await client.playerManager.stop(message.guild.id);
  await message.reply({ embeds: [createSuccessEmbed("Stopped playback, cleared the queue, and disconnected.", "Playback stopped")] });
}

module.exports = {
  name: "stop",
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playback, clear the queue, and disconnect."),
  async executePrefix({ client, message }) {
    return runStop({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runStop({ client, message });
  }
};
