"""netsdk-viewer: a modern web front end for "netsdk" NVRs (Hiseeu W-NVR K8216-W6 and relatives).

The NVR's own web page needs an ActiveX/Flash plugin for playback, so it is
unusable in current browsers. This server talks to the same interfaces the
NVR's page uses and serves a page that works in any modern browser:

* /netsdk/...            JSON API with HTTP Basic auth (search, status)
* WebSocket on port 10000 recorded video, via the NVR's own JS library
                         (dist/import.js), run in Node by replay.js
* RTSP                   live video

Users log in with the NVR's own account. The password is kept in memory for
the session, or stored encrypted with "remember me" (see SavedLogins).
"""
import asyncio
import base64
import hashlib
import ipaddress
import json
import os
import secrets
import tempfile
import time
import urllib.parse

import aiohttp
from aiohttp import web
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NVR_URL = os.environ.get("NVR_URL", "").rstrip("/")
NVR_REPLAY_PORT = int(os.environ.get("NVR_REPLAY_PORT", "10000"))
NVR_RTSP_PORT = int(os.environ.get("NVR_RTSP_PORT", "0")) or None   # default: same port as HTTP
CHANNEL_NAMES = os.environ.get("CHANNEL_NAMES", "")                 # "2=Front door;3=Garage"
# Optional other sources for a channel's main stream, used when the NVR refuses to
# send it (it limits main streams to network viewers, e.g. when another system such
# as a video recorder already pulls them): "5=rtsp://host:8554/cam5;6=rtsp://...".
MAIN_STREAM_URLS = dict(
    (int(k), v.strip()) for k, v in (p.split("=", 1) for p in os.environ.get("MAIN_STREAM_URLS", "").split(";") if "=" in p))
DATA_DIR = os.environ.get("DATA_DIR", "/data")
# The NVR serves two replays at a time; a third one gets no frames.
MAX_PARALLEL = int(os.environ.get("MAX_PARALLEL_REPLAYS", "2"))
SESSION_TTL = 12 * 3600
REMEMBER_TTL = 90 * 24 * 3600
FPS = int(os.environ.get("NVR_FPS", "15"))

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
REPLAY_JS = os.path.join(HERE, "replay.js")
RECORD_TYPES = {1: "timing", 2: "motion", 4: "alarm", 8: "manual"}

sessions: dict[str, dict] = {}


# --------------------------------------------------------------------------- login

class SavedLogins:
    """"Remember me" storage.

    The password is encrypted with a key derived from the browser's cookie and the
    entry is addressed by a different hash of that cookie, so neither the file nor
    the cookie alone reveals the password.
    """

    path = os.path.join(DATA_DIR, "saved_logins.json")

    @staticmethod
    def _key(token):
        return hashlib.sha256(b"key:" + token.encode()).digest()

    @staticmethod
    def _id(token):
        return hashlib.sha256(b"id:" + token.encode()).hexdigest()

    @classmethod
    def _load(cls):
        try:
            with open(cls.path) as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return {}

    @classmethod
    def _store(cls, data):
        os.makedirs(os.path.dirname(cls.path), exist_ok=True)
        tmp = cls.path + ".tmp"
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            json.dump(data, f)
        os.replace(tmp, cls.path)

    @classmethod
    def save(cls, token, s):
        nonce = os.urandom(12)
        secret = AESGCM(cls._key(token)).encrypt(nonce, s["pass"].encode(), None)
        data = {k: v for k, v in cls._load().items() if v["expires"] > time.time()}
        data[cls._id(token)] = {"user": s["user"], "nvr": s["nvr"], "expires": s["expires"],
                                "nonce": nonce.hex(), "pass": secret.hex()}
        cls._store(data)

    @classmethod
    def get(cls, token):
        entry = cls._load().get(cls._id(token))
        if not entry or entry["expires"] < time.time():
            return None
        try:
            password = AESGCM(cls._key(token)).decrypt(
                bytes.fromhex(entry["nonce"]), bytes.fromhex(entry["pass"]), None)
        except Exception:
            return None
        return {"user": entry["user"], "pass": password.decode(), "nvr": entry["nvr"],
                "expires": entry["expires"]}

    @classmethod
    def forget(cls, token):
        data = cls._load()
        if data.pop(cls._id(token), None) is not None:
            cls._store(data)


def get_session(request):
    token = request.cookies.get("nvr_session") or ""
    s = sessions.get(token)
    if s is None and token:
        s = SavedLogins.get(token)
        if s:
            sessions[token] = s
    if not s or s["expires"] < time.time():
        sessions.pop(token, None)
        raise web.HTTPUnauthorized(text="Not logged in")
    return s


