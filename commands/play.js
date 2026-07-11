const { SlashCommandBuilder } = require("discord.js");

const { createErrorEmbed, createInfoEmbed, createNowPlayingPayload, createShuffleButtonRow, createSuccessEmbed, createTrackEmbed } = require("../utils/embeds");
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

  const guildId = message.guild.id;
  let progressiveState = null;
  let announcedProgressiveLoad = false;

  try {
    const result = await client.music.resolveInput(args.join(" "), message.member, {
      // Spotify playlists resolve in ordered batches. Each batch is queued as soon
      // as it is playable so even very long playlists start playing right away.
      onTracks: async (tracks, progress) => {
        if (progressiveState && client.playerManager.getState(guildId) !== progressiveState) {
          throw new Error("Playback was stopped, so I cancelled loading the rest of the playlist.");
        }

        if (!progressiveState) {
          progressiveState = await client.playerManager.createOrGetState({
            guildId,
            voiceChannelId: voiceChannel.id,
            textChannelId: message.channel.id,
            shardId: message.guild.shardId
          });
        }

        client.playerManager.enqueueTracks(guildId, tracks);
        await client.playerManager.playIfIdle(guildId);

        if (!announcedProgressiveLoad && progress.remaining > 0) {
          announcedProgressiveLoad = true;
          await statusMessage.edit({
            embeds: [
              createInfoEmbed(
                `Started playing **${progress.title}** — queuing the remaining ${progress.remaining} track(s) in the background.`,
                "Playlist loading"
              )
            ]
          }).catch(() => null);
        }
      }
    });

    if (result.type === "playlist" && progressiveState) {
      await statusMessage.edit({
        embeds: [
          createSuccessEmbed(
            `Queued **${result.tracks.length}** tracks from **${result.title}** in order.${result.skipped ? ` Skipped ${result.skipped} unresolved tracks.` : ""}`,
            "Playlist queued"
          )
        ],
        components: [createShuffleButtonRow()]
      }).catch(() => null);
      return;
    }

    const state = await client.playerManager.createOrGetState({
      guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: message.channel.id,
      shardId: message.guild.shardId
    });

    const shouldStartImmediately = !state.current && state.queue.length === 0 && !state.player.track;

    if (result.type === "track" && shouldStartImmediately) {
      state.suppressNextStartMessage = true;
    }

    client.playerManager.enqueueTracks(guildId, result.tracks);
    await client.playerManager.playIfIdle(guildId);

    if (result.type === "track" && shouldStartImmediately && state.current) {
      await statusMessage.edit(createNowPlayingPayload(state.current, state));
      return;
    }

    if (result.type === "playlist") {
      await statusMessage.edit({
        embeds: [
          createSuccessEmbed(
            `Queued **${result.tracks.length}** tracks from **${result.title}**.${result.skipped ? ` Skipped ${result.skipped} unresolved tracks.` : ""}`,
            "Playlist queued"
          )
        ],
        components: [createShuffleButtonRow()]
      });
      return;
    }

    const embed = createTrackEmbed(result.tracks[0], "Track queued", `Queue size: ${state.queue.length + (state.current ? 1 : 0)} track(s)`);
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
