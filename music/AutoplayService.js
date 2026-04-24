const DEFAULT_SPOTIFY_MARKET = "US";
const TARGET_SPOTIFY_CANDIDATES = 14;
const SPOTIFY_SEARCH_LIMIT = 10;
const YOUTUBE_RESOLVE_LIMIT = 8;
const RELATED_ARTIST_LIMIT = 4;

const STRICT_VERSION_PATTERN =
  /\b(cover|remix|slowed|reverb|sped\s*up|speed\s*up|lyrics?|karaoke|instrumental|nightcore|8d|bass\s*boosted)\b/i;
const LIVE_OR_ACOUSTIC_VERSION_PATTERN =
  /(\([^)]*\b(live|acoustic)\b[^)]*\)|\[[^\]]*\b(live|acoustic)\b[^\]]*\]|\b(live|acoustic)\b\s+(version|session|performance|recording)|\b(live|acoustic)\b\s+(at|from)\b)/i;

class AutoplayService {
  constructor(musicService) {
    this.music = musicService;
    this.client = musicService.client;
    this.spotify = musicService.spotify;
    this.market = this.client.config.spotify.market || DEFAULT_SPOTIFY_MARKET;
    this.artistCache = new Map();
    this.genreSeedCache = null;
  }

  async resolve(referenceTrack, requester, excludedTracks = []) {
    const context = this.buildContext(referenceTrack, excludedTracks);
    const seed = await this.resolveSpotifySeed(referenceTrack, context).catch(() => null);

    if (!seed) {
      return this.resolveYouTubeFallback(referenceTrack, requester, context);
    }

    const candidates = await this.getSpotifyCandidates(seed, context);
    const rankedCandidates = this.scoreAndSortCandidates(candidates, seed, context).slice(0, 3);

    if (rankedCandidates.length === 0) {
      return this.resolveYouTubeFallback(referenceTrack, requester, context);
    }

    for (const candidate of this.weightedCandidateOrder(rankedCandidates)) {
      const playableTrack = await this.resolveSpotifyCandidate(candidate, seed, requester, context).catch(() => null);

      if (playableTrack) {
        return playableTrack;
      }
    }

    return this.resolveYouTubeFallback(referenceTrack, requester, context);
  }

  buildContext(referenceTrack, excludedTracks) {
    const tracks = [referenceTrack, ...excludedTracks].filter(Boolean);
    const recentTracks = tracks.slice(-20);
    const trackKeys = new Set(tracks.flatMap((track) => this.music.getTrackKeys(track)));
    const spotifyIds = new Set();
    const fingerprints = new Set();
    const artistCounts = new Map();
    const genreCounts = new Map();
    const languageCounts = new Map();

    for (const track of tracks) {
      const spotifyId = track.autoplay?.spotifyId;
      if (spotifyId) {
        spotifyIds.add(String(spotifyId).toLowerCase());
      }

      const fingerprint = this.buildTrackFingerprint(track);
      if (fingerprint) {
        fingerprints.add(fingerprint);
      }
    }

    for (const track of recentTracks) {
      const artist = this.normalizeArtist(track.info?.author);
      if (artist) {
        artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      }

      for (const genre of track.autoplay?.genres || []) {
        const normalizedGenre = this.normalizeGenre(genre);
        if (normalizedGenre) {
          genreCounts.set(normalizedGenre, (genreCounts.get(normalizedGenre) || 0) + 1);
        }
      }

      const language = this.detectLanguageBucket(`${track.info?.author || ""} ${track.info?.title || ""}`);
      languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
    }

    return {
      referenceTrack,
      tracks,
      recentTracks,
      trackKeys,
      spotifyIds,
      fingerprints,
      artistCounts,
      genreCounts,
      dominantLanguage: this.getMostCommonKey(languageCounts) || this.detectLanguageBucket(referenceTrack?.info?.title || "")
    };
  }