def check_nvr_url(url):
    """Only allow NVRs on private networks, so the server cannot be used to reach other hosts."""
    u = urllib.parse.urlparse(url if "://" in url else "http://" + url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise web.HTTPBadRequest(text="Invalid NVR address")
    try:
        ip = ipaddress.ip_address(u.hostname)
    except ValueError:
        raise web.HTTPBadRequest(text="Use the NVR's IP address")
    if not (ip.is_private or ip.is_loopback) or ip.is_unspecified:
        raise web.HTTPBadRequest(text="The NVR must be on a local network")
    return f"{u.scheme}://{u.netloc}"


# ----------------------------------------------------------------------- NVR access

def basic_auth(s):
    return {"Authorization": "Basic " + base64.b64encode(f"{s['user']}:{s['pass']}".encode()).decode()}


async def nvr_json(app, method, path, s, data=None):
    # Send letters like å, ä, ö as plain UTF-8: the NVR cuts text at "\u00e5"-style escapes.
    body = None if data is None else json.dumps(data, ensure_ascii=False).encode()
    headers = {**basic_auth(s), **({"Content-Type": "application/json;charset=UTF-8"} if body is not None else {})}
    async with app["http"].request(method, s["nvr"] + path, data=body, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=20)) as r:
        if r.status == 401:
            raise web.HTTPUnauthorized(text="The NVR rejected the login")
        r.raise_for_status()
        return await r.json(content_type=None)


async def nvr_library(app, s):
    """The NVR's own replay library (dist/import.js), fetched from the NVR once per NVR."""
    cache = app["cache"]
    if s["nvr"] not in cache:
        async with app["http"].get(s["nvr"] + "/dist/import.js") as r:
            r.raise_for_status()
            cache[s["nvr"]] = await r.text()
    return cache[s["nvr"]]


async def channels(app, s):
    """Channels that have a camera, with names: CHANNEL_NAMES, else the NVR's own titles."""
    detail, stream = await asyncio.gather(
        nvr_json(app, "POST", "/netsdk/GetChannelDetail", s),
        nvr_json(app, "GET", "/netsdk/Stream", s))
    titles = {int(t["ID"]) + 1: t.get("Text", "") for t in stream.get("Title") or []}
    overrides = {}
    for part in CHANNEL_NAMES.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            overrides[int(k.strip())] = v.strip()
    result = []
    for i, d in enumerate(detail.get("Item") or []):
        ch = i + 1
        if d.get("MainStream"):
            result.append({"channel": ch, "name": overrides.get(ch) or titles.get(ch) or f"CH{ch}",
                           "main": d.get("MainStream", ""), "sub": d.get("SubStream", "")})
    return result


def replay_input(library, s, channel, start, end, rec_type):
    host = urllib.parse.urlparse(s["nvr"]).hostname
    return json.dumps({"library": library, "host": host, "port": NVR_REPLAY_PORT,
                       "user": s["user"], "password": s["pass"], "channel": channel - 1,
                       "start": start, "end": end, "type": rec_type}).encode()


def safe_filename(name, start):
    stamp = time.strftime("%Y-%m-%d_%H%M%S", time.gmtime(start))
    base = "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "camera"
    return f"{base}_{stamp}.mp4"


# ---------------------------------------------------------------------------- API

async def login(request):
    d = await request.json()
    remember = bool(d.get("remember"))
    ttl = REMEMBER_TTL if remember else SESSION_TTL
    nvr = check_nvr_url(d.get("nvr") or NVR_URL)
    s = {"user": d.get("user") or "admin", "pass": d.get("pass", ""), "nvr": nvr, "expires": time.time() + ttl}
    try:
        info = await nvr_json(request.app, "GET", "/netsdk/Stat/DeviceInfo", s)
    except web.HTTPUnauthorized:
        return web.json_response({"ok": False, "error": "login"}, status=401)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return web.json_response({"ok": False, "error": "unreachable"}, status=502)
    s["max_chn"] = int(info.get("MAX_CHN") or 16)
    token = secrets.token_urlsafe(32)
    sessions[token] = s
    if remember:
        SavedLogins.save(token, s)
    resp = web.json_response({"ok": True})
    resp.set_cookie("nvr_session", token, max_age=ttl, httponly=True, samesite="Strict")
    return resp


async def logout(request):
    token = request.cookies.get("nvr_session", "")
    sessions.pop(token, None)
    SavedLogins.forget(token)
    resp = web.json_response({"ok": True})
    resp.del_cookie("nvr_session")
    return resp


