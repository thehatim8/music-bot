const { SlashCommandBuilder } = require("discord.js");

const { createBaseEmbed, createErrorEmbed, createInfoEmbed, createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");
const { formatDuration, formatTrackLine, truncate } = require("../utils/formatters");
const { mapWithConcurrency } = require("../utils/async");
const { SPOTIFY_RESOLVE_CONCURRENCY } = require("../utils/constants");

module.exports = {
  name: "playlist",
  aliases: ["pl"],
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Manage your saved playlists.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a new playlist.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("delete")
        .setDescription("Delete one of your playlists.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a song to a playlist.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("song")
            .setDescription("Song query or URL")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a song from a playlist by its index.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
        )
        .addIntegerOption((option) =>
          option
            .setName("index")
            .setDescription("Song index from playlist info")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("play")
        .setDescription("Queue a saved playlist.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List your playlists.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("info")
        .setDescription("Show playlist info.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Playlist name")
            .setRequired(true)
        )
    ),
  async executePrefix({ client, message, args }) {
    const subcommand = (args.shift() || "").toLowerCase();

    switch (subcommand) {
      case "create":
        return handleCreate(client, message, args);
      case "delete":
        return handleDelete(client, message, args);
      case "add":
        return handleAdd(client, message, args);
      case "remove":
        return handleRemove(client, message, args);
      case "play":
        return handlePlay(client, message, args);
      case "list":
        return handleList(client, message);
      case "info":
        return handleInfo(client, message, args);
      default:
        throw new Error(
          "Usage: `,playlist <create|delete|add|remove|play|list|info> ...`\nTip: quote playlist names with spaces, for example `,playlist create \"Road Trip\"`."
        );
    }
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const subcommand = interaction.options.getSubcommand();
    const args = [subcommand];

    if (subcommand === "list") {
      return this.executePrefix({ client, message, args });
    }

    const name = interaction.options.getString("name");
    if (name) {
      args.push(name);
    }

    if (subcommand === "add") {
      args.push(interaction.options.getString("song", true));
    }

    if (subcommand === "remove") {
      args.push(String(interaction.options.getInteger("index", true)));
    }

    return this.executePrefix({ client, message, args });
  }
};

async function handleCreate(client, message, args) {
  const name = args.join(" ").trim();

  if (!name) {
    throw new Error("Usage: `,playlist create <name>`");
  }

  await client.playlists.createPlaylist(message.author.id, name, false);
  await message.reply({
    embeds: [createSuccessEmbed(`Created playlist **${name}**.`, "Playlist created")]
  });
}

async function handleDelete(client, message, args) {
  const name = args.join(" ").trim();

  if (!name) {
    throw new Error("Usage: `,playlist delete <name>`");
  }

  await client.playlists.deletePlaylist(message.author.id, name);
  await message.reply({
    embeds: [createSuccessEmbed(`Deleted playlist **${name}**.`, "Playlist deleted")]
  });
}

async function handleAdd(client, message, args) {
  const name = args.shift();
  const query = args.join(" ").trim();

  if (!name || !query) {
    throw new Error("Usage: `,playlist add <name> <song>`");
  }

  const status = await message.reply({
    embeds: [createInfoEmbed(`Resolving **${query}** before saving it to **${name}**...`, "Saving playlist track")]
  });

  try {
    const result = await client.music.resolveInput(query, message.member, { allowPlaylists: false });
    const track = result.tracks[0];

    await client.playlists.addSong(message.author.id, name, {
      title: track.info.title,
      url: track.info.uri,
      duration: track.info.length
    });

    await status.edit({
      embeds: [createSuccessEmbed(`Saved **${track.info.title}** to **${name}**.`, "Playlist updated")]
    });
  } catch (error) {
    await status.edit({
      embeds: [createErrorEmbed(error.message || "Failed to save that song to the playlist.")]
    });
  }
}

async function handleRemove(client, message, args) {
  const name = args.shift();
  const index = Number(args[0]);

  if (!name || !Number.isInteger(index) || index <= 0) {
    throw new Error("Usage: `,playlist remove <name> <index>`");
  }

  const removedSong = await client.playlists.removeSong(message.author.id, name, index);
  await message.reply({
    embeds: [createSuccessEmbed(`Removed **${removedSong.title}** from **${name}**.`, "Playlist updated")]
  });
}

async function handlePlay(client, message, args) {
  const name = args.join(" ").trim();

  if (!name) {
    throw new Error("Usage: `,playlist play <name>`");
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel) {
    return;
  }

  const playlist = await client.playlists.getPlaylist(message.author.id, name);

  if (!playlist) {
    throw new Error(`Playlist "${name}" was not found.`);
  }

  if (playlist.songs.length === 0) {
    throw new Error(`Playlist "${name}" does not have any songs yet.`);
  }

  const existingState = client.playerManager.getState(message.guild.id);
  if (existingState && !(await ensureSameVoiceChannel(message, existingState))) {
    return;
  }

  const status = await message.reply({
    embeds: [createInfoEmbed(`Resolving **${playlist.songs.length}** saved track(s) from **${playlist.name}**...`, "Loading playlist")]
  });

  try {
    const resolvedTracks = await mapWithConcurrency(
      playlist.songs,
      SPOTIFY_RESOLVE_CONCURRENCY,
      (song) => client.music.resolveStoredTrack(song, message.member).catch(() => null)
    );

    const tracks = resolvedTracks.filter(Boolean);

    if (!tracks.length) {
      throw new Error(`I could not resolve any saved songs from "${playlist.name}".`);
    }

    await client.playerManager.createOrGetState({
      guildId: message.guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: message.channel.id,
      shardId: message.guild.shardId
    });

    client.playerManager.enqueueTracks(message.guild.id, tracks);
    await client.playerManager.playIfIdle(message.guild.id);

    await status.edit({
      embeds: [
        createSuccessEmbed(
          `Queued **${tracks.length}** track(s) from **${playlist.name}**.${tracks.length !== playlist.songs.length ? ` ${playlist.songs.length - tracks.length} saved song(s) could not be resolved.` : ""}`,
          "Playlist queued"
        )
      ]
    });
  } catch (error) {
    await status.edit({
      embeds: [createErrorEmbed(error.message || "Failed to queue that playlist.")]
    });
  }
}

async function handleList(client, message) {
  const playlists = await client.playlists.listPlaylists(message.author.id);

  if (!playlists.length) {
    await message.reply({
      embeds: [createSuccessEmbed("You do not have any playlists yet. Create one with `,playlist create <name>`.", "Your playlists")]
    });
    return;
  }

  const embed = createBaseEmbed()
    .setTitle(`${message.author.username}'s playlists`)
    .setDescription(
      playlists
        .map((playlist, index) => `\`${index + 1}.\` **${truncate(playlist.name, 45)}** - ${playlist.songCount} song(s) - ${playlist.isPublic ? "Public" : "Private"}`)
        .join("\n")
    );

  await message.reply({ embeds: [embed] });
}

async function handleInfo(client, message, args) {
  const name = args.join(" ").trim();

  if (!name) {
    throw new Error("Usage: `,playlist info <name>`");
  }

  const playlist = await client.playlists.getPlaylist(message.author.id, name);

  if (!playlist) {
    throw new Error(`Playlist "${name}" was not found.`);
  }

  const totalDuration = playlist.songs.reduce((sum, song) => sum + song.duration, 0);
  const songPreview = playlist.songs.length
    ? playlist.songs
        .slice(0, 10)
        .map((song, index) =>
          formatTrackLine(
            {
              info: {
                title: song.title,
                uri: song.url,
                length: song.duration
              },
              requester: {
                tag: message.author.tag
              }
            },
            index + 1
          )
        )
        .join("\n")
    : "This playlist is currently empty.";

  const embed = createBaseEmbed()
    .setTitle(`Playlist: ${playlist.name}`)
    .setDescription(songPreview)
    .addFields(
      {
        name: "Songs",
        value: String(playlist.songs.length),
        inline: true
      },
      {
        name: "Duration",
        value: formatDuration(totalDuration),
        inline: true
      },
      {
        name: "Visibility",
        value: playlist.is_public ? "Public" : "Private",
        inline: true
      }
    );

  if (playlist.songs.length > 10) {
    embed.setFooter({ text: `${playlist.songs.length - 10} more song(s) not shown` });
  }

  await message.reply({ embeds: [embed] });
}
