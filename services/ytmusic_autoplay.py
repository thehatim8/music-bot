import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from ytmusicapi import YTMusic


WATCH_LIMIT = 25
MAX_RESULTS = 15
MIN_RESULTS_BEFORE_FALLBACK = 10

ytmusic = YTMusic()


def artist_name(item):
    artists = item.get("artists")
    if isinstance(artists, list) and artists:
        first = artists[0]
        if isinstance(first, dict) and first.get("name"):
            return first["name"]

    if item.get("artist"):
        return item["artist"]

    byline = item.get("byline")
    if isinstance(byline, str) and byline:
        return byline.split(" \u2022 ", 1)[0].strip()

    return ""


def artist_ids(item):
    artists = item.get("artists")
    if not isinstance(artists, list):
        return []

    return [
        artist.get("id")
        for artist in artists
        if isinstance(artist, dict) and artist.get("id")
    ]


def normalize_track(item):
    if not isinstance(item, dict):
        return None

    video_id = item.get("videoId")
    title = item.get("title")

    if not video_id or not title:
        return None

    return {
        "videoId": video_id,
        "title": title,
        "artist": artist_name(item)
    }


def add_tracks(output, seen, items):
    for item in items or []:
        track = normalize_track(item)
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


def get_recommendations(video_id):
    seen = set()
    output = []
    watch = ytmusic.get_watch_playlist(videoId=video_id, limit=WATCH_LIMIT)
    watch_tracks = watch.get("tracks") or []

    add_tracks(output, seen, watch_tracks)

    if len(output) < MIN_RESULTS_BEFORE_FALLBACK:
        add_tracks(output, seen, related_tracks(related_browse_id(watch)))

    if len(output) < MIN_RESULTS_BEFORE_FALLBACK:
        ids = []
        for item in watch_tracks:
            ids.extend(artist_ids(item))

        for artist_id in dict.fromkeys(ids):
            add_tracks(output, seen, artist_tracks(artist_id))
            if len(output) >= MIN_RESULTS_BEFORE_FALLBACK:
                break

    return output[:MAX_RESULTS]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
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
