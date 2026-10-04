import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import yt_dlp
from ytmusicapi import YTMusic


WATCH_LIMIT = 40
MAX_RESULTS = 25
SEARCH_LIMIT = 12
ARTIST_SEARCH_LIMIT = 18

# yt-dlp audio player. Lavalink plays /audio?videoId=... as a plain HTTP source and
# this service fetches the real YouTube stream, so Lavalink's YouTube plugin isn't needed.
STREAM_CACHE_TTL = 60 * 60
STREAM_CHUNK_SIZE = 2 * 1024 * 1024
UPSTREAM_TIMEOUT = 20
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
CONTENT_TYPES = {"webm": "audio/webm", "m4a": "audio/mp4", "mp4": "audio/mp4"}

YDL_OPTIONS = {
    "format": "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/best",
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    # YouTube's player challenges need a JS runtime; node is already installed for the bot.
    "js_runtimes": {"deno": {"path": None}, "node": {"path": None}},
}

if os.getenv("YTDLP_COOKIES"):
    YDL_OPTIONS["cookiefile"] = os.getenv("YTDLP_COOKIES")

ytmusic = YTMusic()
stream_cache = {}
stream_locks = {}
stream_locks_guard = threading.Lock()


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
    thumbnails = item.get("thumbnails") or []
    duration = item.get("duration_seconds")

    return {
        "videoId": video_id,
        "title": title,
        "artist": artists[0]["name"] if artists else artist_name(item),
        "artists": artists,
        "durationMs": int(duration) * 1000 if isinstance(duration, (int, float)) else None,
        "artworkUrl": thumbnails[-1].get("url") if thumbnails and isinstance(thumbnails[-1], dict) else None,
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


def stream_lock(video_id):
    with stream_locks_guard:
        return stream_locks.setdefault(video_id, threading.Lock())


def upstream_request(stream, start, end=None):
    headers = dict(stream["headers"])
    headers["Range"] = f"bytes={start}-{'' if end is None else end}"
    request = urllib.request.Request(stream["url"], headers=headers)
    return urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT)


def extract_stream(video_id):
    with yt_dlp.YoutubeDL(YDL_OPTIONS) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)

    if not info.get("url"):
        raise RuntimeError("yt-dlp returned no audio URL")

    stream = {
        "url": info["url"],
        "headers": info.get("http_headers") or {},
        "ext": info.get("ext") or "webm",
        "size": info.get("filesize"),
        "title": info.get("track") or info.get("title") or "",
        "artist": info.get("artist") or info.get("uploader") or "",
        "durationMs": int(info["duration"] * 1000) if info.get("duration") else None,
        "artworkUrl": info.get("thumbnail"),
        "isLive": bool(info.get("is_live")),
        "expires": time.time() + STREAM_CACHE_TTL,
    }

    if not stream["size"]:
        with upstream_request(stream, 0, 0) as response:
            content_range = response.headers.get("Content-Range") or ""
            stream["size"] = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range else None

    return stream


def get_stream(video_id, refresh=False):
    with stream_lock(video_id):
        cached = stream_cache.get(video_id)
        if cached and not refresh and cached["expires"] > time.time():
            return cached

        stream = extract_stream(video_id)
        stream_cache[video_id] = stream
        return stream


def parse_range(header, size):
    match = re.match(r"bytes=(\d*)-(\d*)", header or "")
    if not match or (not match.group(1) and not match.group(2)):
        return None

    if not match.group(1):
        start = max(0, size - int(match.group(2)))
        return start, size - 1

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else size - 1
    return start, min(end, size - 1)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_HEAD(self):
        self.handle_audio(send_body=False)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/audio":
            self.handle_audio(send_body=True)
            return

        if parsed.path == "/info":
            video_id = parse_qs(parsed.query).get("videoId", [""])[0].strip()
            if not VIDEO_ID_PATTERN.match(video_id):
                self.send_json(400, {"error": "valid videoId is required"})
                return

            try:
                stream = get_stream(video_id)
            except Exception as error:
                self.send_json(502, {"error": str(error) or "yt-dlp failed"})
                return

            self.send_json(200, {
                "videoId": video_id,
                "title": stream["title"],
                "artist": stream["artist"],
                "durationMs": stream["durationMs"],
                "artworkUrl": stream["artworkUrl"],
                "isLive": stream["isLive"],
            })
            return

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

    # Serves the YouTube audio with Range support so Lavalink can seek. The upstream is
    # read in chunks because googlevideo throttles or drops large single requests.
    def handle_audio(self, send_body):
        parsed = urlparse(self.path)
        if parsed.path != "/audio":
            self.send_json(404, {"error": "not found"})
            return

        video_id = parse_qs(parsed.query).get("videoId", [""])[0].strip()
        if not VIDEO_ID_PATTERN.match(video_id):
            self.send_json(400, {"error": "valid videoId is required"})
            return

        try:
            stream = get_stream(video_id)
        except Exception as error:
            print(f"yt-dlp failed for {video_id}: {error}", flush=True)
            self.send_json(502, {"error": str(error) or "yt-dlp failed"})
            return

        size = stream["size"]
        if not size:
            self.send_json(502, {"error": "unknown stream size"})
            return

        byte_range = parse_range(self.headers.get("Range"), size)
        if byte_range and byte_range[0] >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        start, end = byte_range or (0, size - 1)
        self.send_response(206 if byte_range else 200)
        self.send_header("Content-Type", CONTENT_TYPES.get(stream["ext"], "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if byte_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if not send_body:
            return

        position = start
        refreshed = False

        try:
            while position <= end:
                chunk_end = min(position + STREAM_CHUNK_SIZE - 1, end)
                chunk_start = position
                try:
                    with upstream_request(stream, position, chunk_end) as response:
                        while True:
                            data = response.read(64 * 1024)
                            if not data:
                                break
                            self.wfile.write(data)
                            position += len(data)
                except urllib.error.HTTPError as error:
                    # The signed URL expired or was revoked; extract a fresh one once.
                    if error.code in (403, 410) and not refreshed:
                        refreshed = True
                        stream = get_stream(video_id, refresh=True)
                        continue
                    raise

                # A short read just resumes from where it stopped; no data at all is fatal.
                if position == chunk_start:
                    raise RuntimeError("upstream returned no data")
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            print(f"Audio stream for {video_id} stopped at byte {position}: {error}", flush=True)
            self.close_connection = True

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
