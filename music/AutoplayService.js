const DEFAULT_YTMUSIC_AUTOPLAY_URL = "http://127.0.0.1:3001";
const REQUEST_TIMEOUT_MS = 3000;
const MAX_CANDIDATES_TO_TRY = 15;
const STRICT_SEED_ARTIST_TRACK_COUNT = 6;
const MIN_RELEVANCE_SCORE = 70;

const SOURCE_SCORES = Object.freeze({
  artist: 90,
  watch: 70,
  related: 45,
  search: 35,
  fallback: 20
});

const TITLE_TOKEN_STOP_WORDS = new Set([
  "the",
  "and",
  "official",
  "audio",
  "video",
  "music",
  "song",
  "lyrics",
  "lyric",
  "topic",
  "feat",
  "ft"
]);

const BANNED_WORDS = [
  "live",
  "lyrics",
  "lyric",
  "remix",
  "mashup",
  "cover",
  "slowed",
  "reverb",
  "8d",
  "edit",
  "version"
];

class AutoplayService {
  constructor(musicService) {
    this.music = musicService;
    this.client = musicService.client;
    this.serviceUrl = this.normalizeServiceUrl(this.client.config.ytmusicAutoplay?.url || DEFAULT_YTMUSIC_AUTOPLAY_URL);
  }

  async resolve(referenceTrack, requester, excludedTracks = []) {
    const context = this.buildContext(referenceTrack, excludedTracks);
    const videoId = this.getVideoId(referenceTrack);

    if (videoId) {
      try {
        const track = await this.resolveCandidateList(await this.fetchRelated(videoId), requester, context, {
          sourceLabel: "Autoplay",
          decorateAutoplay: true,
          autoplaySource: "ytmusic"
        });

        if (track) {
          return track;
        }
      } catch (error) {
        console.warn(`YTMusic related resolver failed: ${error.message}`);
      }
    }

    return this.resolveFallback(requester, context);
  }

  async fetchRelated(videoId) {
    const url = new URL("/related", this.serviceUrl);
    url.searchParams.set("videoId", videoId);
    return this.fetchTracks(url);
  }

  async fetchSearch(query) {
    const url = new URL("/search", this.serviceUrl);
    url.searchParams.set("q", query);
    return this.fetchTracks(url);
  }