  async resolveSpotifySeed(referenceTrack, context) {
    const existingSpotifyId = referenceTrack?.autoplay?.spotifyId;

    if (existingSpotifyId) {
      const track = await this.safeSpotifyRequest(`/tracks/${encodeURIComponent(existingSpotifyId)}?market=${encodeURIComponent(this.market)}`);

      if (track?.id) {
        return this.hydrateSeed(this.toSpotifyCandidate(track, "seed", 0, 1), context);
      }
    }

    const query = this.buildSeedSearchQuery(referenceTrack);
    if (!query) {
      return null;
    }

    const result = await this.searchSpotifyTracks(query, SPOTIFY_SEARCH_LIMIT);
    const tracks = result?.tracks?.items || [];
    const candidates = tracks
      .map((track, index) => this.toSpotifyCandidate(track, "seed-search", index, 1))
      .filter(Boolean)
      .filter((candidate) => !this.isBlockedVersion(candidate.name));

    if (candidates.length === 0) {
      return null;
    }

    const referenceTitle = this.normalizeTitle(referenceTrack?.info?.title);
    const referenceArtist = this.normalizeArtist(referenceTrack?.info?.author);
    const referenceDuration = referenceTrack?.info?.length || 0;

    const best = candidates
      .map((candidate) => {
        const titleScore = this.textSimilarity(referenceTitle, this.normalizeTitle(candidate.name));
        const artistScore = this.bestArtistSimilarity(referenceArtist, candidate.artists);
        const durationScore = this.durationSimilarity(referenceDuration, candidate.durationMs);

        return {
          candidate,
          score: titleScore * 0.55 + artistScore * 0.3 + durationScore * 0.15
        };
      })
      .sort((left, right) => right.score - left.score)[0];

    if (!best || best.score < 0.35) {
      return null;
    }

    return this.hydrateSeed(best.candidate, context);
  }

  async hydrateSeed(seed, context) {
    await this.enrichArtistMetadata([seed]);
    seed.genres = this.uniqueValues(seed.genres.map((genre) => this.normalizeGenre(genre)).filter(Boolean));
    seed.language = this.detectLanguageBucket(`${seed.primaryArtistName} ${seed.name}`);
    seed.fingerprint = this.buildSpotifyFingerprint(seed);

    if (context.spotifyIds.has(seed.id?.toLowerCase()) || context.fingerprints.has(seed.fingerprint)) {
      context.seedWasRecentlyPlayed = true;
    }

    return seed;
  }

  async getSpotifyCandidates(seed, context) {
    const candidates = [];
    const seen = new Set();
    const addCandidates = (tracks, source, sourceWeight, relatedArtist = null) => {
      for (let index = 0; index < tracks.length; index += 1) {
        const candidate = this.toSpotifyCandidate(tracks[index], source, index, sourceWeight, relatedArtist);

        if (!candidate || !this.isSpotifyCandidateAllowed(candidate, seed, context)) {
          continue;
        }

        const uniqueKey = this.getCandidateUniqueKey(candidate);
        if (seen.has(uniqueKey)) {
          continue;
        }

        seen.add(uniqueKey);
        candidates.push(candidate);
      }
    };

    addCandidates(await this.getRecommendationTracks(seed), "recommendations", 1);

    if (candidates.length < TARGET_SPOTIFY_CANDIDATES) {
      addCandidates(await this.getSeedArtistTopTracks(seed), "artist-top-tracks", 0.84);
    }

    if (candidates.length < TARGET_SPOTIFY_CANDIDATES) {
      const relatedArtistTracks = await this.getRelatedArtistTopTracks(seed);
      for (const item of relatedArtistTracks) {
        addCandidates(item.tracks, "related-artist-top-tracks", 0.78, item.artist);
      }
    }

    if (candidates.length < TARGET_SPOTIFY_CANDIDATES) {
      addCandidates(await this.getSpotifySearchFallbackTracks(seed, context), "spotify-search", 0.58);
    }

    await this.enrichArtistMetadata(candidates);
    return candidates.filter((candidate) => this.isSpotifyCandidateAllowed(candidate, seed, context));
  }

