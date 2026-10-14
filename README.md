# netsdk-viewer

A web page for viewing and downloading recordings from "netsdk" network video
recorders that works in any modern browser, on a computer or a phone.

> **Only tested with one NVR:** a Hiseeu W-NVR K8216-W6 (firmware 3.6.14.0F).
> It has not been tried on any other model or firmware. Other NVRs may work,
> partly work or not work at all, and settings pages may write values your
> model does not expect. See [Tested with](#tested-with).

The NVR's own web page needs an old ActiveX/Flash browser plugin for playback,
so in current browsers you can see the settings but not watch anything.
netsdk-viewer talks to the same interfaces as that page and has the same four tabs:

- **Live**: an overview of the cameras you choose, as a monitoring screen (also
  full screen), and one camera at a time in full quality with digital zoom (mouse
  wheel, pinch, drag) and saving a still image.
- **Playback**: a 24-hour timeline per camera (schedule, motion, alarm); click
  anywhere on it to play from that moment. Download a clip as MP4 in the original
  quality (usually H.265), about twice as fast as real time.
- **Settings**, the same pages as the NVR's menu: device information (with disk
  model, size and how many days it holds), recording schedule, time, network,
  e-mail, Wi-Fi, image, encoding, stream values, channel details, channel names
  and OSD, video detection (with the motion area drawn over a still image), change
  password, log, firmware upgrade, restart and factory reset.
- **Management**: which camera is on which channel, with status and Wi-Fi signal;
  search the network for cameras, add, edit, remove, restart a camera or flip
  its image.

It also shows one setting the NVR's own page hides: "automatic camera
resolution" for wireless cameras (Settings → Wi-Fi), which makes the K8216-W6
lower the cameras' resolution by itself.

The page is in Swedish or English, picked from the browser's language.

## Tested with

Only one device so far:

- Hiseeu W-NVR **K8216-W6** (Wi-Fi kit), firmware 3.6.14.0F, with H.265 cameras.

Nothing else has been tested. Other NVRs whose web page is titled "Netword video
client" and uses `/netsdk/` URLs (common in Wi-Fi camera kits) use the same
interfaces and might work, but that is a guess, not something anyone has checked.
Try it on a model you can afford to reset, and please open an issue saying which
model and firmware worked or did not.

## Running it

You need Docker on a computer on the same network as the NVR.

1. Download this folder.
2. Edit `docker-compose.yml` and set `NVR_URL` to your NVR's address.
3. Run `docker compose up -d --build`.
4. Open `http://<that computer>:8090` and log in with the NVR's user name and
   password.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `NVR_URL` | – | NVR address, pre-filled on the login page. It can also be typed there. |
| `CHANNEL_NAMES` | names stored in the NVR | Names shown on this page only, e.g. `2=Front door;3=Garage`. See "Camera names". |
| `NVR_REPLAY_PORT` | `10000` | Port of the NVR's playback service. |
| `NVR_RTSP_PORT` | same as `NVR_URL` | Port for live video. |
| `MAX_PARALLEL_REPLAYS` | `2` | Simultaneous replays used when downloading. The K8216-W6 allows 2. |
| `NVR_FPS` | `15` | Frame rate of the recordings. |
| `MAIN_STREAM_URLS` | – | Other sources for full-quality live video, e.g. `5=rtsp://192.168.1.20:8554/garage`. See below. |
| `PORT` | `8090` | Port of this web page. |

### Camera names

The page shows each camera under the name stored in the NVR, the same name the
NVR's own screen and the camera image use. Change it under Settings → Channel
names and OSD. The NVR allows at most 16 characters and only the letters A–Z;
å, ä, ö and other accented letters are replaced when saving.

To show other names on this page only (for example with å, ä, ö), set
`CHANNEL_NAMES`, e.g. `2=Postlåda;3=Källardörr`. Those names win over the NVR's.
Channel numbers are the ones shown in the NVR (and in the Management tab).

### When full-quality live video is refused

The NVR limits how many main (full-quality) streams it sends to the network. If
another system already pulls them all (for example a video recorder such as
Frigate, through go2rtc), the NVR refuses more with error -40. netsdk-viewer then
tries the NVR's RTSP stream, and if that fails too it shows the sub stream with a
note. If you already restream the cameras (go2rtc and similar), point
`MAIN_STREAM_URLS` at those streams: they are used first and cost the NVR nothing.

## Security

- Only use it on your home network. Do not expose it to the internet: it has no
  protection of its own beyond the NVR's login.
- Your password is sent to this server (over plain HTTP, like the NVR's own page)
  and used to talk to the NVR. It is kept in memory only, unless you tick
  "Remember my password". Then it is stored in `data/saved_logins.json`, encrypted
  with a key that exists only in your browser's cookie, for 90 days. Logging out
  deletes it.
- The server only connects to NVR addresses on private networks.

## Limitations

- The NVR plays recordings back in real time and its protocol has no faster mode
  or file export. Downloads therefore take about half the clip's length.
- While a download runs, both of the NVR's playback slots are in use, so playing
  something else at the same time may fail.
- A downloaded clip can start up to about 15 seconds before the chosen time,
  because it has to begin on a keyframe.
- Clips are H.265. VLC and phones play them; Windows' own player may need the free
  "HEVC Video Extensions".
- Live video starts at the camera's next keyframe, which these cameras send only
  about every 9 seconds; a still image is shown meanwhile.
- With "Constant" bit rate on a camera, the NVR refused extra full-quality viewers
  for that channel; "Variable" works.
- With "automatic camera resolution" on (the factory setting), the K8216-W6 sets
  wireless cameras back to its own resolution within seconds of changing it.
- This NVR's firmware does not answer the user list and some time calls that the
  manufacturer's page has code for, so user management is not included.
- Channel names in the NVR can have at most 16 characters (the limit the NVR's own
  page sets) and only the letters A–Z: in testing, the NVR cut a name at the first
  å, ä or ö. This is not documented by the manufacturer. Accented letters are
  therefore replaced when saving. Use `CHANNEL_NAMES` to show names with those letters on this page.
- The NVR rejects saving the whole video settings object at once; the page only
  sends the parts each settings page changes.

## How it works

- Search, status, settings and channel names use the NVR's JSON API (`/netsdk/...`,
  HTTP Basic auth), with the same calls as the NVR's own page (`NVR_CALLS` in
  `server.py`).
- Playback uses the NVR's own JavaScript library (`/dist/import.js`), downloaded
  from your NVR at run time and run in Node (`replay.js`). It speaks a WebSocket
  protocol on port 10000. The library drops the second part of video frames over
  64 kB, which cuts off the lower part of each keyframe; `replay.js` joins those
  parts first.
- Live video also uses that library (`open_stream`): the NVR's RTSP server falls
  behind with many streams at once, and browsers allow only six ordinary HTTP
  connections per server, so live video goes to the page over WebSockets.
- ffmpeg turns the frames into MP4. Browsers that can play H.265 get the camera's
  picture untouched; for others it is converted to H.264. Downloads always keep
  the original.
- The NVR stores local wall-clock time as if it were UTC; the page handles that.
- Streams are ended properly when a viewer leaves; if they are just cut off, the
  NVR keeps the slot reserved for minutes and new viewers get no picture.

No code from the NVR's manufacturer is included in this project.

## License

MIT, see [LICENSE](LICENSE). Use it for anything, including in commercial
products; manufacturers are welcome to build on it.
