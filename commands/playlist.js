const { SlashCommandBuilder } = require("discord.js");

const { createBaseEmbed, createErrorEmbed, createInfoEmbed, createSuccessEmbed } = require("../utils/embeds");
const { createInteractionMessage } = require("../utils/interactionMessage");
const { ensureMemberInVoice, ensureSameVoiceChannel } = require("../utils/validators");
const { escapeMarkdown, formatDuration, formatTrackLine, truncate } = require("../utils/formatters");
const { mapWithConcurrency } = require("../utils/async");
const { SPOTIFY_RESOLVE_BATCH_SIZE, SPOTIFY_RESOLVE_CONCURRENCY } = require("../utils/constants");

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
        .addUserOption((option) =>
          option
            .setName("owner")
            .setDescription("Whose playlist to play (defaults to yours)")
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List your playlists.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("import")
        .setDescription("Save a Spotify playlist as one of your playlists.")
        .addStringOption((option) =>
          option
            .setName("link")
            .setDescription("Spotify playlist link")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Name for the saved playlist (defaults to the Spotify name)")
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("server")
        .setDescription("List every playlist saved by members of this server.")
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
        .addUserOption((option) =>
          option
            .setName("owner")
            .setDescription("Whose playlist to show (defaults to yours)")
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
      case "server":
      case "all":
        return handleServer(client, message);
      case "import":
        return handleImport(client, message, args);
      case "info":
        return handleInfo(client, message, args);
      default:
        throw new Error(
          "Usage: `,playlist <create|delete|add|remove|play|import|list|server|info> ...`\nTip: quote playlist names with spaces, for example `,playlist create \"Road Trip\"`."
        );
    }
  },
  async executeSlash({ client, interaction }) {
    const message = createInteractionMessage(interaction);
    const subcommand = interaction.options.getSubcommand();
    const args = [subcommand];

    if (subcommand === "list" || subcommand === "server") {
      return this.executePrefix({ client, message, args });
    }

    // import takes the link first and the optional name after it.
    if (subcommand === "import") {
      args.push(interaction.options.getString("link", true));
      const importName = interaction.options.getString("name");
      if (importName) {
        args.push(importName);
      }
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

    // Passed as a trailing mention so slash and prefix commands share extractOwner().
    const owner = interaction.options.getUser("owner");
    if (owner) {
      args.push(`<@${owner.id}>`);
    }

    return this.executePrefix({ client, message, args });
  }
};

const MEMBER_FETCH_CHUNK_SIZE = 100;
const EMBED_DESCRIPTION_LIMIT = 4096;

// `,playlist play "Road Trip" @user` plays another member's playlist; without a trailing
// mention the caller's own playlist is used.
function extractOwner(args, message) {
  const match = /^<@!?(\d+)>$/.exec(args[args.length - 1] || "");

  if (!match) {
    return message.author.id;
  }

  args.pop();
  return match[1];
}

function playlistNotFoundError(ownerId, name, message) {
  return new Error(
    ownerId === message.author.id
      ? `Playlist "${name}" was not found.`
      : `<@${ownerId}> has no playlist named "${name}".`
  );
}

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
  const ownerId = extractOwner(args, message);
  const name = args.join(" ").trim();

  if (!name) {
    throw new Error("Usage: `,playlist play <name> [@owner]`");
  }

  const voiceChannel = await ensureMemberInVoice(message);
  if (!voiceChannel) {
    return;
  }

  const playlist = await client.playlists.getPlaylist(ownerId, name);

  if (!playlist) {
    throw playlistNotFoundError(ownerId, name, message);
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

  const guildId = message.guild.id;
  const total = playlist.songs.length;
  let state = null;
  let queued = 0;

  try {
    // Songs are looked up in batches and each batch is queued as soon as it's ready, so
    // a long playlist (e.g. an imported one) starts playing after the first batch.
    for (let start = 0; start < total; start += SPOTIFY_RESOLVE_BATCH_SIZE) {
      const batch = playlist.songs.slice(start, start + SPOTIFY_RESOLVE_BATCH_SIZE);
      const tracks = (
        await mapWithConcurrency(batch, SPOTIFY_RESOLVE_CONCURRENCY, (song) =>
          client.music.resolveStoredTrack(song, message.member).catch(() => null)
        )
      ).filter(Boolean);

      if (!tracks.length) {
        continue;
      }

      if (state && client.playerManager.getState(guildId) !== state) {
        await status.edit({
          embeds: [createInfoEmbed(`Playback was stopped, so I stopped loading **${playlist.name}** after ${queued} track(s).`, "Playlist loading stopped")]
        });
        return;
      }

      if (!state) {
        state = await client.playerManager.createOrGetState({
          guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: message.channel.id,
          shardId: message.guild.shardId
        });
      }

      client.playerManager.enqueueTracks(guildId, tracks);
      await client.playerManager.playIfIdle(guildId);

      const remaining = total - (start + batch.length);
      if (queued === 0 && remaining > 0) {
        await status.edit({
          embeds: [createInfoEmbed(`Started playing **${playlist.name}**. Queuing the remaining ${remaining} track(s) in the background.`, "Loading playlist")]
        }).catch(() => null);
      }

      queued += tracks.length;
    }

    if (!queued) {
      throw new Error(`I could not resolve any saved songs from "${playlist.name}".`);
    }

    await status.edit({
      embeds: [
        createSuccessEmbed(
          `Queued **${queued}** track(s) from **${playlist.name}**.${queued !== total ? ` ${total - queued} saved song(s) could not be resolved.` : ""}`,
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

async function handleImport(client, message, args) {
  const link = args.shift();
  const customName = args.join(" ").trim();

  if (!link || client.music.spotify.parseSpotifyUrl(link)?.type !== "playlist") {
    throw new Error("Usage: `,playlist import <spotify playlist link> [name]`");
  }

  const status = await message.reply({
    embeds: [createInfoEmbed("Reading the playlist from Spotify...", "Importing playlist")]
  });

  let name = customName;

  try {
    const spotifyPlaylist = await client.music.spotify.getPlaylist(link);

    if (!spotifyPlaylist.tracks.length) {
      throw new Error(client.music.describeEmptyPlaylist(spotifyPlaylist));
    }

    name = (customName || spotifyPlaylist.name).trim();
    const songs = spotifyPlaylist.tracks.map((track) => client.music.spotifyTrackToStoredSong(track));
    await client.playlists.importPlaylist(message.author.id, name, songs);

    const quotedName = name.includes(" ") ? `"${name}"` : name;
    await status.edit({
      embeds: [
        createSuccessEmbed(
          `Saved **${songs.length}** song(s) from Spotify as **${name}**. Play it with \`,playlist play ${quotedName}\`.` +
            (spotifyPlaylist.limited
              ? "\nSpotify only shares the first 100 songs of a playlist with bots, so songs after that weren't imported."
              : ""),
          "Playlist imported"
        )
      ]
    });
  } catch (error) {
    const alreadyExists = /already have a playlist named/.test(error.message || "");
    await status.edit({
      embeds: [
        createErrorEmbed(
          alreadyExists
            ? `You already have a playlist named **${name}**. Give the import another name: \`,playlist import <link> "New name"\`.`
            : error.message || "Failed to import that playlist."
        )
      ]
    });
  }
}

async function handleServer(client, message) {
  const playlists = await client.playlists.listAllPlaylists();
  const ownerIds = [...new Set(playlists.map((playlist) => playlist.userId))];
  const memberIds = await fetchMemberIds(message.guild, ownerIds);
  const serverPlaylists = playlists.filter((playlist) => memberIds.has(playlist.userId));

  if (!serverPlaylists.length) {
    await message.reply({
      embeds: [
        createSuccessEmbed(
          "No one in this server has saved a playlist yet. Create one with `,playlist create <name>`.",
          "Server playlists"
        )
      ]
    });
    return;
  }

  const byOwner = new Map();
  for (const playlist of serverPlaylists) {
    if (!byOwner.has(playlist.userId)) {
      byOwner.set(playlist.userId, []);
    }
    byOwner.get(playlist.userId).push(playlist);
  }

  const lines = [];
  let length = 0;
  let number = 0;
  let shown = 0;

  outer: for (const [ownerId, ownerPlaylists] of byOwner) {
    // Mentions inside embeds render as names without pinging anyone.
    const header = `${lines.length ? "\n" : ""}<@${ownerId}>`;
    let headerAdded = false;

    for (const playlist of ownerPlaylists) {
      number += 1;
      const line = `\`${String(number).padStart(2, "0")}.\` **${escapeMarkdown(truncate(playlist.name, 45))}** - ${playlist.songCount} song(s)`;
      const needed = (headerAdded ? 0 : header.length + 1) + line.length + 1;

      if (length + needed > EMBED_DESCRIPTION_LIMIT) {
        break outer;
      }

      if (!headerAdded) {
        lines.push(header);
        length += header.length + 1;
        headerAdded = true;
      }

      lines.push(line);
      length += line.length + 1;
      shown += 1;
    }
  }

  const hidden = serverPlaylists.length - shown;
  const embed = createBaseEmbed()
    .setTitle(`Playlists in ${truncate(message.guild.name, 200)} (${serverPlaylists.length})`)
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `${hidden ? `${hidden} more not shown • ` : ""}Play one: /playlist play <name> owner:@user`
    });

  await message.reply({ embeds: [embed] });
}

// Fetching members by ID doesn't need the privileged GuildMembers intent. Discord takes
// at most 100 IDs per request.
async function fetchMemberIds(guild, userIds) {
  const memberIds = new Set();

  for (let i = 0; i < userIds.length; i += MEMBER_FETCH_CHUNK_SIZE) {
    const members = await guild.members.fetch({ user: userIds.slice(i, i + MEMBER_FETCH_CHUNK_SIZE) });
    for (const id of members.keys()) {
      memberIds.add(id);
    }
  }

  return memberIds;
}

async function handleInfo(client, message, args) {
  const ownerId = extractOwner(args, message);
  const name = args.join(" ").trim();

  if (!name) {
    throw new Error("Usage: `,playlist info <name> [@owner]`");
  }

  const playlist = await client.playlists.getPlaylist(ownerId, name);

  if (!playlist) {
    throw playlistNotFoundError(ownerId, name, message);
  }

  const ownerTag =
    ownerId === message.author.id
      ? message.author.tag
      : (await client.users.fetch(ownerId).catch(() => null))?.tag || "Unknown";

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
                tag: ownerTag
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
