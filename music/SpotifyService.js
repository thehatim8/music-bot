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
    const artists = track.artists.map((artist) => artist.name).join(", ");
    return `${artists} - ${track.name} official audio`;
  }

  normalizeTrack(track) {
    return {
      id: track.id,
      name: track.name,
      artists: track.artists.map((artist) => ({ name: artist.name })),
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

  async getPlaylist(url) {
    const parsed = this.parseSpotifyUrl(url);

    if (!parsed || parsed.type !== "playlist") {
      throw new Error("That Spotify playlist URL is invalid.");
    }

    let playlist;
    try {
      playlist = await this.request(`/playlists/${parsed.id}?fields=name,external_urls,tracks.items(track(name,duration_ms,artists(name),external_urls,album(images),is_local)),tracks.next`);
    } catch (error) {
      if (error.status === 404) {
        // Spotify's Web API returns 404 for all Spotify-generated playlists
        // (Liked Songs, Daily Mix, Discover Weekly, editorial lists) since the
        // November 2024 API restrictions. Their IDs start with "37i9dQZF".
        if (parsed.id.startsWith("37i9dQZF")) {
          throw new Error(
            "Spotify blocks bots from reading its auto-generated playlists (Liked Songs, Daily Mix, Discover Weekly, etc.). " +
              "Copy the songs into a regular playlist (select all → Add to playlist), make it public, and share that link instead."
          );
        }

        throw new Error("I couldn't find that Spotify playlist. It may be private or deleted — make it public and try again.");
      }

      throw error;
    }
    const tracks = [];

    let currentPage = playlist.tracks;
    while (currentPage) {
      for (const item of currentPage.items) {
        const track = item.track;

        if (!track || track.is_local) {
          continue;
        }

        tracks.push({
          id: track.id,
          name: track.name,
          artists: track.artists.map((artist) => ({ name: artist.name })),
          duration: track.duration_ms,
          url: track.external_urls.spotify,
          artworkUrl: track.album?.images?.[0]?.url || null,
          searchQuery: this.buildSearchQuery(track)
        });
      }

      if (!currentPage.next) {
        break;
      }

      currentPage = await this.request(currentPage.next);
    }

    return {
      name: playlist.name,
      url: playlist.external_urls?.spotify || url,
      tracks
    };
  }
}

module.exports = SpotifyService;

