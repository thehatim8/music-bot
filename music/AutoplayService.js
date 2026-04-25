const DEFAULT_YTMUSIC_AUTOPLAY_URL = "http://127.0.0.1:8765";
const REQUEST_TIMEOUT_MS = 3500;
const DIRECT_RESOLVE_LIMIT = 10;
const FALLBACK_SEARCH_LIMIT = 8;

const BLOCKED_TITLE_PATTERN = /\b(lyrics?|slowed|reverb|8d|sped\s*up|cover|remix|mix)\b/i;

class AutoplayService {
  constructor(musicService) {
    this.music = musicService;
    this.client = musicService.client;
    this.serviceUrl = this.client.config.ytmusicAutoplay?.url || DEFAULT_YTMUSIC_AUTOPLAY_URL;
  }

  async resolve(referenceTrack, requester, excludedTracks = []) {
    const context = this.buildContext(referenceTrack, excludedTracks);
    const seedVideoId = this.getVideoId(referenceTrack);

    if (seedVideoId) {
      const candidates = await this.fetchYouTubeMusicCandidates(seedVideoId).catch((error) => {
        console.warn(`YouTube Music autoplay service failed: ${error.message}`);
        return [];
      });
      const orderedCandidates = this.weightedCandidateOrder(this.filterCandidates(candidates, context).slice(0, DIRECT_RESOLVE_LIMIT));

      for (const candidate of orderedCandidates) {
        const track = await this.resolveDirectVideo(candidate, requester, context).catch(() => null);

        if (track) {
          return track;
        }
      }
    }

    return this.resolveYouTubeSearchFallback(referenceTrack, requester, context);
  }

  buildContext(referenceTrack, excludedTracks) {
    const tracks = [referenceTrack, ...excludedTracks].filter(Boolean);
    const recentTracks = tracks.slice(-20);
    const videoIds = new Set();
    const fingerprints = new Set();

    for (const track of tracks) {
      const videoId = this.getVideoId(track);
      if (videoId) {
        videoIds.add(videoId);
      }

      const fingerprint = this.buildTrackFingerprint(track);
      if (fingerprint) {
        fingerprints.add(fingerprint);
      }
    }

    return {
      referenceTrack,
      videoIds,
      fingerprints,
      recentVideoIds: new Set(recentTracks.map((track) => this.getVideoId(track)).filter(Boolean)),
      referenceFingerprint: this.buildTrackFingerprint(referenceTrack),
      referenceTitle: this.normalizeTitle(referenceTrack?.info?.title),
      referenceArtist: this.normalizeArtist(referenceTrack?.info?.author),
      referenceScript: this.detectScriptBucket(`${referenceTrack?.info?.author || ""} ${referenceTrack?.info?.title || ""}`)
    };
  }

  async fetchYouTubeMusicCandidates(videoId) {
    const url = new URL("/related", this.serviceUrl);
    url.searchParams.set("videoId", videoId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      return Array.isArray(payload.tracks) ? payload.tracks : [];
    } finally {
      clearTimeout(timeout);
    }
  }

  filterCandidates(candidates, context) {
    const seenVideoIds = new Set();
    const seenFingerprints = new Set();
    const filtered = [];

    for (const candidate of candidates) {
      const normalized = this.normalizeCandidate(candidate);

      if (!normalized || seenVideoIds.has(normalized.videoId)) {
        continue;
      }

      seenVideoIds.add(normalized.videoId);

      if (!this.isAllowedCandidate(normalized, context)) {
        continue;
      }

      if (seenFingerprints.has(normalized.fingerprint)) {
        continue;
      }

      seenFingerprints.add(normalized.fingerprint);
      filtered.push(normalized);
    }

    return filtered;
  }

  normalizeCandidate(candidate) {
    const videoId = this.cleanVideoId(candidate?.videoId);
    const title = String(candidate?.title || "").trim();
    const artist = String(candidate?.artist || "").trim();

    if (!videoId || !title) {
      return null;
    }

    return {
      videoId,
      title,
      artist,
      fingerprint: this.buildFingerprint(artist, title),
      script: this.detectScriptBucket(`${artist} ${title}`)
    };
  }

  isAllowedCandidate(candidate, context) {
    if (context.videoIds.has(candidate.videoId) || context.recentVideoIds.has(candidate.videoId)) {
      return false;
    }

    if (this.isBlockedTitle(candidate.title)) {
      return false;
    }

    if (!candidate.fingerprint || context.fingerprints.has(candidate.fingerprint)) {
      return false;
    }

    if (this.isScriptMismatch(candidate.script, context.referenceScript)) {
      return false;
    }

    return !this.isSameSongVariant(candidate, context);
  }

  async resolveDirectVideo(candidate, requester, context) {
    const node = this.client.playerManager.getSearchNode();
    const result = await node.rest.resolve(`https://www.youtube.com/watch?v=${candidate.videoId}`);
    const rawTrack = this.pickResolvedTrack(this.music.getLavalinkTracks(result), candidate, context);

    if (!rawTrack) {
      return null;
    }

    const track = this.music.createQueueTrack(rawTrack, requester, "Autoplay");
    track.autoplay = {
      videoId: candidate.videoId,
      source: "ytmusic",
      rank: candidate.rank
    };
    return track;
  }

  pickResolvedTrack(rawTracks, candidate, context) {
    return rawTracks.find((track) => {
      if (!track?.encoded || this.isExcludedRawTrack(track, context)) {
        return false;
      }

      const videoId = this.cleanVideoId(track.info?.identifier);
      if (videoId && videoId !== candidate.videoId) {
        return false;
      }

      return !this.isBlockedTitle(track.info?.title);
    }) || null;
  }

