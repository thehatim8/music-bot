const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runSkip({ client, message }) {
  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  await client.playerManager.skip(message.guild.id);
  await message.reply({ embeds: [createSuccessEmbed("Skipped the current track.", "Track skipped")] });
}

module.exports = {
  name: "skip",
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track."),
  async executePrefix({ client, message }) {
    return runSkip({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runSkip({ client, message });
  }
};