async def config(request):
    """Settings the login page needs before anyone is logged in."""
    return web.json_response({"nvr": NVR_URL})


async def info(request):
    s = get_session(request)
    device = await nvr_json(request.app, "GET", "/netsdk/Stat/DeviceInfo", s)
    return web.json_response({"device": device, "channels": await channels(request.app, s)})


async def search(request):
    """All recordings on one date for the selected channels.

    Note: the NVR stores local wall-clock time as if it were UTC.
    """
    s = get_session(request)
    d = await request.json()
    selected = {int(c) for c in d.get("channels", [])}
    channel_flags = ["True" if (i + 1) in selected else "False" for i in range(s.get("max_chn", 16))]
    items, page, total = [], 1, 0
    while True:
        # The type filter is sent as flags in the order timing, motion, alarm.
        param = {"Channel": channel_flags, "Type": ["True", "True", "True"], "Date": d["date"],
                 "BeginTime": "00:00:00", "EndTime": "23:59:59", "PageSize": 100,
                 "CurrentPage": str(page), "Reload": "True"}
        resp = await nvr_json(request.app, "POST", "/netsdk/R.SearchRecord", s,
                              {"DEV": "XVR", "VER": "1.0", "API": "R.SearchRecord", "Parameter": param})
        if resp.get("RetDetail") != "Search Success!":
            break
        for it in resp.get("Item") or []:
            items.append({"channel": int(it["Channel"]) + 1, "start": int(it["TimeStart"]),
                          "end": int(it["TimeEnd"]), "type": RECORD_TYPES.get(int(it["Type"]), "other"),
                          "type_code": int(it["Type"])})
        total = int(resp.get("SearchCnt") or 0)
        if len(items) >= total or not resp.get("Item") or page > 200:
            break
        page += 1
    items.sort(key=lambda i: (i["channel"], i["start"]))
    return web.json_response({"items": items, "total": total})


async def stream_process(request, ffmpeg, cleanup=()):
    """Stream ffmpeg's stdout to the browser and clean up when either side stops."""
    resp = web.StreamResponse(headers={"Content-Type": "video/mp4", "Cache-Control": "no-store"})
    await resp.prepare(request)
    try:
        while chunk := await ffmpeg.stdout.read(64 * 1024):
            await resp.write(chunk)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        for proc in (*cleanup, ffmpeg):
            await stop_process(proc)
        err = (await ffmpeg.stderr.read()).decode(errors="ignore").strip()
        if err:
            print("ffmpeg:", err[-400:], flush=True)
    return resp


def mp4_video_args(codec, passthrough=False, width=None):
    # Browsers that can play H.265 get the camera's own picture untouched; for the
    # others it is transcoded to H.264, which costs some sharpness.
    if codec in ("H265", "hevc") and passthrough:
        return ["-c:v", "copy", "-tag:v", "hvc1"]
    if width:    # main stream standing in for a missing sub stream: make it small
        return ["-vf", f"scale={width}:-2", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
                "-crf", "26", "-g", str(FPS), "-pix_fmt", "yuv420p"]
    if codec in ("H265", "hevc"):
        return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "23",
                "-g", str(FPS), "-pix_fmt", "yuv420p"]
    return ["-c:v", "copy"]


# A fragment at every keyframe, and at least every half second: the cameras send a
# keyframe only every ~9 seconds, and waiting for it would delay the picture.
FRAGMENTED_MP4 = ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                  "-frag_duration", "500000", "pipe:1"]


async def playback(request):
    """Plays part of a recording as fragmented MP4, in real time."""
    s = get_session(request)
    channel, start, end = (int(request.query[k]) for k in ("channel", "start", "end"))
    rec_type = int(request.query.get("type", "1"))
    hevc = request.query.get("hevc") == "1"
    read_fd, write_fd = os.pipe()
    node = await asyncio.create_subprocess_exec(
        "node", REPLAY_JS, stdin=asyncio.subprocess.PIPE, stdout=write_fd, stderr=asyncio.subprocess.PIPE)
    os.close(write_fd)
    node.stdin.write(replay_input(await nvr_library(request.app, s), s, channel, start, end, rec_type))
    await node.stdin.drain()
    node.stdin.close()

    # The first status line tells how the recording is encoded.
    codec = None
    try:
        codec = json.loads(await asyncio.wait_for(node.stderr.readline(), 20)).get("codec")
    except (asyncio.TimeoutError, ValueError, AttributeError):
        pass
    if codec not in ("H264", "H265"):
        os.close(read_fd)
        if node.returncode is None:
            node.kill()
        raise web.HTTPBadGateway(text="The NVR sent no video for that time")
    ffmpeg = await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", "-f", "hevc" if codec == "H265" else "h264",
        "-framerate", str(FPS), "-i", "pipe:0", *mp4_video_args(codec, hevc), *FRAGMENTED_MP4,
        stdin=read_fd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    os.close(read_fd)
    asyncio.create_task(node.wait())
    return await stream_process(request, ffmpeg, cleanup=(node,))


