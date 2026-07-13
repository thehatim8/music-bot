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

  buildSearchQuery(track) {
    const artists = (track.artists || []).map((artist) => artist.name).filter(Boolean).join(", ");
    return artists ? `${artists} - ${track.name} official audio` : `${track.name} official audio`;
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

    const track = await this.request(`/tracks/${parsed.id}`);
    return this.normalizeTrack(track);
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

    // Spotify's Web API returns 404 for all Spotify-generated playlists
    // (Liked Songs, Daily Mix, Discover Weekly, editorial lists) since the
    // November 2024 API restrictions. Their IDs start with "37i9dQZF".
    if (playlistId.startsWith("37i9dQZF")) {
      return new Error(
        "Spotify blocks bots from reading its auto-generated playlists (Liked Songs, Daily Mix, Discover Weekly, etc.). " +
          "Copy the songs into a regular playlist (select all → Add to playlist), make it public, and share that link instead."
      );
    }

    return new Error("I couldn't find that Spotify playlist. It may be private or deleted — make it public and try again.");
  }

  // Reads every page of a playlist's tracks. Deliberately does NOT use the `fields`
  // filter: the filtered form of the playlist endpoint has been observed to return an
  // empty `items` array for playlists the API otherwise serves fine. The unfiltered
  // payload is larger but is the documented, reliable shape. `market` is also left off
  // on purpose — with a market set, Spotify nulls out items unavailable there, which
  // would silently drop tracks.
  async getPlaylistTracks(playlistId) {
    const tracks = [];
    const dropped = { nullTrack: 0, local: 0, notASong: 0, unusable: 0 };
    let itemsSeen = 0;
    let total = null;
    let next = `/playlists/${playlistId}/tracks?limit=100&offset=0&additional_types=track`;

    while (next) {
      const page = await this.request(next);
      const items = Array.isArray(page.items) ? page.items : [];

      if (typeof page.total === "number") {
        total = page.total;
      }

      itemsSeen += items.length;

      for (const item of items) {
        const track = item?.track;

        if (!track) {
          // Spotify sends `null` for tracks it can't serve to this request
          // (region-locked or removed from the catalogue).
          dropped.nullTrack += 1;
          continue;
        }

        if (track.is_local) {
          dropped.local += 1;
          continue;
        }

        if (track.type && track.type !== "track") {
          dropped.notASong += 1;
          continue;
        }

        if (!track.name) {
          dropped.unusable += 1;
          continue;
        }

        tracks.push(this.normalizeTrack(track));
      }

      next = page.next || null;
    }

    return { tracks, stats: { total, itemsSeen, dropped } };
  }

  async getPlaylist(url) {
    const parsed = this.parseSpotifyUrl(url);

    if (!parsed || parsed.type !== "playlist") {
      throw new Error("That Spotify playlist URL is invalid.");
    }

    let playlist;
    try {
      playlist = await this.request(`/playlists/${parsed.id}?fields=name,external_urls,tracks.total`);
    } catch (error) {
      throw this.translatePlaylistError(error, parsed.id);
    }

    let result;
    try {
      result = await this.getPlaylistTracks(parsed.id);
    } catch (error) {
      throw this.translatePlaylistError(error, parsed.id);
    }

    return {
      name: playlist.name,
      url: playlist.external_urls?.spotify || url,
      tracks: result.tracks,
      stats: {
        ...result.stats,
        total: result.stats.total ?? playlist.tracks?.total ?? null
      }
    };
  }
}

module.exports = SpotifyService;

