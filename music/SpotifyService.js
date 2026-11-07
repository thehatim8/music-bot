// Spotify's public embed page (what Discord and websites use to show a playlist widget)
// still lists a playlist's songs. The Web API stopped doing that for Development Mode
// apps in Feb 2026: GET /playlists/{id}/tracks was removed, and its replacement /items
// only returns songs for playlists the app's own user owns. The embed lists at most
// the first 100 songs.
const EMBED_BASE_URL = "https://open.spotify.com/embed";
const EMBED_TRACK_LIMIT = 100;
const EMBED_TIMEOUT_MS = 15000;
const EMBED_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

class SpotifyService {
  constructor(config) {
    this.clientId = config.spotify.clientId;
    this.clientSecret = config.spotify.clientSecret;
    this.market = config.spotify.market || null;
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  parseSpotifyUrl(input) {
    try {
      const url = new URL(input);
      const host = url.hostname.replace(/^www\./, "");

      if (host !== "open.spotify.com") {
        return null;
      }

      const segments = url.pathname.split("/").filter(Boolean);
      const typeIndex = segments.findIndex((segment) => ["track", "playlist"].includes(segment));

      if (typeIndex === -1 || !segments[typeIndex + 1]) {
        return null;
      }

      return {
        type: segments[typeIndex],
        id: segments[typeIndex + 1]
      };
    } catch {
      return null;
    }
  }

  async getAccessToken() {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Spotify token request failed (${response.status}): ${details}`);
    }

    const data = await response.json();
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.cachedToken;
  }

  async request(pathOrUrl, isRetry = false) {
    const token = await this.getAccessToken();
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 401 && !isRetry) {
      this.cachedToken = null;
      this.tokenExpiresAt = 0;
      return this.request(pathOrUrl, true);
    }

    if (!response.ok) {
      const details = await response.text();
      const error = new Error(`Spotify API request failed (${response.status}): ${details}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  // Audio is searched on SoundCloud, whose fuzzy search matches on any word. A
  // YouTube-style "official audio" suffix made it return unrelated uploads that
  // happen to have "(Official Audio)" in their title, so search on artist + title only.
  buildSearchQuery(track) {
    const artists = (track.artists || []).map((artist) => artist.name).filter(Boolean).join(" ");
    return artists ? `${artists} ${track.name}` : track.name;
  }

  normalizeTrack(track) {
    return {
      id: track.id,
      name: track.name,
      artists: (track.artists || []).map((artist) => ({ name: artist.name })),
      duration: track.duration_ms,
      url: track.external_urls?.spotify || null,
      artworkUrl: track.album?.images?.[0]?.url || null,
      searchQuery: this.buildSearchQuery(track)
    };
  }

  async getTrack(url) {
    const parsed = this.parseSpotifyUrl(url);

    if (!parsed || parsed.type !== "track") {
      throw new Error("That Spotify track URL is invalid.");
    }

    try {
      const track = await this.request(`/tracks/${parsed.id}`);
      return this.normalizeTrack(track);
    } catch (apiError) {
      // The API refuses some requests (e.g. 403 when the app loses access); the embed
      // page carries the same title, artists and length.
      const entity = await this.fetchEmbedEntity("track", parsed.id).catch(() => null);

      if (!entity?.name) {
        throw apiError;
      }

      return this.normalizeEmbedTrack(entity, (entity.artists || []).map((artist) => artist.name));
    }
  }

  // Returns the `entity` object from an embed page, or throws with status 404 when
  // Spotify has no such (public) playlist/track.
  async fetchEmbedEntity(type, id) {
    const response = await fetch(`${EMBED_BASE_URL}/${type}/${id}`, {
      headers: {
        "User-Agent": EMBED_USER_AGENT,
        "Accept-Language": "en"
      },
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
    });

    if (!response.ok) {
      const error = new Error(`Spotify embed request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }

    const html = await response.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);

    if (!match) {
      throw new Error("Spotify's embed page changed and the bot can no longer read it.");
    }

    const pageProps = JSON.parse(match[1])?.props?.pageProps;
    const entity = pageProps?.state?.data?.entity;

    if (!entity) {
      const error = new Error(`Spotify embed has no ${type} ${id} (status ${pageProps?.status ?? "unknown"}).`);
      error.status = 404;
      throw error;
    }

    return entity;
  }

  normalizeEmbedTrack(entity, artistNames) {
    const id = entity.id || String(entity.uri || "").split(":").pop() || null;
    const track = {
      name: entity.name || entity.title,
      artists: artistNames.filter(Boolean).map((name) => ({ name })),
      duration_ms: entity.duration,
      external_urls: { spotify: id ? `https://open.spotify.com/track/${id}` : null },
      album: { images: [{ url: entity.visualIdentity?.image?.[0]?.url || null }] }
    };

    return { ...this.normalizeTrack(track), id };
  }

  // Resolves a free-text query to the closest matching Spotify song. This is what
  // lets the bot play only real songs: instead of searching YouTube directly (which
  // returns any video), we first identify the actual track on Spotify.
  async searchTrack(query) {
    const term = String(query || "").trim();

    if (!term) {
      return null;
    }

    const params = new URLSearchParams({ q: term, type: "track", limit: "1" });

    if (this.market) {
      params.set("market", this.market);
    }

    const data = await this.request(`/search?${params.toString()}`);
    const track = data.tracks?.items?.find((item) => item && item.id);

    return track ? this.normalizeTrack(track) : null;
  }

  translatePlaylistError(error, playlistId) {
    if (error.status !== 404) {
      return error;
    }

    // Spotify-made playlists have IDs starting with "37i9dQZF". Editorial ones (Today's
    // Top Hits, All Out 80s) load fine; personal mixes (Daily Mix, Discover Weekly)
    // aren't shared with bots.
    if (playlistId.startsWith("37i9dQZF")) {
      return new Error(
        "Spotify doesn't share personal mixes (Daily Mix, Discover Weekly, etc.) with bots. " +
          "Copy the songs into a regular playlist (select all → Add to playlist), make it public, and share that link instead."
      );
    }

    return new Error("I couldn't find that Spotify playlist. It may be private or deleted — make it public and try again.");
  }

  // Region-locked songs are kept on purpose: the bot only needs their name and artists
  // to find the audio elsewhere.
  async getPlaylist(url) {
    const parsed = this.parseSpotifyUrl(url);

    if (!parsed || parsed.type !== "playlist") {
      throw new Error("That Spotify playlist URL is invalid.");
    }

    let entity;
    try {
      entity = await this.fetchEmbedEntity("playlist", parsed.id);
    } catch (error) {
      throw this.translatePlaylistError(error, parsed.id);
    }

    const items = Array.isArray(entity.trackList) ? entity.trackList : [];
    const tracks = [];
    const dropped = { nullTrack: 0, local: 0, notASong: 0, unusable: 0 };

    for (const item of items) {
      if (!item) {
        dropped.nullTrack += 1;
        continue;
      }

      if (String(item.uri || "").startsWith("spotify:local:")) {
        dropped.local += 1;
        continue;
      }

      if (item.entityType && item.entityType !== "track") {
        dropped.notASong += 1;
        continue;
      }

      if (!item.title) {
        dropped.unusable += 1;
        continue;
      }

      // The embed gives artists as one comma-joined string. Splitting can cut a name
      // like "Earth, Wind & Fire" in two, which still matches since any one artist
      // name matching is enough.
      const artistNames = String(item.subtitle || "").split(/,\s*/);
      tracks.push(this.normalizeEmbedTrack({ ...item, name: item.title }, artistNames));
    }

    return {
      name: entity.name || entity.title || "Spotify playlist",
      url,
      tracks,
      // The embed stops at 100 songs, so a list of exactly 100 is probably cut short.
      limited: items.length >= EMBED_TRACK_LIMIT,
      stats: { total: items.length, itemsSeen: items.length, dropped }
    };
  }
}

module.exports = SpotifyService;