async def fetch_part(app, s, channel, start, end, rec_type, folder, n):
    """Fetches one part of a clip as raw video plus an index of its frames."""
    await asyncio.sleep(1.5 * n)    # the NVR drops connections opened at the same moment
    video, index = os.path.join(folder, f"part{n}.bin"), os.path.join(folder, f"part{n}.idx")
    with open(video, "wb") as f:
        node = await asyncio.create_subprocess_exec(
            "node", REPLAY_JS, stdin=asyncio.subprocess.PIPE, stdout=f, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "NVR_FRAME_INDEX": index})
        _, log = await node.communicate(replay_input(await nvr_library(app, s), s, channel, start, end, rec_type))
    codec = None
    for line in log.decode(errors="ignore").splitlines():
        try:
            codec = codec or json.loads(line).get("codec")
        except ValueError:
            pass
    frames = []
    if os.path.exists(index):
        with open(index) as f:
            frames = [tuple(int(x) for x in line.split()) for line in f if line.strip()]
    return {"video": video, "frames": frames, "codec": codec}


async def download(request):
    """Downloads a clip faster than real time, in its original encoding.

    The NVR replays in real time but serves two replays at once, so the clip is
    fetched as parts in parallel. Each part has to start on a keyframe, so it is
    requested from a little before its start time; when joining, the previous part
    is cut where the next part's first frame begins.
    """
    s = get_session(request)
    channel, start, end = (int(request.query[k]) for k in ("channel", "start", "end"))
    rec_type = int(request.query.get("type", "1"))
    name = request.query.get("name", f"CH{channel}")
    length = max(1, end - start)
    count = max(1, min(MAX_PARALLEL, length // 30))
    bounds = [start + length * i // count for i in range(count + 1)]
    part_start = [max(start, bounds[i] - (12 if i else 0)) for i in range(count)]
    with tempfile.TemporaryDirectory() as folder:
        parts = await asyncio.gather(*(
            fetch_part(request.app, s, channel, part_start[i], bounds[i + 1], rec_type, folder, i)
            for i in range(count)))
        for i, p in enumerate(parts):    # retry a part that got nothing (NVR busy), on its own
            if not p["frames"]:
                parts[i] = await fetch_part(request.app, s, channel, part_start[i], bounds[i + 1],
                                            rec_type, folder, 0)
        if any(not p["frames"] for p in parts):
            raise web.HTTPBadGateway(text="The NVR did not send the whole clip, please try again")
        codec = next((p["codec"] for p in parts if p["codec"]), "H265")
        joined = os.path.join(folder, "joined.bin")
        with open(joined, "wb") as out:
            for i, p in enumerate(parts):
                with open(p["video"], "rb") as f:
                    data = f.read()
                stop = len(data)
                if i + 1 < len(parts):
                    next_first = parts[i + 1]["frames"][0][1]
                    stop = next((pos for pos, ts, _ in p["frames"] if ts >= next_first), len(data))
                out.write(data[:stop])
        mp4 = os.path.join(folder, "clip.mp4")
        fmt, tag = ("hevc", ["-tag:v", "hvc1"]) if codec == "H265" else ("h264", [])
        ff = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-f", fmt, "-framerate", str(FPS), "-i", joined,
            "-c:v", "copy", *tag, "-movflags", "+faststart", mp4, stderr=asyncio.subprocess.PIPE)
        _, err = await ff.communicate()
        if ff.returncode != 0:
            print("ffmpeg:", err.decode(errors="ignore")[-400:], flush=True)
            raise web.HTTPInternalServerError(text="Could not create the file")
        with open(mp4, "rb") as f:
            body = f.read()
    return web.Response(body=body, content_type="video/mp4", headers={
        "Content-Disposition": f'attachment; filename="{safe_filename(name, start)}"'})


async def open_live(s, channel, sub, url=None, hevc=False):
    """Starts ffmpeg reading an RTSP stream (by default the NVR's) and writing fragmented MP4 to stdout.

    Returns (ffmpeg, "hvc1" or "avc1") or None.
    """
    if url is None:
        u = urllib.parse.urlparse(s["nvr"])
        port = NVR_RTSP_PORT or u.port or 80
        cred = f"{urllib.parse.quote(s['user'], safe='')}:{urllib.parse.quote(s['pass'], safe='')}"
        url = f"rtsp://{cred}@{u.hostname}:{port}/ch{channel - 1}_{1 if sub else 0}.264"
    if hevc:
        # The browser plays both H.264 and H.265: copy the stream as it is, without a
        # separate probe first (each would wait for a keyframe). The codec is read
        # from the MP4 header as it comes out (see live_ws).
        ffmpeg = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-fflags", "nobuffer", "-rtsp_transport", "tcp", "-i", url,
            "-map", "0:v:0", "-c:v", "copy", *FRAGMENTED_MP4,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        return ffmpeg, "auto"
    probe = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", url,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(probe.communicate(), 15)
    except asyncio.TimeoutError:
        probe.kill()
        return None
    codec = out.decode().strip()
    if not codec:
        return None
    passthrough = codec == "hevc" and hevc
    ffmpeg = await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", "-fflags", "nobuffer", "-rtsp_transport", "tcp", "-i", url,
        "-map", "0:v:0", *mp4_video_args(codec, passthrough), *FRAGMENTED_MP4,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    return ffmpeg, ("hvc1" if passthrough else "avc1")


async def live(request):
    """Live video from the NVR's RTSP stream as fragmented MP4 over HTTP (one camera)."""
    s = get_session(request)
    opened = await open_live(s, int(request.query["channel"]), request.query.get("sub") == "1")
    if opened is None:
        raise web.HTTPBadGateway(text="No live video from the NVR")
    return await stream_process(request, opened[0])


async def stop_process(proc):
    """Ask a process to stop (replay.js then ends its NVR stream properly), kill it if it lingers."""
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), 2)
    except asyncio.TimeoutError:
        proc.kill()