  async fetchTracks(url) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json"
          }
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const payload = await res.json();
        return Array.isArray(payload) ? payload : payload.tracks || [];
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error("fetch failed");
  }

  async resolveYouTubeMusicSearch(query, requester) {
    const tracks = await this.fetchSearch(query).catch((error) => {
      console.warn(`YTMusic search resolver failed: ${error.message}`);
      return [];
    });

    return this.resolveCandidateList(tracks, requester, this.buildSearchContext(query), {
      sourceLabel: "YouTube Music",
      decorateAutoplay: false
    });
  }

  async resolveCandidateList(tracks, requester, context, options = {}) {
    const filtered = this.filterTracks(tracks, context);
    if (filtered.length === 0) {
      return null;
    }

    const ranked = this.rankTracks(filtered, context);
    const ordered = this.selectCandidateBatch(ranked, context, options).slice(0, MAX_CANDIDATES_TO_TRY);

    if (ordered.length === 0) {
      return null;
    }

    for (const entry of ordered) {
      const track = await this.resolveCandidate(entry.track, requester, context, options).catch(() => null);
      if (track) {
        return track;
      }
    }

    return null;
  }

  filterTracks(tracks, context) {
    const seen = new Set();
    const currentIsLatin = this.isAsciiText(context.currentRawTitle);

    return (Array.isArray(tracks) ? tracks : [])
      .map((track) => this.normalizeTrack(track))
      .filter(Boolean)
      .filter((track) => {
        const normalizedTitle = this.normalizeText(track.title);

        if (this.isBlockedTitle(track.title)) {
          return false;
        }

        if (track.videoId === context.currentVideoId || context.history.has(track.videoId)) {
          return false;
        }

        if (this.isSameTitleVariant(normalizedTitle, context.currentTitles)) {
          return false;
        }

        if (currentIsLatin && !this.isAsciiText(track.title)) {
          return false;
        }

        const fingerprint = this.getCandidateFingerprint(track, normalizedTitle);
        if (seen.has(track.videoId) || (fingerprint && context.fingerprints.has(fingerprint))) {
          return false;
        }

        seen.add(track.videoId);
        return true;
      });
  }

  rankTracks(tracks, context) {
    return tracks
      .map((track, index) => ({
        track,
        index,
        signals: this.buildCandidateSignals(track, context),
        score: this.scoreTrack(track, context)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
  }

  scoreTrack(track, context) {
    const signals = this.buildCandidateSignals(track, context);
    const { profile, sharedSeedArtists, sharedCurrentArtists, seedTitleOverlap, currentTitleOverlap } = signals;

    let score = this.getSourceScore(track.source);

    if (signals.seedArtistMatch) {
      score += 220 + Math.max(sharedSeedArtists, 1) * 50;
    } else if (context.seedProfile.normalizedArtists.size > 0) {
      score -= 110;
    }

    if (signals.currentArtistMatch) {
      score += 140 + Math.max(sharedCurrentArtists, 1) * 40;
    } else if (context.currentProfile.normalizedArtists.size > 0) {
      score -= 30;
    }

    if (context.seedProfile.primaryArtist && profile.primaryArtist === context.seedProfile.primaryArtist) {
      score += 90;
    }

    if (context.currentProfile.primaryArtist && profile.primaryArtist === context.currentProfile.primaryArtist) {
      score += 50;
    }

    score += Math.min(seedTitleOverlap * 6, 18);
    score += Math.min(currentTitleOverlap * 8, 24);

    if (!profile.primaryArtist) {
      score -= 20;
    }

    if (track.source === "related" && sharedSeedArtists === 0 && sharedCurrentArtists === 0) {
      score -= 15;
    }

    return score;
  }

  buildCandidateSignals(track, context) {
    const profile = this.buildProfile(track.title, this.getArtistNames(track));
    const sharedSeedArtists = this.countSharedValues(profile.normalizedArtists, context.seedProfile.normalizedArtists);
    const sharedCurrentArtists = this.countSharedValues(profile.normalizedArtists, context.currentProfile.normalizedArtists);
    const seedTitleOverlap = this.countSharedValues(profile.titleTokens, context.seedProfile.titleTokens);
    const currentTitleOverlap = this.countSharedValues(profile.titleTokens, context.currentProfile.titleTokens);

    return {
      profile,
      sharedSeedArtists,
      sharedCurrentArtists,
      seedTitleOverlap,
      currentTitleOverlap,
      seedArtistMatch:
        sharedSeedArtists > 0 || this.titleMentionsArtists(profile.rawTitle, context.seedProfile.artistNames),
      currentArtistMatch:
        sharedCurrentArtists > 0 || this.titleMentionsArtists(profile.rawTitle, context.currentProfile.artistNames)
    };
  }

  selectCandidateBatch(ranked, context, options = {}) {
    const seedMatches = ranked.filter((entry) => entry.signals.seedArtistMatch);
    const requireSeedArtist = context.requireSeedArtist && !options.ignoreSeedArtistLock;

    if (requireSeedArtist) {
      return seedMatches;
    }

    if (seedMatches.length > 0) {
      return seedMatches;
    }

    const currentMatches = ranked.filter((entry) => entry.signals.currentArtistMatch);
    if (currentMatches.length > 0) {
      return currentMatches;
    }

    const relevant = ranked.filter((entry) => entry.score >= MIN_RELEVANCE_SCORE);
    if (relevant.length > 0) {
      return relevant;
    }

    return options.allowLowConfidence ? ranked : [];
  }

  async resolveCandidate(candidate, requester, context, options = {}) {
    const node = this.client.playerManager.getSearchNode();
    const result = await node.rest.resolve(`https://www.youtube.com/watch?v=${candidate.videoId}`);
    const rawTrack = this.music.getLavalinkTracks(result).find((track) => {
      if (!track?.encoded) {
        return false;
      }

      const resolvedVideoId = this.getRawVideoId(track);
      if (resolvedVideoId && resolvedVideoId !== candidate.videoId) {
        return false;
      }

      return !this.isBlockedTitle(track.info?.title) && !context.history.has(resolvedVideoId);
    });

    if (!rawTrack) {
      return null;
    }

    const queueTrack = this.music.createQueueTrack(rawTrack, requester, options.sourceLabel || "Autoplay", {
      title: candidate.title,
      artists: this.getArtistNames(candidate)
    });

    if (options.decorateAutoplay) {
      this.decorateTrackForAutoplay(queueTrack, candidate, context, options.autoplaySource || "ytmusic");
    }

    return queueTrack;
  }

  decorateTrackForAutoplay(track, candidate, context, source) {
    track.autoplay = {
      videoId: candidate.videoId,
      source,
      bucket: candidate.source || "related",
      chainDepth: context.nextChainDepth,
      seed: {
        videoId: context.seedData.videoId,
        title: context.seedData.title,
        artists: [...context.seedData.artists],
        strictArtistTrackCount: context.seedData.strictArtistTrackCount
      },
      candidate: {
        videoId: candidate.videoId,
        title: candidate.title,
        artist: candidate.artist,
        artists: candidate.artists.map((artist) => ({ ...artist })),
        source: candidate.source || "related"
      }
    };
  }

  async resolveFallback(requester, context) {
    const strictQueries = this.buildFallbackQueries(context, { broaden: false });
    const strictTrack =
      (await this.resolveFallbackQueries(strictQueries, requester, context, { allowLowConfidence: false })) ||
      (await this.resolveLavalinkFallback(strictQueries, requester, context, { allowLowConfidence: false }));

    if (strictTrack) {
      return strictTrack;
    }

    const relaxedQueries = this.buildFallbackQueries(context, { broaden: true });
    const relaxedTrack =
      (await this.resolveFallbackQueries(relaxedQueries, requester, context, {
        allowLowConfidence: false,
        ignoreSeedArtistLock: true
      })) ||
      (await this.resolveLavalinkFallback(relaxedQueries, requester, context, {
        allowLowConfidence: true,
        ignoreSeedArtistLock: true
      }));

    if (relaxedTrack) {
      return relaxedTrack;
    }

    throw new Error("I could not find a relevant song for autoplay.");
  }

  async resolveFallbackQueries(queries, requester, context, options = {}) {
    for (const query of queries) {
      const track = await this.fetchSearch(query)
        .then((tracks) =>
          this.resolveCandidateList(tracks, requester, context, {
            sourceLabel: "Autoplay",
            decorateAutoplay: true,
            autoplaySource: "ytmusic",
            allowLowConfidence: options.allowLowConfidence,
            ignoreSeedArtistLock: options.ignoreSeedArtistLock
          })
        )
        .catch(() => null);

      if (track) {
        return track;
      }
    }

    return null;
  }

  buildFallbackQueries(context, options = {}) {
    const queries = [];
    const seen = new Set();
    const broaden = options.broaden === true;

    const addQuery = (value) => {
      const query = String(value || "").replace(/\s+/g, " ").trim();
      const key = this.normalizeText(query);

      if (!query || key.length < 4 || seen.has(key)) {
        return;
      }

      seen.add(key);
      queries.push(query);
    };

    const seedArtist = context.seedProfile.primaryArtistName;
    const currentArtist = context.currentProfile.primaryArtistName;
    const seedTitle = context.seedProfile.cleanedTitle;
    const currentTitle = context.currentProfile.cleanedTitle;

    if (seedArtist) {
      addQuery([seedArtist, currentTitle].filter(Boolean).join(" "));
      addQuery([seedArtist, seedTitle].filter(Boolean).join(" "));
      addQuery(`${seedArtist} songs`);
      addQuery(`${seedArtist} popular songs`);
      addQuery(`${seedArtist} official audio`);
    }

    if (broaden) {
      addQuery([currentArtist, currentTitle].filter(Boolean).join(" "));
      addQuery([currentArtist, seedTitle].filter(Boolean).join(" "));

      if (currentArtist && this.normalizeText(currentArtist) !== this.normalizeText(seedArtist)) {
        addQuery(`${currentArtist} songs`);
        addQuery(`${currentArtist} popular songs`);
      }
    }

    return queries.slice(0, broaden ? 10 : 6);
  }

  async resolveLavalinkFallback(queries, requester, context, options = {}) {
    const node = this.client.playerManager.getSearchNode();

    for (const query of queries) {
      const result = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
      if (!result) {
        continue;
      }

      const candidates = this.music
        .getLavalinkTracks(result)
        .map((rawTrack) => this.normalizeLavalinkTrack(rawTrack))
        .filter(Boolean)
        .filter((candidate) => {
          if (candidate.videoId && (candidate.videoId === context.currentVideoId || context.history.has(candidate.videoId))) {
            return false;
          }

          if (this.isSameTitleVariant(this.normalizeText(candidate.title), context.currentTitles)) {
            return false;
          }

          return !this.isBlockedTitle(candidate.title);
        });

      const ordered = this.selectCandidateBatch(this.rankTracks(candidates, context), context, options)
        .slice(0, MAX_CANDIDATES_TO_TRY);

      for (const entry of ordered) {
        const candidate = entry.track;
        const queueTrack = this.music.createQueueTrack(candidate.rawTrack, requester, "Autoplay", {
          title: candidate.title,
          artists: this.getArtistNames(candidate)
        });

        this.decorateTrackForAutoplay(queueTrack, candidate, context, "ytsearch");
        return queueTrack;
      }
    }

    return null;
  }

  buildContext(referenceTrack, excludedTracks) {
    const tracks = [referenceTrack, ...excludedTracks].filter(Boolean);
    const history = new Set();
    const fingerprints = new Set();
    const currentProfile = this.getTrackProfile(referenceTrack);
    const seedData = this.getSeedData(referenceTrack, currentProfile);
    const seedProfile = this.buildProfile(seedData.title, seedData.artists);
    const chainDepth = this.getAutoplayChainDepth(referenceTrack);
    const nextChainDepth = chainDepth + 1;

    for (const track of tracks.slice(-20)) {
      const videoId = this.getVideoId(track);
      if (videoId) {
        history.add(videoId);
      }

      const fingerprint = this.getProfileFingerprint(this.getTrackProfile(track));
      if (fingerprint) {
        fingerprints.add(fingerprint);
      }
    }

    const currentVideoId = this.getVideoId(referenceTrack);
    if (currentVideoId) {
      history.add(currentVideoId);
    }

    return {
      currentVideoId,
      currentRawTitle: referenceTrack?.info?.title || seedData.title || "",
      currentTitles: this.buildTitleVariants(currentProfile),
      history,
      fingerprints,
      currentProfile,
      seedProfile,
      seedData,
      chainDepth,
      nextChainDepth,
      requireSeedArtist: nextChainDepth <= seedData.strictArtistTrackCount
    };
  }

  buildSearchContext(query) {
    const profile = this.buildProfile(query, []);

    return {
      currentVideoId: null,
      currentRawTitle: query || "",
      currentTitles: new Set(),
      history: new Set(),
      fingerprints: new Set(),
      currentProfile: profile,
      seedProfile: profile,
      seedData: {
        videoId: null,
        title: profile.cleanedTitle,
        artists: profile.artistNames,
        strictArtistTrackCount: STRICT_SEED_ARTIST_TRACK_COUNT
      },
      chainDepth: 0,
      nextChainDepth: 1,
      requireSeedArtist: false
    };
  }

  getTrackProfile(track) {
    return this.buildProfile(
      track?.canonical?.title || track?.autoplay?.candidate?.title || track?.info?.title,
      this.getTrackArtistNames(track)
    );
  }

  getTrackArtistNames(track) {
    if (Array.isArray(track?.canonical?.artists) && track.canonical.artists.length > 0) {
      return track.canonical.artists;
    }

    if (Array.isArray(track?.autoplay?.candidate?.artists) && track.autoplay.candidate.artists.length > 0) {
      return track.autoplay.candidate.artists.map((artist) => artist?.name || artist);
    }

    return this.extractArtistNames(track?.info?.author);
  }

  getSeedData(referenceTrack, currentProfile) {
    const seed = referenceTrack?.autoplay?.seed;

    if (seed) {
      return {
        videoId: this.cleanVideoId(seed.videoId) || this.getVideoId(referenceTrack),
        title: String(seed.title || currentProfile.cleanedTitle || currentProfile.rawTitle || "").trim(),
        artists: this.normalizeArtistNames(seed.artists),
        strictArtistTrackCount: this.normalizeStrictArtistTrackCount(seed.strictArtistTrackCount)
      };
    }

    return {
      videoId: this.getVideoId(referenceTrack),
      title: currentProfile.cleanedTitle || currentProfile.rawTitle,
      artists: [...currentProfile.artistNames],
      strictArtistTrackCount: STRICT_SEED_ARTIST_TRACK_COUNT
    };
  }

  buildProfile(title, artists) {
    const rawTitle = String(title || "").trim();
    const cleanedTitle = this.cleanTitle(rawTitle);
    const artistNames = this.normalizeArtistNames(artists);
    const normalizedArtists = new Set(
      artistNames
        .map((artist) => this.normalizeText(this.cleanArtist(artist)))
        .filter(Boolean)
    );

    return {
      rawTitle,
      cleanedTitle,
      normalizedTitle: this.normalizeText(cleanedTitle),
      titleTokens: this.tokenizeTitle(cleanedTitle),
      artistNames,
      normalizedArtists,
      primaryArtistName: artistNames[0] || "",
      primaryArtist: normalizedArtists.values().next().value || ""
    };
  }

  buildTitleVariants(profile) {
    const titles = new Set();
    const normalizedTitle = profile.normalizedTitle;

    if (normalizedTitle.length >= 6) {
      titles.add(normalizedTitle);
    }

    if (profile.primaryArtist && normalizedTitle.startsWith(profile.primaryArtist)) {
      const withoutArtist = normalizedTitle
        .slice(profile.primaryArtist.length)
        .replace(/^\s*[-:]\s*/, "")
        .trim();

      if (withoutArtist.length >= 6) {
        titles.add(withoutArtist);
      }
    }

    return titles;
  }

  getProfileFingerprint(profile) {
    const artistKey = [...profile.normalizedArtists].sort().join("|");
    if (!artistKey && !profile.normalizedTitle) {
      return null;
    }

    return `${artistKey}:${profile.normalizedTitle}`;
  }

  getCandidateFingerprint(track, normalizedTitle) {
    const artistKey = this.getArtistNames(track)
      .map((artist) => this.normalizeText(this.cleanArtist(artist)))
      .filter(Boolean)
      .sort()
      .join("|");

    if (!artistKey && !normalizedTitle) {
      return null;
    }

    return `${artistKey}:${normalizedTitle}`;
  }

  normalizeTrack(track) {
    const videoId = this.cleanVideoId(track?.videoId);
    const title = String(track?.title || "").trim();

    if (!videoId || !title) {
      return null;
    }

    const artists = this.normalizeArtistEntries(track?.artists, track?.artist);

    return {
      videoId,
      title,
      artist: artists[0]?.name || String(track?.artist || "").trim(),
      artists,
      source: this.normalizeSource(track?.source)
    };
  }

  normalizeLavalinkTrack(rawTrack) {
    if (!rawTrack?.encoded || !rawTrack.info?.title) {
      return null;
    }

    const artist = String(rawTrack.info.author || "").trim();

    return {
      rawTrack,
      videoId: this.getRawVideoId(rawTrack),
      title: rawTrack.info.title,
      artist,
      artists: this.normalizeArtistEntries(null, artist),
      source: "fallback"
    };
  }

  normalizeArtistEntries(artists, fallbackArtist) {
    const entries = [];

    if (Array.isArray(artists)) {
      for (const artist of artists) {
        const name = String(typeof artist === "string" ? artist : artist?.name || "").trim();
        const id = String(typeof artist === "object" ? artist?.id || "" : "").trim() || undefined;

        if (!name) {
          continue;
        }

        entries.push({ name, id });
      }
    }

    if (entries.length === 0) {
      for (const artist of this.extractArtistNames(fallbackArtist)) {
        entries.push({ name: artist });
      }
    }

    const seen = new Set();
    return entries.filter((artist) => {
      const key = this.normalizeText(this.cleanArtist(artist.name));
      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  normalizeArtistNames(artists) {
    const seen = new Set();
    const output = [];

    for (const artist of Array.isArray(artists) ? artists : []) {
      const name = String(typeof artist === "string" ? artist : artist?.name || "").trim();
      const key = this.normalizeText(this.cleanArtist(name));

      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      output.push(name);
    }

    return output;
  }

  getArtistNames(track) {
    if (Array.isArray(track?.artists) && track.artists.length > 0) {
      return track.artists.map((artist) => artist?.name || artist).filter(Boolean);
    }

    return this.extractArtistNames(track?.artist);
  }

  extractArtistNames(value) {
    const cleaned = this.cleanArtist(value);
    if (!cleaned) {
      return [];
    }

    return [cleaned, ...cleaned
      .split(/\s+(?:feat\.?|ft\.?|with|x|and|&|\/)\s+/i)
      .map((artist) => artist.trim())
      .filter(Boolean)];
  }

  titleMentionsArtists(title, artists) {
    const normalizedTitle = this.normalizeText(title);

    if (!normalizedTitle) {
      return false;
    }

    return this.normalizeArtistNames(artists).some((artist) => {
      const normalizedArtist = this.normalizeText(this.cleanArtist(artist));
      return normalizedArtist.length >= 3 && normalizedTitle.includes(normalizedArtist);
    });
  }

  normalizeSource(value) {
    const source = String(value || "").trim().toLowerCase();
    return SOURCE_SCORES[source] ? source : "related";
  }

  getSourceScore(source) {
    return SOURCE_SCORES[this.normalizeSource(source)] || SOURCE_SCORES.related;
  }

  countSharedValues(left, right) {
    if (!left?.size || !right?.size) {
      return 0;
    }

    let count = 0;

    for (const value of left) {
      if (right.has(value)) {
        count += 1;
      }
    }

    return count;
  }

  tokenizeTitle(value) {
    return new Set(
      this.normalizeText(value)
        .split(" ")
        .filter((token) => token.length > 2 && !TITLE_TOKEN_STOP_WORDS.has(token))
    );
  }

  isBlockedTitle(title) {
    const value = String(title || "").toLowerCase();
    return BANNED_WORDS.some((word) => value.includes(word));
  }

  isSameTitleVariant(title, currentTitles) {
    if (!title || !currentTitles?.size) {
      return false;
    }

    for (const currentTitle of currentTitles) {
      if (title === currentTitle || title.includes(currentTitle) || currentTitle.includes(title)) {
        return true;
      }
    }

    return false;
  }

  getVideoId(track) {
    return (
      this.cleanVideoId(track?.autoplay?.videoId) ||
      this.cleanVideoId(track?.info?.identifier) ||
      this.extractVideoId(track?.info?.uri) ||
      this.extractVideoId(track?.raw?.info?.uri)
    );
  }

  getRawVideoId(track) {
    return this.cleanVideoId(track?.info?.identifier) || this.extractVideoId(track?.info?.uri);
  }

  getAutoplayChainDepth(track) {
    const value = Number(track?.autoplay?.chainDepth);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  cleanVideoId(value) {
    const text = String(value || "").trim();
    return /^[a-zA-Z0-9_-]{11}$/.test(text) ? text : null;
  }

  extractVideoId(value) {
    try {
      const url = new URL(String(value || ""));

      if (url.hostname.includes("youtu.be")) {
        return this.cleanVideoId(url.pathname.split("/").filter(Boolean)[0]);
      }

      return this.cleanVideoId(url.searchParams.get("v"));
    } catch {
      return null;
    }
  }

  cleanTitle(value) {
    return String(value || "")
      .replace(/\[[^\]]*(official|video|audio|visualizer|hd|4k)[^\]]*\]/gi, " ")
      .replace(/\([^)]*(official|video|audio|visualizer|hd|4k)[^)]*\)/gi, " ")
      .replace(/\b(official\s*)?(music\s*)?(video|audio|visualizer)\b/gi, " ")
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

  isAsciiText(value) {
    return /^[\x00-\x7F]*$/.test(String(value || ""));
  }

  normalizeServiceUrl(value) {
    return String(value || DEFAULT_YTMUSIC_AUTOPLAY_URL).replace("://localhost", "://127.0.0.1");
  }

  normalizeStrictArtistTrackCount(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.floor(numeric)) : STRICT_SEED_ARTIST_TRACK_COUNT;
  }
}

module.exports = AutoplayService;
