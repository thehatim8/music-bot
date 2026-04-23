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

  cleanAutoplayTitle(title) {
    return String(title || "")
      .replace(/\[[^\]]*(official|lyrics?|video|audio|visualizer|hd|4k)[^\]]*\]/gi, " ")
      .replace(/\([^)]*(official|lyrics?|video|audio|visualizer|hd|4k)[^)]*\)/gi, " ")
      .replace(/\b(official\s*)?(music\s*)?(video|audio|lyrics?|visualizer)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  getTrackKeys(track) {
    const info = track?.info || {};
    return [info.identifier, info.uri, `${info.author || ""}:${info.title || ""}`]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
  }

  buildExcludedTrackKeys(tracks) {
    return new Set(tracks.flatMap((track) => this.getTrackKeys(track)));
  }

  isExcludedTrack(rawTrack, excludedKeys) {
    return this.getTrackKeys(rawTrack).some((key) => excludedKeys.has(key));
  }

  buildAutoplaySearchQueries(track) {
    const title = this.cleanAutoplayTitle(track?.info?.title);
    const author = this.cleanAutoplayTitle(track?.info?.author);
    const queries = [];

    if (author && title) {
      queries.push(`${author} ${title} similar songs`);
      queries.push(`${author} ${title} mix`);
      queries.push(`${author} songs`);
    }

    if (title) {
      queries.push(`${title} similar songs`);
      queries.push(`${title} mix`);
    }

    return [...new Set(queries.filter(Boolean))];
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
    const node = this.client.playerManager.getSearchNode();
    const blockedTitleTerms = ["lyrics", "lyric", "slowed", "reverb", "8d", "sped up", "cover", "remix", "mix"];
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const similarity = (leftValue, rightValue) => {
      const left = normalize(leftValue);
      const right = normalize(rightValue);

      if (!left || !right) {
        return 0;
      }

      if (left.includes(right) || right.includes(left)) {
        return 1;
      }

      const costs = Array.from({ length: right.length + 1 }, (_, index) => index);

      for (let i = 1; i <= left.length; i += 1) {
        let previous = costs[0];
        costs[0] = i;

        for (let j = 1; j <= right.length; j += 1) {
          const current = costs[j];
          costs[j] = left[i - 1] === right[j - 1] ? previous : Math.min(previous, costs[j], costs[j - 1]) + 1;
          previous = current;
        }
      }

      return 1 - costs[right.length] / Math.max(left.length, right.length);
    };
    const getIdentifiers = (track) =>
      [track?.info?.identifier, track?.raw?.info?.identifier, track?.encoded]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
    const recentTracks = [referenceTrack, ...excludedTracks.slice(-20)].filter(Boolean);
    const excludedIdentifiers = new Set(recentTracks.flatMap(getIdentifiers));
    const seedTitle = this.cleanAutoplayTitle(referenceTrack?.info?.title);
    const seedAuthor = this.cleanAutoplayTitle(referenceTrack?.info?.author);
    const seedTitleNormalized = normalize(seedTitle);
    const queries = [
      [seedTitle, seedAuthor, "official audio"].filter(Boolean).join(" "),
      seedAuthor
    ].filter(Boolean);
    const isValidCandidate = (track) => {
      const title = track?.info?.title || "";
      const normalizedTitle = normalize(title);

      if (!track?.encoded || getIdentifiers(track).some((identifier) => excludedIdentifiers.has(identifier))) {
        return false;
      }

      if (blockedTitleTerms.some((term) => normalizedTitle.includes(term))) {
        return false;
      }

      return similarity(seedTitleNormalized, normalizedTitle) <= 0.8;
    };

    for (const query of queries) {
      const result = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
      const candidates = this.getLavalinkTracks(result).slice(0, 10).filter(isValidCandidate);

      if (candidates.length > 0) {
        const selected = candidates[Math.floor(Math.random() * candidates.length)];
        return this.createQueueTrack(selected, requester, "Autoplay");
      }
    }

    throw new Error("I could not find a similar song for autoplay.");
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