async def open_live_native(app, s, channel, sub, hevc=False, width=None, wait=15):
    """Live video through the NVR's own WebSocket protocol (as its own multi-view does).

    The NVR's RTSP server falls behind when it has to serve many streams at once;
    this path does not. Returns (node, ffmpeg) or None.
    """
    data = json.dumps({"library": await nvr_library(app, s), "host": urllib.parse.urlparse(s["nvr"]).hostname,
                       "port": NVR_REPLAY_PORT, "user": s["user"], "password": s["pass"],
                       "channel": channel - 1, "mode": "live", "stream": 1 if sub else 0}).encode()
    read_fd, write_fd = os.pipe()
    node = await asyncio.create_subprocess_exec(
        "node", REPLAY_JS, stdin=asyncio.subprocess.PIPE, stdout=write_fd, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, **({"NVR_DEBUG": "1"} if os.environ.get("NVR_DEBUG_LIVE") == str(channel) else {})})
    os.close(write_fd)
    node.stdin.write(data)
    await node.stdin.drain()
    node.stdin.close()
    codec, first = None, b""
    deadline = time.monotonic() + wait
    try:
        while codec is None:       # skip debug lines until the codec line arrives
            first = await asyncio.wait_for(node.stderr.readline(), max(0.1, deadline - time.monotonic()))
            if not first:
                break
            msg = json.loads(first)
            if "openstream" in msg and msg["openstream"].get("result") != 0:
                print(f"live channel {channel} {'sub' if sub else 'main'}: refused by the NVR ({msg['openstream'].get('result')})", flush=True)
                break
            if "debug" in msg or "openstream" in msg:
                continue
            codec = msg.get("codec")
            if codec is None:
                break
    except (asyncio.TimeoutError, ValueError, AttributeError):
        pass
    if codec not in ("H264", "H265"):
        os.close(read_fd)
        await stop_process(node)
        rest = (await node.stderr.read()).decode(errors="ignore").strip()
        print(f"live channel {channel} {'sub' if sub else 'main'}: no video ({(first.decode(errors='ignore') + ' ' + rest).strip()[:300] or 'nothing within ' + str(wait) + ' s'})", flush=True)
        return None
    # The NVR sends frames in bursts; when the picture is passed through untouched,
    # give it even timestamps (the cameras run at a fixed frame rate) so the browser
    # plays it smoothly instead of using arrival times.
    passthrough = codec == "H265" and hevc and not width
    timing = ["-framerate", str(FPS)] if passthrough else ["-use_wallclock_as_timestamps", "1"]
    ffmpeg = await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", "-fflags", "+genpts", *timing,
        "-f", "hevc" if codec == "H265" else "h264", "-i", "pipe:0", *mp4_video_args(codec, passthrough, width), *FRAGMENTED_MP4,
        stdin=read_fd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    os.close(read_fd)

    async def drain():    # keep reading status lines so node never blocks on stderr
        async for _ in node.stderr:
            pass
    asyncio.create_task(drain())
    return node, ffmpeg, ("hvc1" if passthrough else "avc1")


