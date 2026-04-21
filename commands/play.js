const { SlashCommandBuilder } = require("discord.js");

const { createErrorEmbed, createInfoEmbed, createNowPlayingPayload, createSuccessEmbed, createTrackEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");

async function runPlay({ client, message, args }) {
  if (!args.length) {
    throw new Error("Usage: `,play <query or url>`");
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel) {
    return;
  }

  const existingState = client.playerManager.getState(message.guild.id);
  if (existingState && !(await ensureSameVoiceChannel(message, existingState))) {
    return;
  }

  const statusMessage = await message.reply({
    embeds: [createInfoEmbed("Working...")]
  });

  try {
    const result = await client.music.resolveInput(args.join(" "), message.member);
    const state = await client.playerManager.createOrGetState({
      guildId: message.guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: message.channel.id,
      shardId: message.guild.shardId
    });

    const shouldStartImmediately = !state.current && state.queue.length === 0 && !state.player.track;

    if (result.type === "track" && shouldStartImmediately) {
      state.suppressNextStartMessage = true;
    }

    client.playerManager.enqueueTracks(message.guild.id, result.tracks);
    await client.playerManager.playIfIdle(message.guild.id);

    if (result.type === "track" && shouldStartImmediately && state.current) {
      await statusMessage.edit(createNowPlayingPayload(state.current, state));
      return;
    }

    const embed =
      result.type === "playlist"
        ? createSuccessEmbed(
            `Queued **${result.tracks.length}** tracks from **${result.title}**.${result.skipped ? ` Skipped ${result.skipped} unresolved tracks.` : ""}`,
            "Playlist queued"
          )
        : createTrackEmbed(result.tracks[0], "Track queued", `Queue size: ${state.queue.length + (state.current ? 1 : 0)} track(s)`);

    await statusMessage.edit({ embeds: [embed] });
  } catch (error) {
    await statusMessage.edit({
      embeds: [createErrorEmbed(error.message || "Failed to resolve that input.")]
    });
  }
}

module.exports = {
  name: "play",
  aliases: ["p"],
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or playlist from YouTube, Spotify, or a direct URL.")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Song name, YouTube URL, Spotify track, or Spotify playlist URL")
        .setRequired(true)
    ),
  async executePrefix({ client, message, args }) {
    return runPlay({ client, message, args });
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const args = [interaction.options.getString("query", true)];
    return runPlay({ client, message, args });
  }
};
