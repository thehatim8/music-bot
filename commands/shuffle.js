const { SlashCommandBuilder } = require("discord.js");

const { createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureActivePlayer, ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runShuffle({ client, message }) {
  const state = await ensureActivePlayer(message, client);
  if (!state) {
    return;
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel || !(await ensureSameVoiceChannel(message, state))) {
    return;
  }

  if (state.queue.length < 2) {
    throw new Error("You need at least two queued tracks to shuffle.");
  }

  client.playerManager.shuffleQueue(message.guild.id);
  await message.reply({ embeds: [createSuccessEmbed("Shuffled the upcoming queue.", "Queue shuffled")] });
}

module.exports = {
  name: "shuffle",
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the upcoming queue."),
  async executePrefix({ client, message }) {
    return runShuffle({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runShuffle({ client, message });
  }
};
