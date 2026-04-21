const SpotifyService = require("./SpotifyService");
const { SPOTIFY_RESOLVE_CONCURRENCY } = require("../utils/constants");
const { mapWithConcurrency } = require("../utils/async");

class MusicService {
  constructor(client) {
    this.client = client;
    this.spotify = new SpotifyService(client.config);
  }

  isUrl(input) {
    try {
      new URL(input);
      return true;
    } catch {
      return false;
    }
  }

  createQueueTrack(rawTrack, requester, sourceLabel) {
    const artworkUrl = rawTrack.info.artworkUrl || rawTrack.pluginInfo?.artworkUrl || null;
    return {
      raw: rawTrack,
      encoded: rawTrack.encoded,
      info: {
        ...rawTrack.info,
        artworkUrl,
        uri: rawTrack.info.uri || (rawTrack.info.identifier ? `https://www.youtube.com/watch?v=${rawTrack.info.identifier}` : null)
      },
      requester: {
        id: requester.id,
        tag: requester.user?.tag || requester.tag,
        mention: `<@${requester.id}>`
      },
      sourceLabel
    };
  }

  async resolveInput(query, requester, options = {}) {
    const allowPlaylists = options.allowPlaylists !== false;
    const spotifyTarget = this.spotify.parseSpotifyUrl(query);

    if (spotifyTarget?.type === "track") {
      return this.resolveSpotifyTrack(query, requester);
    }

    if (spotifyTarget?.type === "playlist") {
      if (!allowPlaylists) {
        throw new Error("Only single tracks can be added here. Use a specific song instead of a playlist.");
      }

      return this.resolveSpotifyPlaylist(query, requester);
    }

    return this.resolveLavalink(query, requester, { allowPlaylists, sourceLabel: options.sourceLabel });
  }

  async resolveStoredTrack(song, requester) {
    try {
      const result = await this.resolveLavalink(song.url, requester, { allowPlaylists: false });
      return result.tracks[0];
    } catch {
      const result = await this.resolveLavalink(song.title, requester, { allowPlaylists: false });
      return result.tracks[0];
    }
  }

  async resolveSpotifyTrack(url, requester) {
    const track = await this.spotify.getTrack(url);
    const resolved = await this.resolveLavalink(track.searchQuery, requester, { allowPlaylists: false, sourceLabel: "Spotify" });
    const firstTrack = resolved.tracks[0];

    if (!firstTrack) {
      throw new Error(`No playable YouTube result was found for "${track.name}".`);
    }

    if (track.artworkUrl && !firstTrack.info.artworkUrl) {
      firstTrack.info.artworkUrl = track.artworkUrl;
    }

    return {
      type: "track",
      source: "spotify",
      tracks: [firstTrack],
      title: track.name
    };
  }

  async resolveSpotifyPlaylist(url, requester) {
    const playlist = await this.spotify.getPlaylist(url);
    const resolvedTracks = await mapWithConcurrency(
      playlist.tracks,
      SPOTIFY_RESOLVE_CONCURRENCY,
      async (track) => {
        try {
          const result = await this.resolveLavalink(track.searchQuery, requester, {
            allowPlaylists: false,
            sourceLabel: "Spotify"
          });

          const firstTrack = result.tracks[0];
          if (firstTrack && track.artworkUrl && !firstTrack.info.artworkUrl) {
            firstTrack.info.artworkUrl = track.artworkUrl;
          }

          return firstTrack || null;
        } catch {
          return null;
        }
      }
    );

    const tracks = resolvedTracks.filter(Boolean);

    if (tracks.length === 0) {
      throw new Error("I could not resolve any playable tracks from that Spotify playlist.");
    }

    return {
      type: "playlist",
      source: "spotify",
      tracks,
      title: playlist.name,
      skipped: playlist.tracks.length - tracks.length
    };
  }

  async resolveLavalink(query, requester, options = {}) {
    const node = this.client.playerManager.getSearchNode();
    const identifier = this.isUrl(query) ? query : `ytsearch:${query}`;
    const result = await node.rest.resolve(identifier);

    if (!result) {
      throw new Error("Lavalink did not return a search result.");
    }

    if (result.loadType === "empty") {
      throw new Error("No matches were found for that query.");
    }

    if (result.loadType === "error") {
      throw new Error(result.data?.message || "Lavalink could not load that track.");
    }

    if (result.loadType === "playlist") {
      if (options.allowPlaylists === false) {
        throw new Error("That input resolved to a playlist, but only a single track is allowed here.");
      }

      return {
        type: "playlist",
        source: "youtube",
        title: result.data.info.name,
        tracks: result.data.tracks.map((track) =>
          this.createQueueTrack(track, requester, options.sourceLabel || "YouTube")
        )
      };
    }

    const rawTrack = result.loadType === "track" ? result.data : result.data[0];

    if (!rawTrack) {
      throw new Error("No playable tracks were returned from Lavalink.");
    }

    return {
      type: "track",
      source: options.sourceLabel?.toLowerCase() || "youtube",
      title: rawTrack.info.title,
      tracks: [this.createQueueTrack(rawTrack, requester, options.sourceLabel || "YouTube")]
    };
  }
}

module.exports = MusicService;
