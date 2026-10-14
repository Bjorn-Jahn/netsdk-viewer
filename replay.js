// Replays a recording (or, with mode "live", streams live video) from the NVR and
// writes the raw video frames to stdout.
//
// The NVR's web page uses its own library (dist/import.js, "apip2p") that talks
// to the NVR over a WebSocket on port 10000. This runs that same library in Node
// instead of a browser, so the password stays on the server.
//
// Input on stdin (JSON): library, host, port, user, password, channel (0-based),
// and either start, end (the NVR's time scale), type for a recording, or
// mode: "live" and stream (0 main, 1 sub) for live video.
// Status lines are written to stderr as JSON; the first one has the codec.
// With NVR_FRAME_INDEX set, "byte-offset timestamp-ms frame-type" is written per
// frame to that file, so parts fetched in parallel can be joined exactly.
"use strict";
const fs = require("fs");
const vm = require("vm");
const WebSocket = require("ws");

function log(o) { process.stderr.write(JSON.stringify(o) + "\n"); }

// The NVR splits video frames larger than 64 kB into several WebSocket messages.
// Only the first starts with the frame header "NARF"; the library drops the rest,
// which cuts off the lower part of every keyframe. Join the pieces before the
// library sees them. Message layout: 32-byte header (magic ABBCCDDE, command at
// byte 4, payload length at byte 28) followed by the payload; video is command 0x13.
function joinSplitFrames() {
  const NARF = Buffer.from("NARF");
  const original = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, fn, ...rest) {
    if (type !== "message") return original.call(this, type, fn, ...rest);
    let pending = null;   // { header, pieces: [Buffer] }
    const deliver = (data) => fn({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.length), target: this });
    const flush = () => {
      if (!pending) return;
      const payload = Buffer.concat(pending.pieces);
      const header = Buffer.from(pending.header);
      header.writeUInt32LE(payload.length, 28);
      pending = null;
      deliver(Buffer.concat([header, payload]));
    };
    return original.call(this, type, ev => {
      const b = Buffer.from(ev.data);
      if (process.env.NVR_DEBUG) { globalThis.__seen = globalThis.__seen || { messages: 0, bytes: 0, cmds: {} }; const s = globalThis.__seen; s.messages++; s.bytes += b.length;
        if (b.length >= 32 && b.readUInt32BE(0) === 0xabbccdde) s.cmds[b[4]] = (s.cmds[b[4]] || 0) + 1; }
      const isVideo = b.length >= 32 && b.readUInt32BE(0) === 0xabbccdde && b[4] === 0x13;
      if (!isVideo) { if (b.length > 8) flush(); return fn(ev); }
      const piece = b.subarray(32);
      if (piece.subarray(0, 4).equals(NARF)) {
        flush();
        pending = { header: b.subarray(0, 32), pieces: [piece] };
      } else if (pending) {
        pending.pieces.push(piece);
      } else {
        fn(ev);
      }
      // Small frames are complete at once; only a piece of exactly 64 kB means more follows.
      if (pending && piece.length !== 65536) flush();
    }, ...rest);
  };
}

let input = "";
process.stdin.on("data", d => (input += d));
process.stdin.on("end", () => {
  const a = JSON.parse(input);
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.WebSocket = WebSocket;
  joinSplitFrames();
  vm.runInThisContext(a.library, { filename: "import.js" });
  const api = globalThis.apip2p;

  let lastFrame = Date.now(), first = true, done = false, written = 0;
  const index = process.env.NVR_FRAME_INDEX ? fs.openSync(process.env.NVR_FRAME_INDEX, "w") : null;
  const finish = (reason, code = 0) => {
    if (done) return;
    done = true;
    log({ end: reason });
    try { if (a.mode === "live") api.close_stream(conn, a.channel, a.stream || 0); else api.replay_stop(conn); } catch (e) {}
    // Give the stop message a moment to reach the NVR before exiting.
    setTimeout(() => process.stdout.end(() => process.exit(code)), 300);
    setTimeout(() => process.exit(code), 1500);
  };

  api.onconnect = (c, code) => {
    if (code !== 0) return finish("no connection (" + code + ")", 2);
    api.login(c, a.user, a.password);
  };
  api.onloginresult = (c, result) => {
    if (result !== 0) return finish("login rejected (" + result + ")", 3);
    if (a.mode === "live") { api.open_stream(c, a.channel, a.stream || 0); lastFrame = Date.now(); return; }
    // The channel list is a bitmask: index = channel, value >= 0 means selected.
    const chans = new Array(a.channel + 1).fill(-1);
    chans[a.channel] = a.channel;
    api.replay_start(c, chans, a.start, a.end, a.type);
    lastFrame = Date.now();
  };
  api.ondisconnect = () => finish("disconnected");
  api.onrecplaystop = () => finish("replay ended");
  // NVR_DEBUG: log a summary of what arrives (frame types and sizes) every 3 seconds.
  const seen = { messages: 0, bytes: 0, frames: {} };
  if (process.env.NVR_DEBUG) setInterval(() => log({ debug: seen, ws: globalThis.__seen }), 3000);
  const onFrame = (c, type, data, length, channel, width, height, codec, fps, ts) => {
    if (process.env.NVR_DEBUG) { const k = `${type}:${codec}`; seen.frames[k] = seen.frames[k] || { n: 0, max: 0 }; seen.frames[k].n++; seen.frames[k].max = Math.max(seen.frames[k].max, length); }
    if (type !== 1 && type !== 2) return;      // video frames only, no audio
    if (first) {
      if (type !== 1) return;                  // start on a keyframe
      first = false;
      log({ codec, width, height, fps, ts });
    }
    lastFrame = Date.now();
    if (a.mode !== "live" && ts / 1000 >= a.end) return finish("end time reached");
    // Copy: the library may reuse the buffer before the write completes.
    const frame = Buffer.from(data.subarray(0, length));
    if (index) { fs.writeSync(index, `${written} ${ts} ${type}\n`); written += frame.length; }
    process.stdout.write(frame);
  };

  if (a.mode === "live") {
    // The NVR answers the live request with a result code (0 = accepted).
    api.onopenstream = (c, channel, stream, result) => {
      if (process.env.NVR_DEBUG || result !== 0) log({ openstream: { channel, stream, result } });
      if (result !== 0) finish("refused (" + result + ")", 5);    // e.g. -40: the NVR's limit for main streams
    };
    api.onrecvframeex = (c, type, data, length, channel, width, height, codec) => {
      if (channel === a.channel) onFrame(c, type, data, length, channel, width, height, codec, 0, Date.now());
    };
  } else {
    api.onrecvrecframe = onFrame;
  }
  // Asked to stop (viewer closed): end the stream properly, so the NVR frees the
  // slot at once instead of keeping it reserved for a while.
  process.on("SIGTERM", () => finish("stopped"));
  const conn = api.create(0);
  api.connectbyip(conn, a.host, String(a.port));
  setInterval(() => {
    if (Date.now() - lastFrame > 15000) finish(first ? "no frames" : "no more frames", first ? 4 : 0);
  }, 1000);
  process.stdout.on("error", () => finish("receiver closed"));
});
