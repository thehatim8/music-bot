// Diagnoses what Spotify actually returns for a playlist, using the bot's own
// credentials. Run it on the machine that holds .env:
//
//   node scripts/diagnose-spotify.js https://open.spotify.com/playlist/<id>
//
// It prints the raw shape of each request so an empty playlist can be traced to
// its real cause (private playlist, region-locked tracks, local files, or an API
// change) instead of being guessed at.

const config = require("../utils/config");
const SpotifyService = require("../music/SpotifyService");

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error("Usage: node scripts/diagnose-spotify.js <spotify playlist url>");
    process.exit(1);
  }

  const spotify = new SpotifyService(config);
  const parsed = spotify.parseSpotifyUrl(url);

  if (!parsed || parsed.type !== "playlist") {
    console.error(`Not a Spotify playlist URL: ${url}`);
    process.exit(1);
  }

  console.log(`Playlist id: ${parsed.id}`);
  console.log(`Client id:   ${String(config.spotify.clientId).slice(0, 6)}... (market: ${config.spotify.market})\n`);

  await report("1. Playlist metadata", () => spotify.request(`/playlists/${parsed.id}?fields=name,public,collaborative,owner(display_name),tracks.total`));

  await report("2. Tracks endpoint (what the bot now uses)", async () => {
    const page = await spotify.request(`/playlists/${parsed.id}/tracks?limit=5&offset=0&additional_types=track`);
    return {
      total: page.total,
      itemsReturned: Array.isArray(page.items) ? page.items.length : "items missing",
      hasNextPage: Boolean(page.next),
      firstItems: (page.items || []).slice(0, 5).map((item) => ({
        track: item?.track ? `${item.track.name} — ${(item.track.artists || []).map((a) => a.name).join(", ")}` : null,
        isLocal: item?.track?.is_local ?? null,
        type: item?.track?.type ?? null
      }))
    };
  });

  await report("3. Old field-filtered query (the suspected culprit)", async () => {
    const data = await spotify.request(
      `/playlists/${parsed.id}?fields=name,external_urls,tracks.items(track(name,duration_ms,artists(name),external_urls,album(images),is_local)),tracks.next`
    );
    return {
      name: data.name,
      itemsReturned: Array.isArray(data.tracks?.items) ? data.tracks.items.length : "items missing"
    };
  });

  await report("4. Full parse via the bot's getPlaylist()", async () => {
    const playlist = await spotify.getPlaylist(url);
    return {
      name: playlist.name,
      usableTracks: playlist.tracks.length,
      stats: playlist.stats,
      sample: playlist.tracks.slice(0, 3).map((track) => track.searchQuery)
    };
  });
}

async function report(label, run) {
  console.log(`--- ${label} ---`);

  try {
    console.log(JSON.stringify(await run(), null, 2), "\n");
  } catch (error) {
    console.log(`FAILED: ${error.message}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