  weightedCandidateOrder(candidates) {
    const pool = candidates.map((candidate, index) => ({
      candidate: {
        ...candidate,
        rank: index + 1
      },
      weight: Math.max(1, candidates.length - index)
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

  async resolveYouTubeSearchFallback(referenceTrack, requester, context) {
    const node = this.client.playerManager.getSearchNode();
    const candidates = [];

    for (const query of this.buildFallbackQueries(referenceTrack)) {
      const result = await node.rest.resolve(`ytsearch:${query}`).catch(() => null);
      const rawTracks = this.music.getLavalinkTracks(result).slice(0, FALLBACK_SEARCH_LIMIT);

      for (let index = 0; index < rawTracks.length; index += 1) {
        const rawTrack = rawTracks[index];
        if (!rawTrack?.encoded || this.isExcludedRawTrack(rawTrack, context) || this.isBlockedTitle(rawTrack.info?.title)) {
          continue;
        }

        const fingerprint = this.buildRawTrackFingerprint(rawTrack);
        if (!fingerprint || context.fingerprints.has(fingerprint)) {
          continue;
        }

        if (this.isScriptMismatch(this.detectScriptBucket(`${rawTrack.info?.author || ""} ${rawTrack.info?.title || ""}`), context.referenceScript)) {
          continue;
        }

        candidates.push({
          rawTrack,
          weight: Math.max(1, FALLBACK_SEARCH_LIMIT - index)
        });
      }

      if (candidates.length > 0) {
        break;
      }
    }

    const selected = this.weightedRawTrack(candidates.slice(0, 5));
    if (!selected) {
      throw new Error("I could not find a similar song for autoplay.");
    }

    return this.music.createQueueTrack(selected, requester, "Autoplay");
  }

  weightedRawTrack(candidates) {
    if (candidates.length === 0) {
      return null;
    }

    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.random() * totalWeight;

    for (const item of candidates) {
      cursor -= item.weight;
      if (cursor <= 0) {
        return item.rawTrack;
      }
    }

    return candidates[0].rawTrack;
  }

  buildFallbackQueries(referenceTrack) {
    const title = this.cleanTitle(referenceTrack?.info?.title);
    const artist = this.cleanArtist(referenceTrack?.info?.author);

    return [
      [artist, title, "similar songs"].filter(Boolean).join(" "),
      [artist, "songs"].filter(Boolean).join(" "),
      [title, "similar songs"].filter(Boolean).join(" ")
    ].filter(Boolean);
  }

  isExcludedRawTrack(rawTrack, context) {
    const videoId = this.cleanVideoId(rawTrack?.info?.identifier);
    if (videoId && context.videoIds.has(videoId)) {
      return true;
    }

    const uriVideoId = this.extractVideoId(rawTrack?.info?.uri);
    if (uriVideoId && context.videoIds.has(uriVideoId)) {
      return true;
    }

    const fingerprint = this.buildRawTrackFingerprint(rawTrack);
    return Boolean(fingerprint && context.fingerprints.has(fingerprint));
  }

  isSameSongVariant(candidate, context) {
    if (!context.referenceTitle) {
      return false;
    }

    const candidateTitle = this.normalizeBaseTitle(candidate.title);
    const referenceTitle = this.normalizeBaseTitle(context.referenceTrack?.info?.title);
    const titleSimilarity = this.textSimilarity(candidateTitle, referenceTitle);
    const artistSimilarity = this.textSimilarity(this.normalizeArtist(candidate.artist), context.referenceArtist);

    if (candidateTitle && referenceTitle && candidateTitle === referenceTitle) {
      return true;
    }

    if (Math.min(candidateTitle.length, referenceTitle.length) >= 8) {
      const containsTitle = candidateTitle.includes(referenceTitle) || referenceTitle.includes(candidateTitle);
      if (containsTitle && artistSimilarity >= 0.55) {
        return true;
      }
    }

    return titleSimilarity >= 0.86 && artistSimilarity >= 0.72;
  }

  isScriptMismatch(candidateScript, referenceScript) {
    if (!candidateScript || !referenceScript || candidateScript === "other" || referenceScript === "other") {
      return false;
    }

    return candidateScript !== referenceScript;
  }

  isBlockedTitle(title) {
    return BLOCKED_TITLE_PATTERN.test(String(title || ""));
  }

  getVideoId(track) {
    return (
      this.cleanVideoId(track?.autoplay?.videoId) ||
      this.cleanVideoId(track?.info?.identifier) ||
      this.extractVideoId(track?.info?.uri) ||
      this.extractVideoId(track?.raw?.info?.uri)
    );
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

  buildTrackFingerprint(track) {
    return this.buildFingerprint(track?.info?.author, track?.info?.title);
  }

  buildRawTrackFingerprint(rawTrack) {
    return this.buildFingerprint(rawTrack?.info?.author, rawTrack?.info?.title);
  }

  buildFingerprint(artist, title) {
    const normalizedArtist = this.normalizeArtist(artist);
    const normalizedTitle = this.normalizeTitle(title);
    return normalizedArtist && normalizedTitle ? `${normalizedArtist}:${normalizedTitle}` : null;
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

  normalizeBaseTitle(value) {
    return this.normalizeText(
      this.cleanTitle(value)
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\b(live|acoustic|version|remaster(?:ed)?|radio edit|edit)\b/gi, " ")
    );
  }

  normalizeArtist(value) {
    return this.normalizeText(this.cleanArtist(value));
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

  textSimilarity(leftValue, rightValue) {
    const left = this.normalizeText(leftValue);
    const right = this.normalizeText(rightValue);

    if (!left || !right) {
      return 0;
    }

    if (left === right) {
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

  detectScriptBucket(value) {
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
}

module.exports = AutoplayService;