  async getRecommendationTracks(seed) {
    const params = new URLSearchParams({
      limit: "25",
      market: this.market
    });

    if (seed.id) {
      params.set("seed_tracks", seed.id);
    }

    if (seed.primaryArtistId) {
      params.set("seed_artists", seed.primaryArtistId);
    }

    const genreSeed = await this.pickRecommendationGenreSeed(seed);
    if (genreSeed) {
      params.set("seed_genres", genreSeed);
    }

    if (!params.has("seed_tracks") && !params.has("seed_artists") && !params.has("seed_genres")) {
      return [];
    }

    const result = await this.safeSpotifyRequest(`/recommendations?${params.toString()}`);
    return result?.tracks || [];
  }

  async getSeedArtistTopTracks(seed) {
    const tracks = [];

    for (const artist of seed.artists.filter((item) => item.id).slice(0, 2)) {
      const result = await this.safeSpotifyRequest(
        `/artists/${encodeURIComponent(artist.id)}/top-tracks?market=${encodeURIComponent(this.market)}`
      );
      tracks.push(...(result?.tracks || []));
    }

    return tracks;
  }

  async getRelatedArtistTopTracks(seed) {
    if (!seed.primaryArtistId) {
      return [];
    }

    const result = await this.safeSpotifyRequest(`/artists/${encodeURIComponent(seed.primaryArtistId)}/related-artists`);
    const artists = (result?.artists || []).slice(0, RELATED_ARTIST_LIMIT);
    const tracksByArtist = [];

    for (const artist of artists) {
      const topTracks = await this.safeSpotifyRequest(
        `/artists/${encodeURIComponent(artist.id)}/top-tracks?market=${encodeURIComponent(this.market)}`
      );
      tracksByArtist.push({
        artist,
        tracks: topTracks?.tracks || []
      });
    }

    return tracksByArtist;
  }

  async getSpotifySearchFallbackTracks(seed, context) {
    const queries = this.uniqueValues(
      [
        [seed.primaryGenre, seed.primaryArtistName].filter(Boolean).join(" "),
        [seed.primaryGenre, this.getMostCommonKey(context.genreCounts)].filter(Boolean).join(" "),
        [seed.primaryArtistName, seed.name].filter(Boolean).join(" "),
        seed.primaryGenre
      ].filter(Boolean)
    );
    const tracks = [];

    for (const query of queries) {
      const result = await this.searchSpotifyTracks(query, SPOTIFY_SEARCH_LIMIT);
      tracks.push(...(result?.tracks?.items || []));

      if (tracks.length >= TARGET_SPOTIFY_CANDIDATES) {
        break;
      }
    }

    return tracks;
  }

  async pickRecommendationGenreSeed(seed) {
    if (!seed.genres.length) {
      return null;
    }

    const genreSeeds = await this.getAvailableRecommendationGenreSeeds();
    if (!genreSeeds.size) {
      return null;
    }

    return seed.genres.find((genre) => genreSeeds.has(genre)) || null;
  }

  async getAvailableRecommendationGenreSeeds() {
    if (this.genreSeedCache) {
      return this.genreSeedCache;
    }

    const result = await this.safeSpotifyRequest("/recommendations/available-genre-seeds");
    this.genreSeedCache = new Set((result?.genres || []).map((genre) => this.normalizeGenre(genre)).filter(Boolean));
    return this.genreSeedCache;
  }

  async searchSpotifyTracks(query, limit) {
    const params = new URLSearchParams({
      q: query,
      type: "track",
      limit: String(limit),
      market: this.market
    });

    return this.safeSpotifyRequest(`/search?${params.toString()}`);
  }

  async safeSpotifyRequest(path) {
    try {
      return await this.spotify.request(path);
    } catch (error) {
      console.warn(`Autoplay Spotify request failed: ${error.message}`);
      return null;
    }
  }

