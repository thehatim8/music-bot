const { SlashCommandBuilder } = require("discord.js");

const { createBaseEmbed, createErrorEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { MAX_QUEUE_PREVIEW } = require("../utils/constants");
const { formatDuration, formatTrackLine } = require("../utils/formatters");

const EMBED_FIELD_VALUE_LIMIT = 1024;

function fitFieldValue(value) {
  if (value.length <= EMBED_FIELD_VALUE_LIMIT) {
    return value;
  }

  return `${value.slice(0, EMBED_FIELD_VALUE_LIMIT - 3)}...`;
}

function buildUpcomingPreview(queue) {
  const lines = [];

  for (let index = 0; index < queue.length && index < MAX_QUEUE_PREVIEW; index += 1) {
    const line = formatTrackLine(queue[index], index + 1);
    const nextValue = lines.length ? `${lines.join("\n")}\n${line}` : line;

    if (nextValue.length > EMBED_FIELD_VALUE_LIMIT) {
      break;
    }

    lines.push(line);
  }

  return lines;
}

async function runQueue({ client, message }) {
  const state = client.playerManager.getState(message.guild.id);

  if (!state || (!state.current && state.queue.length === 0)) {
    await message.reply({
      embeds: [createErrorEmbed("The queue is empty right now.")]
    });
    return;
  }

  const upcoming = buildUpcomingPreview(state.queue);
  const remaining = state.queue.length - upcoming.length;
  const totalDuration = [state.current, ...state.queue]
    .filter(Boolean)
    .reduce((sum, track) => sum + (track.info.isStream ? 0 : track.info.length), 0);

  const embed = createBaseEmbed()
    .setTitle("Music queue")
    .addFields(
      {
        name: "Now playing",
        value: fitFieldValue(
          state.current
            ? formatTrackLine(state.current, 0).replace("`00.`", "`NP`")
            : "Playback is starting. Use this queue preview to see what is lined up."
        )
      },
      {
        name: "Up next",
        value: upcoming.length
          ? upcoming.join("\n")
          : state.queue.length
            ? "Upcoming tracks are too long to preview safely."
            : "No upcoming tracks queued."
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
