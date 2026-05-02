import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ytmusicapi import YTMusic


WATCH_LIMIT = 40
MAX_RESULTS = 25
SEARCH_LIMIT = 12
ARTIST_SEARCH_LIMIT = 18

ytmusic = YTMusic()


def normalize_artist_entry(artist):
    if isinstance(artist, dict):
        name = str(artist.get("name") or "").strip()
        artist_id = str(artist.get("id") or artist.get("browseId") or "").strip()
        if name:
            payload = {"name": name}
            if artist_id:
                payload["id"] = artist_id
            return payload

    if isinstance(artist, str):
        name = artist.strip()
        if name:
            return {"name": name}

    return None


def artist_entries(item):
    artists = item.get("artists")
    output = []
    seen = set()

    if isinstance(artists, list):
        for artist in artists:
            entry = normalize_artist_entry(artist)
            if not entry:
                continue

            key = entry["name"].casefold()
            if key in seen:
                continue

            seen.add(key)
            output.append(entry)

    if output:
        return output

    fallback = item.get("artist")
    if isinstance(fallback, str) and fallback.strip():
        return [{"name": fallback.strip()}]

    byline = item.get("byline")
    if isinstance(byline, str) and byline:
        name = byline.split(" \u2022 ", 1)[0].strip()
        if name:
            return [{"name": name}]

    return []


def artist_name(item):
    artists = artist_entries(item)
    return artists[0]["name"] if artists else ""


def artist_ids(item):
    return [
        artist["id"]
        for artist in artist_entries(item)
        if artist.get("id")
    ]


def normalize_track(item, source):
    if not isinstance(item, dict):
        return None

    video_id = item.get("videoId")
    title = item.get("title")

    if not video_id or not title:
        return None

    artists = artist_entries(item)

    return {
        "videoId": video_id,
        "title": title,
        "artist": artists[0]["name"] if artists else artist_name(item),
        "artists": artists,
        "source": source
    }


def add_tracks(output, seen, items, source, predicate=None):
    for item in items or []:
        if predicate and not predicate(item):
            continue

        track = normalize_track(item, source)
        if not track or track["videoId"] in seen:
            continue

        seen.add(track["videoId"])
        output.append(track)

        if len(output) >= MAX_RESULTS:
            break


def related_browse_id(watch):
    value = watch.get("related") or watch.get("relatedBrowseId") or watch.get("related_browse_id")
    if isinstance(value, dict):
        return value.get("browseId") or value.get("id")
    return value if isinstance(value, str) else None


def related_tracks(browse_id):
    if not browse_id:
        return []

    try:
        sections = ytmusic.get_song_related(browse_id)
    except Exception:
        return []

    tracks = []

    for section in sections or []:
        if isinstance(section, dict):
            tracks.extend(section.get("contents") or [])

    return tracks


def artist_tracks(artist_id):
    if not artist_id:
        return []

    try:
        artist = ytmusic.get_artist(artist_id) or {}
    except Exception:
        return []

    tracks = []

    for key in ("songs", "videos"):
        section = artist.get(key)
        if isinstance(section, dict):
            tracks.extend(section.get("results") or [])
        elif isinstance(section, list):
            tracks.extend(section)

    return tracks


def search_song_results(query, limit=SEARCH_LIMIT):
    try:
        return ytmusic.search(query, filter="songs", limit=limit) or []
    except Exception:
        return []


def get_recommendations(video_id):
    seen = set()
    output = []
    watch = ytmusic.get_watch_playlist(videoId=video_id, limit=WATCH_LIMIT)
    watch_tracks = watch.get("tracks") or []
    seed_track = next((item for item in watch_tracks if item.get("videoId") == video_id), None)
    seed_track = seed_track or (watch_tracks[0] if watch_tracks else {})
    seed_artists = artist_entries(seed_track)
    seed_artist_name = seed_artists[0]["name"] if seed_artists else ""
    seed_artist_ids = list(dict.fromkeys(artist_ids(seed_track)))
    related = related_tracks(related_browse_id(watch))

    def same_artist(item):
        item_artist_ids = set(artist_ids(item))
        return bool(item_artist_ids.intersection(seed_artist_ids)) if seed_artist_ids else False

    add_tracks(output, seen, watch_tracks, "watch", predicate=same_artist)

    for artist_id in seed_artist_ids:
        add_tracks(output, seen, artist_tracks(artist_id), "artist")
        if len(output) >= MAX_RESULTS:
            return output[:MAX_RESULTS]

    if seed_artist_name:
        add_tracks(output, seen, search_song_results(f"{seed_artist_name} songs", ARTIST_SEARCH_LIMIT), "artist")
        if len(output) >= MAX_RESULTS:
            return output[:MAX_RESULTS]

    add_tracks(output, seen, related, "related", predicate=same_artist)
    add_tracks(output, seen, watch_tracks, "watch")
    add_tracks(output, seen, related, "related")
    return output[:MAX_RESULTS]


def get_search_results(query):
    results = search_song_results(query, SEARCH_LIMIT)
    output = []
    seen = set()
    add_tracks(output, seen, results, "search")
    return output[:SEARCH_LIMIT]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/search":
            query = parse_qs(parsed.query).get("q", [""])[0].strip()
            if not query:
                self.send_json(400, {"error": "q is required"})
                return

            try:
                self.send_json(200, {"tracks": get_search_results(query)})
            except Exception as error:
                self.send_json(500, {"error": str(error) or "ytmusicapi search failed"})
            return

        if parsed.path != "/related":
            self.send_json(404, {"error": "not found"})
            return

        video_id = parse_qs(parsed.query).get("videoId", [""])[0].strip()
        if not video_id:
            self.send_json(400, {"error": "videoId is required"})
            return

        try:
            self.send_json(200, {"tracks": get_recommendations(video_id)})
        except Exception as error:
            self.send_json(500, {"error": str(error) or "ytmusicapi request failed"})

    def log_message(self, format, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    host = os.getenv("YTMUSIC_AUTOPLAY_HOST", "127.0.0.1")
    port = int(os.getenv("YTMUSIC_AUTOPLAY_PORT", "3001"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ytmusic autoplay service listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
