const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runResume({ client, message }) {
  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  await client.playerManager.resume(message.guild.id);
  await message.reply({ embeds: [createSuccessEmbed("Resumed the current track.", "Playback resumed")] });
}

module.exports = {
  name: "resume",
  data: new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume the current track."),
  async executePrefix({ client, message }) {
    return runResume({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runResume({ client, message });
  }
};
