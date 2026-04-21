const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");
const { formatDuration } = require("../utils/formatters");

async function runSeek({ client, message, args }) {
  const seconds = Number(args[0]);

  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("Usage: `,seek <seconds>`");
  }

  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  const positionMs = Math.floor(seconds * 1000);

  if (!state.current.info.isStream && positionMs > state.current.info.length) {
    throw new Error(`That seek target is beyond the track length (${formatDuration(state.current.info.length)}).`);
  }

  await client.playerManager.seek(message.guild.id, positionMs);
  await message.reply({
    embeds: [createSuccessEmbed(`Jumped to **${formatDuration(positionMs)}** in the current track.`, "Seek complete")]
  });
}

module.exports = {
  name: "seek",
  data: new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Seek to a position in the current track.")
    .addNumberOption((option) =>
      option
        .setName("seconds")
        .setDescription("Target position in seconds")
        .setRequired(true)
        .setMinValue(0)
    ),
  async executePrefix({ client, message, args }) {
    return runSeek({ client, message, args });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const args = [interaction.options.getNumber("seconds", true)];
    return runSeek({ client, message, args });
  }
};
