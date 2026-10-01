const SpotifyService = require("./SpotifyService");
const AutoplayService = require("./AutoplayService");
const { SPOTIFY_RESOLVE_BATCH_SIZE, SPOTIFY_RESOLVE_CONCURRENCY } = require("../utils/constants");
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
        uri:
          rawTrack.info.uri ||
          (rawTrack.info.sourceName === "youtube" && rawTrack.info.identifier
            ? `https://www.youtube.com/watch?v=${rawTrack.info.identifier}`
            : null)
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
    // Every resolution path (Spotify, direct URL, free-text) ultimately searches and
    // loads its audio through Lavalink. Verify the audio backend is reachable up front
    // so a missing or disconnected Lavalink node surfaces a clear, actionable error
    // instead of being swallowed by the per-path catches and misreported to the user as
    // "I couldn't find a song matching ...".
    this.client.playerManager.getSearchNode();

    const allowPlaylists = options.allowPlaylists !== false;
    const spotifyTarget = this.spotify.parseSpotifyUrl(query);

    if (spotifyTarget?.type === "track") {
      return this.resolveSpotifyTrack(query, requester);
    }

    if (spotifyTarget?.type === "playlist") {
      if (!allowPlaylists) {
        throw new Error("Only single tracks can be added here. Use a specific song instead of a playlist.");
      }

      return this.resolveSpotifyPlaylist(query, requester, options);
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
    // Record why each source failed so that, when nothing resolves, we can tell the user
    // the real reason (bad Spotify credentials, a YouTube load error / bot-check on the
    // host, the autoplay service being down) instead of a misleading "no match".
    const failures = [];

    const spotifyMatch = await this.spotify.searchTrack(query).catch((error) => {
      console.warn(`Spotify search failed: ${error.message}`);
      failures.push(`Spotify search failed (${error.message})`);
      return null;
    });

    // Spotify's top hit for an obscure song can be an unrelated popular track. Only
    // trust it when it actually shares the searched words.
    const spotifyMatchRelevant =
      spotifyMatch &&
      this.autoplay.isQueryRelevant(query, spotifyMatch.name, spotifyMatch.artists.map((artist) => artist.name).join(" "));

    if (spotifyMatch && !spotifyMatchRelevant) {
      console.warn(`Ignoring Spotify match "${spotifyMatch.name}" for "${query}": not relevant to the query.`);
    }

    if (spotifyMatchRelevant) {
      const resolved = await this.resolveCanonicalSpotifyTrack(spotifyMatch, requester).catch((error) => {
        console.warn(`Failed to resolve audio for Spotify match "${spotifyMatch.name}": ${error.message}`);
        failures.push(`Matched "${spotifyMatch.name}" on Spotify but could not load its audio (${error.message})`);
        return null;
      });

      if (resolved) {
        return resolved;
      }
    }

    const soundcloudTrack = await this.resolveDirectSearch(query, requester).catch((error) => {
      console.warn(`Direct SoundCloud search failed: ${error.message}`);
      failures.push(`Direct SoundCloud search failed (${error.message})`);
      return null;
    });

    if (soundcloudTrack) {
      return soundcloudTrack;
    }

    // Last resort: search Lavalink directly. We still keep this honest by picking
    // the first result that passes the song sanity checks (real song length, not a
    // live/lyric/mix upload) so we never queue a random hour-long video, but unlike
    // the autoplay path we don't require a seed artist — this is a direct search.
    // Distinguish "every source errored out" (a credential/host/network problem) from a
    // genuine "no match", so the user gets an actionable message instead of being told to
    // pick a more specific song when the real issue is infrastructure.
    if (failures.length > 0) {
      throw new Error(`I couldn't play "${query}". Every source failed — ${failures.join("; ")}.`);
    }

    throw new Error(`I couldn't find a song matching "${query}". Try a more specific song or artist name.`);
  }

  // Direct Lavalink fallback for free-text searches. Filters the raw search results
  // down to playable songs (using the same sanity checks as autoplay) and returns the
  // top match, falling back to the first encoded track if none pass the filter.
  async resolveDirectSearch(query, requester) {
    const node = this.client.playerManager.getSearchNode();
    // Don't swallow load failures: a YouTube error (e.g. a "confirm you're not a bot"
    // block on the host) must surface to the caller rather than silently looking like
    // "no results". Lavalink reports these as loadType "error" in the response body.
    const result = await node.rest.resolve(`scsearch:${query}`);

    if (result?.loadType === "error") {
      throw new Error(result.data?.message || "SoundCloud search returned an error.");
    }

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
      // Results came back but every one was filtered out as a non-song or off-topic
      // match. Log it so an over-strict filter is visible in the host logs.
      console.warn(`Direct search for "${query}" returned ${tracks.length} result(s), but none passed the song/relevance filters.`);
      return null;
    }

    return {
      type: "track",
      source: "soundcloud",
      title: chosen.info.title,
      tracks: [this.createQueueTrack(chosen, requester, "SoundCloud")]
    };
  }

  async resolveStoredTrack(song, requester) {
    const url = String(song.url || "");
    const isYouTubeUrl = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url);

    try {
      const result = await this.resolveLavalink(isYouTubeUrl ? song.title : url, requester, { allowPlaylists: false });
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
    const firstTrack = await this.resolveSpotifyAudio(track, requester);

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

  // SoundCloud search always returns *something*, and its top hit is frequently an
  // unrelated upload. Never trust result #1: search artist + title (then title alone)
  // and only accept a result whose title really is this song, by this artist or with
  // the same length. If nothing matches, fail rather than play the wrong song.
  async resolveSpotifyAudio(spotifyTrack, requester) {
    const node = this.client.playerManager.getSearchNode();
    const searchTitle = this.stripTitleExtras(spotifyTrack.name) || spotifyTrack.name;
    const artistNames = spotifyTrack.artists.map((artist) => artist.name).filter(Boolean);
    const queries = [...new Set([`${artistNames.join(" ")} ${searchTitle}`.trim(), searchTitle])];
    let lastError = null;

    for (const query of queries) {
      const result = await node.rest.resolve(`scsearch:${query}`).catch((error) => {
        lastError = error;
        return null;
      });

      if (result?.loadType === "error") {
        lastError = new Error(result.data?.message || "SoundCloud search returned an error.");
        continue;
      }

      const best = this.getLavalinkTracks(result)
        .filter((candidate) => candidate?.encoded)
        .map((candidate) => ({ candidate, score: this.scoreSpotifyCandidate(candidate, spotifyTrack, searchTitle, artistNames) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)[0];

      if (best) {
        return this.createQueueTrack(best.candidate, requester, "Spotify");
      }
    }

    if (lastError) {
      throw lastError;
    }

    const byLine = artistNames.length > 0 ? ` by ${artistNames.join(", ")}` : "";
    throw new Error(`Couldn't find "${spotifyTrack.name}"${byLine} on SoundCloud.`);
  }

  // Returns 0 when the candidate is not this song, otherwise a positive score.
  scoreSpotifyCandidate(candidate, spotifyTrack, searchTitle, artistNames) {
    const autoplay = this.autoplay;
    const info = candidate.info || {};

    if (info.isStream) {
      return 0;
    }

    const haystack = autoplay.normalizeText(`${info.title || ""} ${info.author || ""}`);
    const compactHaystack = haystack.replace(/\s+/g, "");

    // Title: every meaningful word of the song title must appear.
    const titleTokens = [...autoplay.tokenizeTitle(searchTitle)];
    const normalizedTitle = autoplay.normalizeText(searchTitle);
    const titleMatches =
      titleTokens.length > 0
        ? titleTokens.every((token) => haystack.includes(token))
        : normalizedTitle.length > 0 && haystack.includes(normalizedTitle);

    if (!titleMatches) {
      return 0;
    }

    // Don't swap a studio song for a remix/cover/live take unless that is what Spotify has.
    const spotifyTitle = String(spotifyTrack.name || "").toLowerCase();
    const extraVariant = ["remix", "cover", "live", "slowed", "reverb", "sped up", "nightcore", "8d", "instrumental", "karaoke"].find(
      (word) => new RegExp(`\\b${word}\\b`, "i").test(info.title || "") && !spotifyTitle.includes(word)
    );

    if (extraVariant) {
      return 0;
    }

    // Duration: SoundCloud serves 30s previews for Go+ tracks and many re-uploads differ in
    // length. Reject anything clearly not the same recording.
    const expected = Number(spotifyTrack.duration);
    const actual = Number(info.length);
    let durationDiff = null;

    if (Number.isFinite(expected) && expected > 0 && Number.isFinite(actual) && actual > 0) {
      durationDiff = Math.abs(expected - actual);

      if (durationDiff > Math.max(15000, expected * 0.15)) {
        return 0;
      }
    }

    // Artist: uploader names are often mangled ("jj47official"), so compare without spaces.
    const artistMatches = artistNames.some((name) => {
      const compactArtist = autoplay.normalizeText(autoplay.cleanArtist(name)).replace(/\s+/g, "");
      return compactArtist.length > 0 && compactHaystack.includes(compactArtist);
    });

    // A same-titled song by someone else is only trusted if its length matches closely.
    if (!artistMatches && (durationDiff === null || durationDiff > 5000)) {
      return 0;
    }

    let score = 10;
    if (artistMatches) score += 10;
    if (durationDiff !== null) score += Math.max(0, 10 - durationDiff / 1000);
    return score;
  }

  // "Song (feat. X) - 2011 Remaster" -> "Song"
  stripTitleExtras(title) {
    return String(title || "")
      .replace(/\s*[([][^)\]]*\b(feat|ft|with|remaster(ed)?|version|edit|from)\b[^)\]]*[)\]]/gi, "")
      .replace(/\s+-\s+.*\b(remaster(ed)?|version|edit|mono|stereo|from)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // A playlist that Spotify serves but from which no track survives is almost always
  // a permissions/region problem, not an empty playlist. Distinguish the cases so the
  // user is told what to actually fix rather than to "wait and try again".
  describeEmptyPlaylist(playlist) {
    const stats = playlist.stats || {};
    const dropped = stats.dropped || {};
    const total = stats.total;

    console.warn(
      `Spotify playlist "${playlist.name}": 0 usable tracks. total=${total ?? "?"} itemsReturned=${stats.itemsSeen ?? "?"} ` +
        `dropped=${JSON.stringify(dropped)}`
    );

    if (dropped.nullTrack > 0) {
      return (
        `Spotify listed **${dropped.nullTrack}** track(s) in **${playlist.name}** but refused to send their details, ` +
        "which usually means the playlist is region-locked or the tracks are unavailable to the bot's Spotify app."
      );
    }

    if (dropped.local > 0 && dropped.local === stats.itemsSeen) {
      return `Every track in **${playlist.name}** is a local file, which Spotify does not stream to apps. Add songs from Spotify's catalogue instead.`;
    }

    if (total > 0 && stats.itemsSeen === 0) {
      return (
        `Spotify says **${playlist.name}** has ${total} track(s), but returned none of them to the bot. ` +
        "This normally means the playlist is set to private — open it in Spotify, choose \"Make public\", and try again."
      );
    }

    return (
      `Spotify returned **${playlist.name}** with no playable tracks. ` +
      "If the playlist is private, make it public; if the songs are local files, they cannot be streamed."
    );
  }

  // Playlists can be arbitrarily long, so tracks are resolved in ordered batches.
  // When the caller provides options.onTracks, each batch is handed over as soon as
  // it is playable (still in playlist order), letting playback start after the first
  // batch instead of after the whole playlist. An onTracks callback that throws
  // aborts the remaining resolution (e.g. the player was stopped mid-load).
  async resolveSpotifyPlaylist(url, requester, options = {}) {
    const playlist = await this.spotify.getPlaylist(url);
    const onTracks = typeof options.onTracks === "function" ? options.onTracks : null;
    const tracks = [];

    if (playlist.tracks.length === 0) {
      throw new Error(this.describeEmptyPlaylist(playlist));
    }

    // When nothing resolves, the per-track errors are the only clue to the real
    // cause (e.g. YouTube blocking the Lavalink host), so keep a tally of them.
    const failureCounts = new Map();

    for (let start = 0; start < playlist.tracks.length; start += SPOTIFY_RESOLVE_BATCH_SIZE) {
      const batch = playlist.tracks.slice(start, start + SPOTIFY_RESOLVE_BATCH_SIZE);
      const resolvedBatch = await mapWithConcurrency(
        batch,
        SPOTIFY_RESOLVE_CONCURRENCY,
        async (track) => {
          try {
            const firstTrack = await this.resolveSpotifyAudio(track, requester);

            if (track.artworkUrl && !firstTrack.info.artworkUrl) {
              firstTrack.info.artworkUrl = track.artworkUrl;
            }

            firstTrack.canonical = {
              title: track.name,
              artists: track.artists.map((artist) => artist.name)
            };

            return firstTrack;
          } catch (error) {
            const reason = error.message || "unknown error";
            failureCounts.set(reason, (failureCounts.get(reason) || 0) + 1);
            return null;
          }
        }
      );

      const playable = resolvedBatch.filter(Boolean);
      tracks.push(...playable);

      if (onTracks && playable.length > 0) {
        await onTracks(playable, {
          title: playlist.name,
          totalTracks: playlist.tracks.length,
          resolvedSoFar: tracks.length,
          remaining: Math.max(0, playlist.tracks.length - (start + batch.length))
        });
      }
    }

    if (tracks.length === 0) {
      // Report the most common underlying error so an infrastructure problem
      // (like YouTube bot-blocking the Lavalink host) is visible to the user
      // instead of hiding behind a generic "nothing resolved" message.
      const topFailures = [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([reason, count]) => `"${reason}" (${count} track${count === 1 ? "" : "s"})`);

      console.warn(`Spotify playlist "${playlist.name}": 0 of ${playlist.tracks.length} tracks resolved. Failures: ${topFailures.join("; ") || "none recorded"}`);

      throw new Error(
        `I fetched **${playlist.name}** (${playlist.tracks.length} tracks) from Spotify, but could not load audio for any of them. ` +
          (topFailures.length > 0
            ? `The YouTube lookups failed with: ${topFailures.join("; ")}.`
            : "The YouTube lookups returned no results.")
      );
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
    const identifier = this.isUrl(query) ? query : `scsearch:${query}`;
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
        source: "soundcloud",
        title: result.data.info.name,
        tracks: result.data.tracks.map((track) =>
          this.createQueueTrack(track, requester, options.sourceLabel || "SoundCloud")
        )
      };
    }

    const rawTrack = result.loadType === "track" ? result.data : result.data[0];

    if (!rawTrack) {
      throw new Error("No playable tracks were returned from Lavalink.");
    }

    return {
      type: "track",
      source: options.sourceLabel?.toLowerCase() || "soundcloud",
      title: rawTrack.info.title,
      tracks: [this.createQueueTrack(rawTrack, requester, options.sourceLabel || "SoundCloud")]
    };
  }
}

module.exports = MusicService;
