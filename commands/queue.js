const { SlashCommandBuilder } = require("discord.js");

const { createBaseEmbed, createErrorEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { MAX_QUEUE_PREVIEW } = require("../utils/constants");
const { formatDuration, formatTrackLine } = require("../utils/formatters");

async function runQueue({ client, message }) {
  const state = client.playerManager.getState(message.guild.id);

  if (!state || (!state.current && state.queue.length === 0)) {
    await message.reply({
      embeds: [createErrorEmbed("The queue is empty right now.")]
    });
    return;
  }

  const upcoming = state.queue.slice(0, MAX_QUEUE_PREVIEW).map((track, index) => formatTrackLine(track, index + 1));
  const remaining = state.queue.length - upcoming.length;
  const totalDuration = [state.current, ...state.queue]
    .filter(Boolean)
    .reduce((sum, track) => sum + (track.info.isStream ? 0 : track.info.length), 0);

  const embed = createBaseEmbed()
    .setTitle("Music queue")
    .addFields(
      {
        name: "Now playing",
        value: state.current
          ? formatTrackLine(state.current, 0).replace("`00.`", "`NP`")
          : "Playback is starting. Use this queue preview to see what is lined up."
      },
      {
        name: "Up next",
        value: upcoming.length ? upcoming.join("\n") : "No upcoming tracks queued."
      },
      {
        name: "Queue stats",
        value: `Tracks: **${state.queue.length + (state.current ? 1 : 0)}**\nDuration: **${formatDuration(totalDuration)}**\nLoop: **${state.loopMode}**`,
        inline: true
      }
    );

  if (remaining > 0) {
    embed.setFooter({ text: `${remaining} more track(s) not shown` });
  }

  await message.reply({ embeds: [embed] });
}

module.exports = {
  name: "queue",
  aliases: ["q"],
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current queue."),
  async executePrefix({ client, message }) {
    return runQueue({ client, message });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    return runQueue({ client, message });
  }
};