async def live_ws(request):
    """Live video as fragmented MP4 over a WebSocket.

    Used by the overview: browsers allow only six ordinary HTTP connections per
    server, which a wall of continuous video streams would use up; WebSockets
    are not counted against that limit.
    """
    s = get_session(request)
    ws = web.WebSocketResponse(max_msg_size=0)
    await ws.prepare(request)
    sub = request.query.get("sub") == "1"
    # Sub streams (the overview) are small and always re-encoded, which plays most evenly;
    # the main stream is passed through untouched when the browser can play H.265.
    channel = int(request.query["channel"])
    hevc = request.query.get("hevc") == "1"
    opened = None
    # source=nvr skips the configured source (for testing what the NVR itself allows).
    if not sub and channel in MAIN_STREAM_URLS and request.query.get("source") != "nvr":
        # A configured other source is used first: it costs the NVR nothing extra.
        rtsp = await open_live(s, channel, False, url=MAIN_STREAM_URLS[channel], hevc=hevc)
        opened = (None, *rtsp) if rtsp else None
    if opened is None:
        opened = await open_live_native(request.app, s, channel, sub, hevc and not sub, wait=8 if sub else 15)
    note = ""
    if opened is None and sub:
        # Some cameras stop sending their sub stream when the main stream is set very
        # high over a weak wireless link; use the main stream, scaled down, instead.
        opened = await open_live_native(request.app, s, channel, False, width=960)
    if opened is None and not sub:
        # The NVR refuses main streams to network viewers when its limit is reached
        # (result -40). Try another source for the same main stream, then the sub stream.
        rtsp = await open_live(s, channel, False, hevc=hevc)
        if rtsp:
            opened = (None, *rtsp)
        else:
            opened = await open_live_native(request.app, s, channel, True)
            note = "sub"
    if opened is None:
        await ws.close(code=4004, message=b"no video")
        return ws
    node, ffmpeg, mp4_codec = opened
    head = b""
    if mp4_codec == "auto":
        # Read until the MP4 header shows which codec the copied stream has.
        while not any(tag in head for tag in (b"hvc1", b"hev1", b"avc1")) and len(head) < 2_000_000:
            chunk = await ffmpeg.stdout.read(64 * 1024)
            if not chunk:
                break
            head += chunk
        mp4_codec = next((t.decode() for t in (b"hvc1", b"hev1", b"avc1") if t in head), "avc1")
    # Tells the browser what is coming (and whether it had to fall back to the sub stream).
    await ws.send_str(json.dumps({"codec": mp4_codec, "note": note}))
    if head:
        await ws.send_bytes(head)

    async def watch_close():
        async for _ in ws:    # the browser sends nothing; this ends when it disconnects
            pass
    closer = asyncio.create_task(watch_close())
    try:
        while not ws.closed and (chunk := await ffmpeg.stdout.read(64 * 1024)):
            await ws.send_bytes(chunk)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        closer.cancel()
        if node:
            await stop_process(node)
        await stop_process(ffmpeg)
        await ws.close()
    return ws


async def status(request):
    """Disk and the cameras' streams and current recording rate."""
    s = get_session(request)
    stat, rate, chans = await asyncio.gather(
        nvr_json(request.app, "GET", "/netsdk/Stat", s),
        nvr_json(request.app, "POST", "/netsdk/GetBitrate", s),
        channels(request.app, s))
    hdd = stat.get("HDDState", {})
    online = {int(i["ID"]) + 1: i.get("Status", "") for i in stat.get("IPC") or [] if "ID" in i}
    for c in chans:
        r = next((x for x in rate.get("Item", []) if x.get("Channel") == f"Ch{c['channel']}"), {})
        c.update({"kbps": int(r.get("Kb/s") or 0), "mb_per_hour": int(r.get("MB/H") or 0),
                  "connection": online.get(c["channel"], "")})
    return web.json_response({
        "disks": [{"model": d.get("Model", "").strip(), "capacity": d.get("Capacity"), "used": d.get("Used"),
                   "status": d.get("Status")} for d in hdd.get("HDDInfo", []) if d.get("ID")],
        "total": hdd.get("Total"), "used_percent": hdd.get("UsedPercentage"), "channels": chans})


