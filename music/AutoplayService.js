const DEFAULT_YTMUSIC_AUTOPLAY_URL = "http://127.0.0.1:3001";
const REQUEST_TIMEOUT_MS = 3000;

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

    if (!videoId) {
      return this.resolveFallback(referenceTrack, requester, context);
    }

    let tracks;
    try {
      tracks = await this.fetchRelated(videoId);
    } catch (error) {
      console.warn(`YTMusic fetch failed: ${error.message}`);
      return this.resolveFallback(referenceTrack, requester, context);
    }

    const filtered = this.filterTracks(tracks, context);
    if (filtered.length === 0) {
      console.log("YTMusic empty after filter -> fallback");
      return this.resolveFallback(referenceTrack, requester, context);
    }

    const pool = filtered.slice(0, 5);
    const firstPick = pool[Math.floor(Math.random() * pool.length)];
    const ordered = [firstPick, ...pool.filter((track) => track.videoId !== firstPick.videoId), ...filtered.slice(5)];

    for (const candidate of ordered) {
      const track = await this.resolveDirect(candidate, requester, context).catch(() => null);
      if (track) {
        return track;
      }
    }

    throw new Error("YTMusic returned recommendations, but none could be played directly.");
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
        console.log("YTMusic fetch success");
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
      console.warn(`YTMusic fetch failed: ${error.message}`);
      return [];
    });
    const context = this.buildSearchContext(query);
    const filtered = this.filterTracks(tracks, context).slice(0, 5);

    for (const candidate of filtered) {
      const track = await this.resolveDirect(candidate, requester, context).catch(() => null);
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
        const title = track.title.toLowerCase();
        const normalizedTitle = this.normalizeText(track.title);

        if (BANNED_WORDS.some((word) => title.includes(word))) {
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

        const key = `${this.normalizeText(track.artist)}:${normalizedTitle}`;
        if (seen.has(track.videoId) || context.fingerprints.has(key)) {
          return false;
        }

        seen.add(track.videoId);
        return true;
      });
  }

  async resolveDirect(candidate, requester, context) {
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

    const track = this.music.createQueueTrack(rawTrack, requester, "Autoplay");
    track.autoplay = {
      videoId: candidate.videoId,
      source: "ytmusic"
    };
    return track;
  }

  async resolveFallback(referenceTrack, requester, context) {
    const node = this.client.playerManager.getSearchNode();
    const title = this.cleanTitle(referenceTrack?.info?.title);
    const author = this.cleanArtist(referenceTrack?.info?.author);
    const query = [author, title, "official audio"].filter(Boolean).join(" ");

    if (!query) {
      throw new Error("I could not find a similar song for autoplay.");
    }

    const result = await node.rest.resolve(`ytsearch:${query}`);
    const rawTrack = this.music.getLavalinkTracks(result).find((track) => {
      if (!track?.encoded || this.isBlockedTitle(track.info?.title)) {
        return false;
      }

      const videoId = this.getRawVideoId(track);
      return !videoId || (videoId !== context.currentVideoId && !context.history.has(videoId));
    });

    if (!rawTrack) {
      throw new Error("I could not find a similar song for autoplay.");
    }

    return this.music.createQueueTrack(rawTrack, requester, "Autoplay");
  }

  buildContext(referenceTrack, excludedTracks) {
    const tracks = [referenceTrack, ...excludedTracks].filter(Boolean);
    const history = new Set();
    const fingerprints = new Set();

    for (const track of tracks.slice(-20)) {
      const videoId = this.getVideoId(track);
      if (videoId) {
        history.add(videoId);
      }

      const fingerprint = `${this.normalizeText(track.info?.author)}:${this.normalizeText(track.info?.title)}`;
      if (fingerprint !== ":") {
        fingerprints.add(fingerprint);
      }
    }

    const currentVideoId = this.getVideoId(referenceTrack);
    if (currentVideoId) {
      history.add(currentVideoId);
    }

    const currentAuthor = this.normalizeText(this.cleanArtist(referenceTrack?.info?.author));
    const currentTitle = this.normalizeText(this.cleanTitle(referenceTrack?.info?.title));
    const currentTitleWithoutAuthor =
      currentAuthor && currentTitle.startsWith(currentAuthor)
        ? currentTitle.slice(currentAuthor.length).trim()
        : currentTitle;
    const currentTitles = new Set(
      [currentTitle, currentTitleWithoutAuthor]
        .map((title) => title.replace(/^\s*[-:]\s*/, "").trim())
        .filter((title) => title.length >= 6)
    );
    const currentFingerprint = `${currentAuthor}:${currentTitle}`;
    if (currentFingerprint !== ":") {
      fingerprints.add(currentFingerprint);
    }

    return {
      currentVideoId,
      currentRawTitle: referenceTrack?.info?.title || "",
      currentTitles,
      history,
      fingerprints
    };
  }

  buildSearchContext(query) {
    return {
      currentVideoId: null,
      currentRawTitle: query || "",
      currentTitles: new Set(),
      history: new Set(),
      fingerprints: new Set()
    };
  }

  normalizeTrack(track) {
    const videoId = this.cleanVideoId(track?.videoId);
    const title = String(track?.title || "").trim();

    if (!videoId || !title) {
      return null;
    }

    return {
      videoId,
      title,
      artist: String(track?.artist || "").trim()
    };
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
}

module.exports = AutoplayService;