  async enrichArtistMetadata(candidates) {
    if (this.artistCache.size > 500) {
      this.artistCache.clear();
    }

    const ids = this.uniqueValues(
      candidates
        .flatMap((candidate) => candidate.artists.map((artist) => artist.id))
        .filter(Boolean)
    );
    const missingIds = ids.filter((id) => !this.artistCache.has(id));

    for (let index = 0; index < missingIds.length; index += 50) {
      const chunk = missingIds.slice(index, index + 50);
      const result = await this.safeSpotifyRequest(`/artists?ids=${chunk.map((id) => encodeURIComponent(id)).join(",")}`);

      for (const artist of result?.artists || []) {
        if (artist?.id) {
          this.artistCache.set(artist.id, {
            id: artist.id,
            name: artist.name,
            genres: artist.genres || [],
            popularity: artist.popularity || 0
          });
        }
      }
    }

    for (const candidate of candidates) {
      const genres = [];
      let artistPopularity = 0;

      for (const artist of candidate.artists) {
        const details = this.artistCache.get(artist.id);
        if (!details) {
          continue;
        }

        genres.push(...details.genres);
        artistPopularity = Math.max(artistPopularity, details.popularity || 0);
      }

      if (candidate.relatedArtist?.genres) {
        genres.push(...candidate.relatedArtist.genres);
      }

      candidate.genres = this.uniqueValues(genres.map((genre) => this.normalizeGenre(genre)).filter(Boolean));
      candidate.primaryGenre = candidate.genres[0] || null;
      candidate.artistPopularity = artistPopularity;
      candidate.language = this.detectLanguageBucket(`${candidate.primaryArtistName} ${candidate.name}`);
    }
  }

  scoreAndSortCandidates(candidates, seed, context) {
    return candidates
      .map((candidate) => ({
        ...candidate,
        score: this.scoreCandidate(candidate, seed, context)
      }))
      .filter((candidate) => Number.isFinite(candidate.score) && candidate.score > 0)
      .sort((left, right) => right.score - left.score);
  }

  scoreCandidate(candidate, seed, context) {
    const sourceScore = Math.max(0.15, candidate.sourceWeight * (1 - Math.min(candidate.rank, 20) / 30));
    const genreScore = this.genreSimilarity(seed.genres, candidate.genres);
    const durationScore = this.durationSimilarity(seed.durationMs, candidate.durationMs);
    const languageScore = this.languageScore(candidate.language, seed.language || context.dominantLanguage);
    const popularityScore = Math.max(candidate.popularity || 0, candidate.artistPopularity || 0) / 100;
    const artistScore = this.artistScore(candidate, seed, context);
    const historyGenreScore = this.historyGenreScore(candidate, context);
    const repeatPenalty = this.repeatArtistPenalty(candidate, context);

    return (
      sourceScore * 34 +
      genreScore * 18 +
      durationScore * 13 +
      languageScore * 12 +
      popularityScore * 12 +
      artistScore * 8 +
      historyGenreScore * 3 -
      repeatPenalty
    );
  }

  artistScore(candidate, seed, context) {
    const candidateArtists = candidate.artists.map((artist) => this.normalizeArtist(artist.name));
    const seedArtists = seed.artists.map((artist) => this.normalizeArtist(artist.name));

    if (candidateArtists.some((artist) => seedArtists.includes(artist))) {
      return 0.75;
    }

    if (candidate.relatedArtist) {
      return 0.7;
    }

    const bestHistoryMatch = Math.max(
      0,
      ...candidateArtists.map((artist) => (context.artistCounts.has(artist) ? 0.5 : 0))
    );

    return bestHistoryMatch || 0.35;
  }

  repeatArtistPenalty(candidate, context) {
    const maxCount = Math.max(
      0,
      ...candidate.artists.map((artist) => context.artistCounts.get(this.normalizeArtist(artist.name)) || 0)
    );

    return Math.min(18, maxCount * 5);
  }

