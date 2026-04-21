class SpotifyService {
  constructor(config) {
    this.clientId = config.spotify.clientId;
    this.clientSecret = config.spotify.clientSecret;
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
      throw new Error(`Spotify API request failed (${response.status}): ${details}`);
    }

    return response.json();
  }

  buildSearchQuery(track) {
    const artists = track.artists.map((artist) => artist.name).join(", ");
    return `${artists} - ${track.name} official audio`;
  }

  async getTrack(url) {
    const parsed = this.parseSpotifyUrl(url);

    if (!parsed || parsed.type !== "track") {
      throw new Error("That Spotify track URL is invalid.");
    }

    const track = await this.request(`/tracks/${parsed.id}`);

    return {
      id: track.id,
      name: track.name,
      artists: track.artists.map((artist) => ({ name: artist.name })),
      duration: track.duration_ms,
      url: track.external_urls.spotify,
      artworkUrl: track.album?.images?.[0]?.url || null,
      searchQuery: this.buildSearchQuery(track)
    };
  }

  async getPlaylist(url) {
    const parsed = this.parseSpotifyUrl(url);

    if (!parsed || parsed.type !== "playlist") {
      throw new Error("That Spotify playlist URL is invalid.");
    }

    const playlist = await this.request(`/playlists/${parsed.id}?fields=name,external_urls,tracks.items(track(name,duration_ms,artists(name),external_urls,album(images),is_local)),tracks.next`);
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