# ---------------------------------------------------------------- settings calls

# Every call the NVR's own settings pages make: name -> (method, path, API name for
# the {"DEV","VER","API","Parameter"} wrapper, or None to send the body as is).
NVR_CALLS = {
    "getDeviceInfo": ("GET", "netsdk/Stat/DeviceInfo", None),
    "getStat": ("GET", "netsdk/Stat", None),
    "setStat": ("POST", "netsdk/Stat", None),
    "getStatIPC": ("GET", "netsdk/Stat/IPC", None),
    "getGeneral": ("GET", "netsdk/General", None),
    "setGeneral": ("POST", "netsdk/General", None),
    "getLocalTime": ("GET", "netsdk/LocalTime", None),
    "setLocalTime": ("POST", "netsdk/S.SetLocalTime", None),
    "getUtcTime": ("GET", "netsdk/UtcTime", None),
    "setUtcTime": ("POST", "netsdk/UtcTime", None),
    "getRecord": ("GET", "netsdk/Record", None),
    "setRecord": ("POST", "netsdk/Record", None),
    "getEvent": ("GET", "netsdk/Event", None),
    "setEvent": ("POST", "netsdk/Event", None),
    "getNetwork": ("GET", "netsdk/Network", None),
    "setNetwork": ("POST", "netsdk/Network", None),
    "getPppoeParam": ("GET", "netsdk/Network/PPPoE", None),
    "setPppoeParam": ("POST", "netsdk/Network/PPPoE", None),
    "startPppoe": ("POST", "netsdk/R.ReStartPPPoE", None),
    "stopPppoe": ("POST", "netsdk/R.StopPPPoE", None),
    "getPppoeInfo": ("POST", "netsdk/G.PPPoEInfo", None),
    "getEmail": ("GET", "netsdk/Network/SMTP", None),
    "setEmail": ("POST", "netsdk/Network/SMTP", None),
    "testEmail": ("POST", "netsdk/R.TestSmtp", "R.TestSmtp"),
    "getWifi": ("GET", "netsdk/Network/WIFI", None),
    "setWifi": ("POST", "netsdk/S.Wifi.RegionChannel", "SetRegionAndChannel"),
    "resetWifi": ("POST", "netsdk/R.Wifi.Reset", None),
    "getStream": ("GET", "netsdk/Stream", None),
    "setStream": ("POST", "netsdk/Stream", None),
    "getStreamColor": ("GET", "netsdk/Stream/Color", None),
    "setStreamColor": ("POST", "netsdk/Stream/Color", None),
    "getStreamEncode": ("GET", "netsdk/Stream/Encode", None),
    "setStreamEncode": ("POST", "netsdk/Stream/Encode", None),
    "getBitrate": ("POST", "netsdk/GetBitrate", None),
    "getChannelDetail": ("POST", "netsdk/GetChannelDetail", None),
    "getChannelIPCamInfo": ("GET", "netsdk/Channel/IPCamInfo", None),
    "setChannelIPCamInfo": ("POST", "netsdk/Channel/IPCamInfo", None),
    "ipcSearch": ("POST", "netsdk/R.SEARCH.Ipc", "R.SEARCH.Ipc"),
    "setOneIPC": ("POST", "netsdk/Channel/IPCamInfo/{channel}", None),     # add or remove one channel
    "ipcReboot": ("POST", "netsdk/R.Channel.SetIpcReboot", "R.Channel.SetIpcReboot"),
    "imageFlip": ("POST", "netsdk/R.Channel.SetImageRollover", "R.Channel.SetImageRollover"),
    "logSearch": ("POST", "netsdk/LogSearch", "LogSearch"),
    "logPage": ("POST", "netsdk/LogPageChange", "LogSearch"),
    "getUserList": ("GET", "netsdk/User", None),
    "addUser": ("POST", "netsdk/AddUser", "AddUser"),
    "editUser": ("POST", "netsdk/DelUser", "EditUser"),     # the NVR's own page uses this path for edits too
    "deleteUser": ("POST", "netsdk/DelUser", "DelUser"),
    "changePassword": ("POST", "netsdk/SetPasswd", "SetPasswd"),
    "reboot": ("POST", "netsdk/Reboot", None),
    "restoreFactory": ("POST", "netsdk/R.Restore.FactorySetting", "RestoreFactorySetting"),
    "getUpgradeRate": ("POST", "netsdk/GetUpgradeRate", None),
}