  historyGenreScore(candidate, context) {
    if (!candidate.genres.length || !context.genreCounts.size) {
      return 0;
    }

    const matches = candidate.genres.filter((genre) => context.genreCounts.has(genre)).length;
    return Math.min(1, matches / Math.max(1, candidate.genres.length));
  }

  weightedCandidateOrder(candidates) {
    const pool = candidates.map((candidate) => ({
      candidate,
      weight: Math.max(1, candidate.score)
    }));
    const ordered = [];

    while (pool.length > 0) {
      const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
      let cursor = Math.random() * totalWeight;
      let selectedIndex = 0;

      for (let index = 0; index < pool.length; index += 1) {
        cursor -= pool[index].weight;
        if (cursor <= 0) {
          selectedIndex = index;
          break;
        }
      }

      ordered.push(pool.splice(selectedIndex, 1)[0].candidate);
    }

    return ordered;
  }

  async resolveSpotifyCandidate(candidate, seed, requester, context) {
    const node = this.client.playerManager.getSearchNode();
    const queries = this.buildPlayableQueries(candidate);

    for (const query of queries) {
      const result = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
      const rawTrack = this.pickBestResolvedTrack(this.music.getLavalinkTracks(result).slice(0, YOUTUBE_RESOLVE_LIMIT), candidate, context);

      if (!rawTrack) {
        continue;
      }

      const track = this.music.createQueueTrack(rawTrack, requester, "Autoplay");
      if (candidate.artworkUrl && !track.info.artworkUrl) {
        track.info.artworkUrl = candidate.artworkUrl;
      }

      track.autoplay = {
        spotifyId: candidate.id,
        spotifyUrl: candidate.url,
        score: Number(candidate.score.toFixed(2)),
        seedId: seed.id,
        genres: candidate.genres
      };

      return track;
    }

    return null;
  }

  pickBestResolvedTrack(rawTracks, candidate, context) {
    const evaluated = rawTracks
      .filter((track) => track?.encoded && !this.isExcludedRawTrack(track, context))
      .map((track) => {
        const title = `${track.info?.author || ""} ${track.info?.title || ""}`;

        if (this.isBlockedVersion(title)) {
          return null;
        }

        const titleScore = this.textSimilarity(this.normalizeTitle(track.info?.title), this.normalizeTitle(candidate.name));
        const artistScore = this.bestArtistSimilarity(this.normalizeArtist(track.info?.author), candidate.artists);
        const durationScore = this.durationSimilarity(track.info?.length || 0, candidate.durationMs);
        const score = titleScore * 0.62 + artistScore * 0.26 + durationScore * 0.12;

        return {
          track,
          score
        };
      })
      .filter(Boolean)
      .filter((item) => item.score >= 0.42)
      .sort((left, right) => right.score - left.score);

    return evaluated[0]?.track || null;
  }

  async resolveYouTubeFallback(referenceTrack, requester, context) {
    const node = this.client.playerManager.getSearchNode();
    const queries = this.buildYouTubeFallbackQueries(referenceTrack, context);
    const candidates = [];

    for (const query of queries) {
      const result = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
      const rawTracks = this.music.getLavalinkTracks(result).slice(0, YOUTUBE_RESOLVE_LIMIT);

      for (let index = 0; index < rawTracks.length; index += 1) {
        const rawTrack = rawTracks[index];
        if (!rawTrack?.encoded || this.isExcludedRawTrack(rawTrack, context)) {
          continue;
        }

        const title = `${rawTrack.info?.author || ""} ${rawTrack.info?.title || ""}`;
        if (this.isBlockedVersion(title)) {
          continue;
        }

        const referenceTitle = this.normalizeTitle(referenceTrack?.info?.title);
        const titleSimilarity = this.textSimilarity(referenceTitle, this.normalizeTitle(rawTrack.info?.title));
        if (titleSimilarity > 0.86) {
          continue;
        }

        candidates.push({
          rawTrack,
          score: (1 - index / YOUTUBE_RESOLVE_LIMIT) * 0.7 + (1 - titleSimilarity) * 0.3
        });
      }

      if (candidates.length >= YOUTUBE_RESOLVE_LIMIT) {
        break;
      }
    }

    candidates.sort((left, right) => right.score - left.score);
    const rawTrack = candidates.slice(0, 3)[Math.floor(Math.random() * Math.min(3, candidates.length))]?.rawTrack;

    if (!rawTrack) {
      throw new Error("I could not find a similar song for autoplay.");
    }

    return this.music.createQueueTrack(rawTrack, requester, "Autoplay");
  }

