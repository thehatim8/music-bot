const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { COLORS } = require("./constants");
const { formatDuration, truncate } = require("./formatters");

function createBaseEmbed(color = COLORS.brand) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

function createErrorEmbed(description, title = "Something went wrong") {
  return createBaseEmbed(COLORS.error).setTitle(title).setDescription(description);
}

function createSuccessEmbed(description, title = "Success") {
  return createBaseEmbed(COLORS.success).setTitle(title).setDescription(description);
}

function createInfoEmbed(description, title = "Working on it") {
  return createBaseEmbed(COLORS.neutral).setTitle(title).setDescription(description);
}

function createTrackEmbed(track, title, footerText) {
  const embed = createBaseEmbed()
    .setTitle(title)
    .setDescription(`[${truncate(track.info.title, 100)}](${track.info.uri || "https://youtube.com"})`)
    .addFields(
      {
        name: "Duration",
        value: formatDuration(track.info.length),
        inline: true
      },
      {
        name: "Requester",
        value: track.requester?.mention || track.requester?.tag || "Unknown",
        inline: true
      },
      {
        name: "Source",
        value: track.sourceLabel || track.info.sourceName || "Unknown",
        inline: true
      }
    );

  if (track.info.artworkUrl) {
    embed.setThumbnail(track.info.artworkUrl);
  }

  if (footerText) {
    embed.setFooter({ text: footerText });
  }

  return embed;
}

function createPlayerControlsRow(state) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music:previous")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state?.current),
    new ButtonBuilder()
      .setCustomId("music:pause")
      .setLabel(state?.isPaused ? "Resume" : "Pause")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state?.current),
    new ButtonBuilder()
      .setCustomId("music:skip")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!state?.current),
    new ButtonBuilder()
      .setCustomId("music:stop")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!state?.current),
    new ButtonBuilder()
      .setCustomId("music:autoplay")
      .setLabel(state?.autoplayEnabled ? "Autoplay On" : "Autoplay")
      .setStyle(state?.autoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!state?.current)
  );
}

function createNowPlayingPayload(track, state) {
  const footer = `Loop: ${state.loopMode} | Autoplay: ${state.autoplayEnabled ? "On" : "Off"}`;

  return {
    embeds: [createTrackEmbed(track, "Now playing", footer)],
    components: [createPlayerControlsRow(state)]
  };
}

module.exports = {
  createBaseEmbed,
  createErrorEmbed,
  createInfoEmbed,
  createNowPlayingPayload,
  createPlayerControlsRow,
  createSuccessEmbed,
  createTrackEmbed
};
