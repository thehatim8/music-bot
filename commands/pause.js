const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runPause({ client, message }) {
  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  await client.playerManager.pause(message.guild.id);
  await message.reply({ embeds: [createSuccessEmbed("Paused the current track.", "Playback paused")] });
}

module.exports = {
  name: "pause",
  data: new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current track."),
  async executePrefix({ client, message }) {
    return runPause({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runPause({ client, message });
  }
};