  buildSeedSearchQuery(track) {
    const title = this.cleanTitle(track?.info?.title);
    const artist = this.cleanArtist(track?.info?.author);

    return [artist, title].filter(Boolean).join(" ").trim();
  }

  buildPlayableQueries(candidate) {
    return this.uniqueValues(
      [
        `${candidate.primaryArtistName} - ${candidate.name} official audio`,
        `${candidate.primaryArtistName} ${candidate.name} audio`,
        `${candidate.primaryArtistName} ${candidate.name}`
      ].filter(Boolean)
    );
  }

  buildYouTubeFallbackQueries(referenceTrack, context) {
    const title = this.cleanTitle(referenceTrack?.info?.title);
    const artist = this.cleanArtist(referenceTrack?.info?.author);
    const dominantArtist = this.getMostCommonKey(context.artistCounts);

    return this.uniqueValues(
      [
        [artist, title, "similar songs"].filter(Boolean).join(" "),
        [artist, "songs"].filter(Boolean).join(" "),
        [dominantArtist, "songs"].filter(Boolean).join(" "),
        [title, "mix"].filter(Boolean).join(" ")
      ].filter(Boolean)
    );
  }

  toSpotifyCandidate(track, source, rank, sourceWeight, relatedArtist = null) {
    if (!track?.id || !track.name || track.is_local) {
      return null;
    }

    const artists = (track.artists || [])
      .filter((artist) => artist?.name)
      .map((artist) => ({
        id: artist.id || null,
        name: artist.name
      }));

    if (artists.length === 0) {
      return null;
    }

    return {
      id: track.id,
      name: track.name,
      artists,
      primaryArtistId: artists[0].id,
      primaryArtistName: artists[0].name,
      durationMs: track.duration_ms || 0,
      popularity: Number.isFinite(track.popularity) ? track.popularity : 50,
      url: track.external_urls?.spotify || null,
      artworkUrl: track.album?.images?.[0]?.url || null,
      albumName: track.album?.name || "",
      source,
      rank,
      sourceWeight,
      relatedArtist,
      genres: [],
      primaryGenre: null,
      language: null,
      score: 0
    };
  }

  isSpotifyCandidateAllowed(candidate, seed, context) {
    if (!candidate?.id || context.spotifyIds.has(candidate.id.toLowerCase())) {
      return false;
    }

    if (seed?.id && candidate.id === seed.id) {
      return false;
    }

    if (this.isBlockedVersion(`${candidate.name} ${candidate.albumName}`)) {
      return false;
    }

    const fingerprint = this.buildSpotifyFingerprint(candidate);
    if (!fingerprint || context.fingerprints.has(fingerprint)) {
      return false;
    }

    if (seed?.fingerprint && fingerprint === seed.fingerprint) {
      return false;
    }

    return true;
  }

  isExcludedRawTrack(rawTrack, context) {
    const keys = this.music.getTrackKeys(rawTrack);
    if (keys.some((key) => context.trackKeys.has(key))) {
      return true;
    }

    const fingerprint = this.buildRawTrackFingerprint(rawTrack);
    return Boolean(fingerprint && context.fingerprints.has(fingerprint));
  }

  getCandidateUniqueKey(candidate) {
    return candidate.id || this.buildSpotifyFingerprint(candidate);
  }

  buildSpotifyFingerprint(candidate) {
    const artist = this.normalizeArtist(candidate.primaryArtistName);
    const title = this.normalizeTitle(candidate.name);
    return artist && title ? `${artist}:${title}` : null;
  }

