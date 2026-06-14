const SpotifyService = require("./SpotifyService");
const AutoplayService = require("./AutoplayService");
const { SPOTIFY_RESOLVE_CONCURRENCY } = require("../utils/constants");
const { mapWithConcurrency } = require("../utils/async");

class MusicService {
  constructor(client) {
    this.client = client;
    this.spotify = new SpotifyService(client.config);
    this.autoplay = new AutoplayService(this);
  }

  isUrl(input) {
    try {
      new URL(input);
      return true;
    } catch {
      return false;
    }
  }

  createQueueTrack(rawTrack, requester, sourceLabel, canonical = null) {
    const artworkUrl = rawTrack.info.artworkUrl || rawTrack.pluginInfo?.artworkUrl || null;
    const track = {
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

    const canonicalTitle = String(canonical?.title || "").trim();
    const canonicalArtists = Array.isArray(canonical?.artists)
      ? canonical.artists
          .map((artist) => String(artist || "").trim())
          .filter(Boolean)
      : [];

    if (canonicalTitle || canonicalArtists.length > 0) {
      track.canonical = {
        title: canonicalTitle || track.info.title || "",
        artists: canonicalArtists
      };
    }

    return track;
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

    if (!this.isUrl(query)) {
      return this.resolveTextQuery(query, requester);
    }

    return this.resolveLavalink(query, requester, { allowPlaylists, sourceLabel: options.sourceLabel });
  }

  // Free-text searches (e.g. `/play random stuff`) must only ever produce real
  // songs. We identify the song on Spotify first, then use YouTube purely as the
  // audio source. If Spotify has no match we fall back to YouTube Music's
  // songs-only catalog — never raw YouTube video search, which returns any video.
  async resolveTextQuery(query, requester) {
    const spotifyMatch = await this.spotify.searchTrack(query).catch((error) => {
      console.warn(`Spotify search failed: ${error.message}`);
      return null;
    });

    if (spotifyMatch) {
      const resolved = await this.resolveCanonicalSpotifyTrack(spotifyMatch, requester).catch((error) => {
        console.warn(`Failed to resolve audio for Spotify match "${spotifyMatch.name}": ${error.message}`);
        return null;
      });

      if (resolved) {
        return resolved;
      }
    }

    const ytmusicTrack = await this.autoplay.resolveYouTubeMusicSearch(query, requester).catch((error) => {
      console.warn(`YouTube Music search resolver failed: ${error.message}`);
      return null;
    });

    if (ytmusicTrack) {
      return {
        type: "track",
        source: "ytmusic",
        title: ytmusicTrack.info.title,
        tracks: [ytmusicTrack]
      };
    }

    // Last resort: search Lavalink directly. We still keep this honest by picking
    // the first result that passes the song sanity checks (real song length, not a
    // live/lyric/mix upload) so we never queue a random hour-long video, but unlike
    // the autoplay path we don't require a seed artist — this is a direct search.
    const lavalinkTrack = await this.resolveDirectSearch(query, requester).catch((error) => {
      console.warn(`Direct Lavalink search failed: ${error.message}`);
      return null;
    });

    if (lavalinkTrack) {
      return lavalinkTrack;
    }

    throw new Error(`I couldn't find a song matching "${query}". Try a more specific song or artist name.`);
  }

  // Direct Lavalink fallback for free-text searches. Filters the raw search results
  // down to playable songs (using the same sanity checks as autoplay) and returns the
  // top match, falling back to the first encoded track if none pass the filter.
  async resolveDirectSearch(query, requester) {
    const node = this.client.playerManager.getSearchNode();
    const result = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
    const tracks = this.getLavalinkTracks(result).filter((track) => track?.encoded);

    if (tracks.length === 0) {
      return null;
    }

    // Raw YouTube search returns a video for any text, so only accept a result that
    // is a real song AND whose title/artist actually matches the words searched for.
    // Without this, nonsense queries quietly play an unrelated song.
    const chosen = tracks.find(
      (track) =>
        this.autoplay.isPlayableMusicTrack(track) &&
        !this.autoplay.isBlockedTitle(track.info?.title) &&
        this.autoplay.isQueryRelevant(query, track.info?.title, track.info?.author)
    );

    if (!chosen) {
      return null;
    }

    return {
      type: "track",
      source: "youtube",
      title: chosen.info.title,
      tracks: [this.createQueueTrack(chosen, requester, "YouTube")]
    };
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

  getTrackKeys(track) {
    const info = track?.info || {};
    return [info.identifier, info.uri, `${info.author || ""}:${info.title || ""}`]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
  }

  getLavalinkTracks(result) {
    if (!result || result.loadType === "empty" || result.loadType === "error") {
      return [];
    }

    if (Array.isArray(result.data)) {
      return result.data;
    }

    if (Array.isArray(result.data?.tracks)) {
      return result.data.tracks;
    }

    return result.data ? [result.data] : [];
  }

  async resolveAutoplayTrack(referenceTrack, requester, excludedTracks = []) {
    return this.autoplay.resolve(referenceTrack, requester, excludedTracks);
  }

  async resolveSpotifyTrack(url, requester) {
    const track = await this.spotify.getTrack(url);
    return this.resolveCanonicalSpotifyTrack(track, requester);
  }

  // Given an identified Spotify track, find its playable audio on YouTube and
  // tag it with the canonical Spotify title/artists. Shared by direct Spotify
  // URLs and by text searches resolved through Spotify.
  async resolveCanonicalSpotifyTrack(track, requester) {
    const resolved = await this.resolveLavalink(track.searchQuery, requester, { allowPlaylists: false, sourceLabel: "Spotify" });
    const firstTrack = resolved.tracks[0];

    if (!firstTrack) {
      throw new Error(`No playable YouTube result was found for "${track.name}".`);
    }

    if (track.artworkUrl && !firstTrack.info.artworkUrl) {
      firstTrack.info.artworkUrl = track.artworkUrl;
    }

    firstTrack.canonical = {
      title: track.name,
      artists: track.artists.map((artist) => artist.name)
    };

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

          if (firstTrack) {
            firstTrack.canonical = {
              title: track.name,
              artists: track.artists.map((artist) => artist.name)
            };
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