async def nvr_call(request):
    """Runs one of the NVR's settings calls on behalf of the logged-in user."""
    s = get_session(request)
    name = request.match_info["name"]
    if name not in NVR_CALLS:
        raise web.HTTPNotFound()
    method, path, api_name = NVR_CALLS[name]
    body = await request.json() if request.can_read_body else None
    if "{channel}" in path:
        path = path.replace("{channel}", str(int((body or {}).get("Channel", 0))))
    if name in ("addUser", "editUser", "deleteUser"):
        body = {**(body or {}), "CurrentUser": s["user"]}
    if name == "addUser" and "PassWord" in body:
        body["PassWord"] = base64.b64encode(body["PassWord"].encode()).decode()
    if name == "changePassword":
        body = {**body, "UserName": s["user"],
                "OldPasswd": base64.b64encode(s["pass"].encode()).decode(),
                "NewPasswd": base64.b64encode(body["NewPasswd"].encode()).decode()}
    if api_name:
        body = {"DEV": "XVR", "VER": "1.0", "API": api_name, "Parameter": body or {}}
    if method == "GET":
        path += f"?t={int(time.time() * 1000)}"     # the NVR's own page always adds this
    result = await nvr_json(request.app, method, "/" + path, s, body if method == "POST" else None)
    if name == "changePassword" and str(result.get("RetCode")) == "0":
        s["pass"] = (await request.json())["NewPasswd"]    # keep the session working
    return web.json_response(result)


async def snapshot(request):
    """A still image from one channel (the NVR saves it to a file, which is removed afterwards)."""
    s = get_session(request)
    ch = int(request.query.get("channel", "0"))
    fname = f"image_chn0{ch}_{int(time.time())}.jpg"
    async with request.app["http"].post(
            s["nvr"] + "/NetworkSnap", headers=basic_auth(s), timeout=aiohttp.ClientTimeout(total=20),
            json={"DEV": "XVR", "VER": "1.0", "API": "NetworkSnap", "Parameter": {"Channel": ch, "FileName": fname}}) as r:
        data = await r.read()
        ctype = r.headers.get("Content-Type", "image/jpeg")
    if not data or not ctype.startswith("image/"):
        raise web.HTTPNotFound(text="No still image from this channel")
    try:
        await nvr_json(request.app, "POST", "/netsdk/R.RmScreenShotFile", s,
                       {"DEV": "XVR", "VER": "1.0", "API": "R.RmScreenShotFile", "Parameter": {"FileName": fname}})
    except Exception:
        pass
    return web.Response(body=data, content_type=ctype.split(";")[0], headers={"Cache-Control": "no-store"})


async def upgrade(request):
    """Firmware upgrade: passes the uploaded .rom file on to the NVR."""
    s = get_session(request)
    reader = await request.multipart()
    part = await reader.next()
    if part is None or not (part.filename or "").lower().endswith(".rom"):
        raise web.HTTPBadRequest(text="Choose a .rom file")
    data = await part.read(decode=False)
    form = aiohttp.FormData()
    form.add_field("file", data, filename=part.filename, content_type="application/octet-stream")
    async with request.app["http"].post(s["nvr"] + "/onlineupgrade", data=form, headers=basic_auth(s),
                                        timeout=aiohttp.ClientTimeout(total=600)) as r:
        text = await r.text()
    return web.json_response({"status": r.status, "response": text[:500]})


async def index(request):
    return web.FileResponse(os.path.join(STATIC, "index.html"))


@web.middleware
async def no_cache(request, handler):
    """Make browsers check for a new version of the page after an update."""
    resp = await handler(request)
    if request.path == "/" or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


async def on_startup(app):
    app["http"] = aiohttp.ClientSession()
    app["cache"] = {}


async def on_cleanup(app):
    await app["http"].close()


def make_app():
    app = web.Application(client_max_size=64 * 1024 * 1024, middlewares=[no_cache])
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.add_routes([
        web.get("/", index),
        web.static("/static", STATIC),
        web.get("/api/config", config),
        web.post("/api/login", login),
        web.post("/api/logout", logout),
        web.get("/api/info", info),
        web.get("/api/status", status),
        web.post("/api/search", search),
        web.get("/api/playback", playback),
        web.get("/api/download", download),
        web.get("/api/live", live),
        web.get("/api/live_ws", live_ws),
        web.post("/api/call/{name}", nvr_call),
        web.get("/api/snapshot", snapshot),
        web.post("/api/upgrade", upgrade),
    ])
    return app


if __name__ == "__main__":
    web.run_app(make_app(), port=int(os.environ.get("PORT", "8090")), access_log=None)