  buildTrackFingerprint(track) {
    const artist = this.normalizeArtist(track?.info?.author);
    const title = this.normalizeTitle(track?.info?.title);
    return artist && title ? `${artist}:${title}` : null;
  }

  buildRawTrackFingerprint(rawTrack) {
    const artist = this.normalizeArtist(rawTrack?.info?.author);
    const title = this.normalizeTitle(rawTrack?.info?.title);
    return artist && title ? `${artist}:${title}` : null;
  }

  cleanTitle(value) {
    return String(value || "")
      .replace(/\[[^\]]*(official|lyrics?|video|audio|visualizer|hd|4k)[^\]]*\]/gi, " ")
      .replace(/\([^)]*(official|lyrics?|video|audio|visualizer|hd|4k)[^)]*\)/gi, " ")
      .replace(/\b(official\s*)?(music\s*)?(video|audio|lyrics?|visualizer)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  cleanArtist(value) {
    return String(value || "")
      .replace(/\s*-\s*topic$/i, "")
      .replace(/\bvevo\b/gi, "")
      .replace(/\bofficial\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  normalizeTitle(value) {
    return this.normalizeText(this.cleanTitle(value));
  }

  normalizeArtist(value) {
    return this.normalizeText(this.cleanArtist(value));
  }

  normalizeGenre(value) {
    return this.normalizeText(value);
  }

  normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  isBlockedVersion(value) {
    const text = String(value || "");
    return STRICT_VERSION_PATTERN.test(text) || LIVE_OR_ACOUSTIC_VERSION_PATTERN.test(text);
  }

  textSimilarity(leftValue, rightValue) {
    const left = this.normalizeText(leftValue);
    const right = this.normalizeText(rightValue);

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
  }

  bestArtistSimilarity(referenceArtist, artists) {
    if (!referenceArtist || !artists?.length) {
      return 0;
    }

    return Math.max(
      0,
      ...artists.map((artist) => this.textSimilarity(referenceArtist, this.normalizeArtist(artist.name)))
    );
  }

  durationSimilarity(leftMs, rightMs) {
    if (!leftMs || !rightMs) {
      return 0.5;
    }

    const difference = Math.abs(leftMs - rightMs);
    return Math.max(0, 1 - difference / Math.max(leftMs, rightMs));
  }

  genreSimilarity(leftGenres, rightGenres) {
    if (!leftGenres?.length || !rightGenres?.length) {
      return 0.35;
    }

    const left = new Set(leftGenres);
    const right = new Set(rightGenres);
    const intersection = [...left].filter((genre) => right.has(genre)).length;
    const union = new Set([...left, ...right]).size;

    return union ? intersection / union : 0;
  }

  languageScore(leftLanguage, rightLanguage) {
    if (!leftLanguage || !rightLanguage) {
      return 0.5;
    }

    return leftLanguage === rightLanguage ? 1 : 0.28;
  }

  detectLanguageBucket(value) {
    const text = String(value || "");

    if (/[\u0600-\u06ff]/.test(text)) {
      return "arabic";
    }

    if (/[\u0900-\u097f]/.test(text)) {
      return "devanagari";
    }

    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) {
      return "cjk";
    }

    if (/[\u0400-\u04ff]/.test(text)) {
      return "cyrillic";
    }

    if (/[\uac00-\ud7af]/.test(text)) {
      return "korean";
    }

    if (/[a-z]/i.test(text)) {
      return "latin";
    }

    return "other";
  }

  getMostCommonKey(map) {
    let selectedKey = null;
    let selectedCount = 0;

    for (const [key, count] of map.entries()) {
      if (count > selectedCount) {
        selectedKey = key;
        selectedCount = count;
      }
    }

    return selectedKey;
  }

  uniqueValues(values) {
    return [...new Set(values.filter(Boolean))];
  }
}

module.exports = AutoplayService;
