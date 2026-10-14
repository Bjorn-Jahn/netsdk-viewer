// Shared helpers, login, tabs, live view and playback.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let cams = [], device = {}, maxChannels = 16;

function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; }

async function api(path, data) {
  const r = await fetch(path, data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (r.status === 401) { showLogin(); throw new Error(L("Not logged in", "Inte inloggad")); }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Runs one of the NVR's own calls (see NVR_CALLS in server.py).
const call = (name, body = {}) => api("/api/call/" + name, body);

// True if the NVR reported success; the NVR uses several ways of saying so.
function succeeded(r) {
  if (!r) return false;
  if (r.StatusCode === "ok" || String(r.RetCode) === "0") return true;
  return /success/i.test(r.RetDetail || "");
}

function toast(text, isError = false) {
  const t = $("toast");
  t.textContent = text;
  t.style.background = isError ? "var(--danger)" : "";
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

async function saved(promise) {
  try {
    const r = await promise;
    if (succeeded(r)) toast(L("Saved", "Sparat"));
    else toast(L("The NVR said: ", "NVR:en svarade: ") + (r.RetDetail || JSON.stringify(r)), true);
    return r;
  } catch (e) { toast(e.message, true); }
}

function confirmDialog(text, yes = L("Continue", "Fortsätt")) {
  return new Promise(resolve => {
    $("dialogtext").textContent = text;
    $("dialogyes").textContent = yes;
    $("dialogno").textContent = L("Cancel", "Avbryt");
    $("dialog").classList.remove("hidden");
    const done = v => { $("dialog").classList.add("hidden"); resolve(v); };
    $("dialogyes").onclick = () => done(true);
    $("dialogno").onclick = () => done(false);
  });
}

function camName(ch) { return (cams.find(c => c.channel === ch) || {}).name || "CH" + ch; }

// ------------------------------------------------------------------ login & tabs

function showLogin() {
  document.querySelectorAll(".tab").forEach(t => t.classList.add("hidden"));
  $("top").classList.add("hidden");
  $("loginpanel").classList.remove("hidden");
}

async function start() {
  const info = await api("/api/info");
  cams = info.channels;
  device = info.device || {};
  maxChannels = +device.MAX_CHN || 16;
  $("device").textContent = [device.DeviceName, device.DeviceModel].filter(Boolean).join(" · ");
  $("loginpanel").classList.add("hidden");
  $("top").classList.remove("hidden");
  setupLive();
  setupPlayback();
  showTab(location.hash.slice(1) || "playback");
}

function showTab(name) {
  if (!["live", "playback", "settings", "manage"].includes(name)) name = "playback";
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("hidden", t.id !== "tab-" + name));
  if (name !== "live") { stopLive(); leaveFromWall(); }
  if (name === "live") startLiveTab();
  if (name === "settings") openSettings();
  if (name === "manage") openManage();
  history.replaceState(null, "", "#" + name);
}

// ------------------------------------------------------------------------- live

// Two modes: "wall" shows several cameras at once (sub streams, light on the NVR
// and the browser); "single" shows one camera, main stream by default.
let liveChannel = null, liveMode = "wall", wallCams = [], liveReady = false;

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} },
};

function setupLive() {
  $("livebuttons").innerHTML = cams.map(c =>
    `<button class="live secondary small" data-channel="${c.channel}">${esc(c.name)}</button>`).join("");
  document.querySelectorAll("button.live").forEach(b => b.onclick = () => { leaveFromWall(); showLive(+b.dataset.channel); });
  liveMode = store.get("liveMode", "wall");
  const known = new Set(cams.map(c => c.channel));
  wallCams = store.get("wallCams", cams.map(c => c.channel)).filter(ch => known.has(ch));
  $("wallpicker").innerHTML = cams.map(c =>
    `<label><input type="checkbox" value="${c.channel}" ${wallCams.includes(c.channel) ? "checked" : ""}> ${esc(c.name)}</label>`).join("");
  $("layout").value = store.get("wallLayout", "auto");
  if (liveReady) return;
  liveReady = true;
  $("mode-wall").textContent = L("Overview", "Översikt");
  $("mode-single").textContent = L("One camera", "En kamera");
  $("layoutlabel").textContent = L("Layout ", "Layout ");
  $("layout").options[0].textContent = L("Automatic", "Automatisk");
  $("wallfull").textContent = L("Full screen", "Helskärm");
  $("mode-wall").onclick = () => { leaveFromWall(); setLiveMode("wall"); };
  $("mode-single").onclick = () => { leaveFromWall(); setLiveMode("single"); };
  // A click goes back to the overview, but not after dragging or while zoomed in.
  $("singlebox").onclick = () => { if (fromWall && !zoom.moved && zoom.scale === 1) backToWall(); };
  setupZoom();
  $("wallpicker").onchange = () => {
    wallCams = [...document.querySelectorAll("#wallpicker input:checked")].map(i => +i.value);
    store.set("wallCams", wallCams);
    drawWall();
  };
  $("layout").onchange = () => { store.set("wallLayout", $("layout").value); drawWall(); };
  $("wallfull").onclick = () => $("wall").requestFullscreen?.();
  // Full screen for one camera uses the frame around the video, so zooming keeps working.
  $("singlefull").textContent = L("Full screen", "Helskärm");
  $("singlefull").onclick = () => $("singlebox").requestFullscreen?.();
  $("livesub").onchange = () => liveChannel && showLive(liveChannel);
  $("snapshot").onclick = () => {
    if (!liveChannel) return;
    const a = document.createElement("a");
    a.href = `/api/snapshot?channel=${liveChannel - 1}`;
    a.download = `${camName(liveChannel)}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`;
    a.click();
  };
}

function startLiveTab() { setLiveMode(liveMode); }

function setLiveMode(mode) {
  if (document.fullscreenElement && mode !== liveMode) document.exitFullscreen().catch(() => {});
  liveMode = mode;
  store.set("liveMode", mode);
  $("mode-wall").classList.toggle("active", mode === "wall");
  $("mode-single").classList.toggle("active", mode === "single");
  ["wall", "wallpicker", "wallcontrols"].forEach(id => $(id).classList.toggle("hidden", mode !== "wall"));
  $("single").classList.toggle("hidden", mode !== "single");
  if (mode === "wall") { stopSingle(); drawWall(); }
  else { stopWall(); showLive(liveChannel || cams[0]?.channel); }
}

function wallColumns(n) {
  const fixed = $("layout").value;
  if (fixed !== "auto") return +fixed;
  return n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}

// Plays live fragmented MP4 from a WebSocket through Media Source Extensions,
// keeping the picture close to real time. Returns a function that stops it.
// Can this browser play H.265 directly? Then the camera's picture is not re-encoded.
const MSE_TYPES = { hvc1: 'video/mp4; codecs="hvc1.1.6.L153.B0"', hev1: 'video/mp4; codecs="hev1.1.6.L153.B0"',
                    avc1: 'video/mp4; codecs="avc1.640028"' };
const HEVC_OK = window.MediaSource?.isTypeSupported?.(MSE_TYPES.hvc1) || false;

function wsLive(video, channel, onState, sub = true) {
  let ws = null, ms = null, sb = null, queue = [], stopped = false, retry = null;
  const open = () => {
    ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
    ms.addEventListener("sourceopen", () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/live_ws?channel=${channel}&sub=${sub ? 1 : 0}${HEVC_OK ? "&hevc=1" : ""}`);
      ws.binaryType = "arraybuffer";
      let mime = MSE_TYPES.avc1;
      ws.onmessage = ev => {
        if (typeof ev.data === "string") {     // first message: which codec follows
          try {
            const info = JSON.parse(ev.data);
            mime = MSE_TYPES[info.codec] || mime;
            if (info.note === "sub") setTimeout(() => onState(L("The NVR refused full quality; showing the lighter stream",
              "NVR:en nekade full kvalitet; visar den lättare strömmen")), 1500);
          } catch (e) {}
          return;
        }
        if (!sb) {
          try { sb = ms.addSourceBuffer(mime); }
          catch (e) { onState(L("This browser cannot play the stream", "Webbläsaren kan inte spela strömmen")); return; }
          sb.addEventListener("updateend", pump);
        }
        queue.push(ev.data);
        pump();
      };
      ws.onclose = () => { if (!stopped) { onState(L("No picture, retrying …", "Ingen bild, försöker igen …")); restart(); } };
    }, { once: true });
  };
  let lastJump = 0, lastTrim = 0;
  const pump = () => {
    if (!sb || sb.updating || ms.readyState !== "open") return;
    const b = video.buffered, now = performance.now();
    if (b.length) {
      const end = b.end(b.length - 1);
      // Fell behind: play a little faster until caught up; only jump if far behind.
      const lag = end - video.currentTime;
      video.playbackRate = lag > 1.5 ? 1.25 : lag < 0.7 ? 1 : video.playbackRate;
      if (lag > 10 && !video.seeking && now - lastJump > 5000) {
        lastJump = now;
        video.currentTime = end - 0.5;
      }
      // Drop old video every 10 seconds so the buffer does not grow without end.
      if (video.currentTime - b.start(0) > 30 && now - lastTrim > 10000) {
        lastTrim = now;
        sb.remove(b.start(0), video.currentTime - 10);
        return;
      }
    }
    if (queue.length) {
      try { sb.appendBuffer(queue.shift()); } catch (e) { restart(); }
    }
    if (video.paused && video.readyState > 1) video.play().catch(() => {});
  };
  const close = () => {
    if (ws) { ws.onclose = null; ws.close(); }
    ws = null; sb = null; queue = [];
    if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute("src"); video.load(); }
  };
  let failures = 0;
  const restart = () => {
    close();
    clearTimeout(retry);
    failures++;
    // Wait longer after each failure (5, 10, 20 … at most 60 s) so failing cameras do not flood the NVR.
    retry = setTimeout(() => !stopped && open(), Math.min(60000, 5000 * 2 ** (failures - 1)));
  };
  video.onplaying = () => { failures = 0; onState(""); };
  video.ontimeupdate = () => { if (video.currentTime > 0 && failures >= 0) { video.ontimeupdate = null; onState(""); } };
  open();
  return () => { stopped = true; clearTimeout(retry); close(); };
}

let wallStops = [];

function drawWall() {
  stopWall();
  const wall = $("wall");
  const chosen = cams.filter(c => wallCams.includes(c.channel));
  if (!chosen.length) {
    wall.style.gridTemplateColumns = "1fr";
    wall.innerHTML = `<div class="wallempty">${L("Choose which cameras to show above.", "Välj ovan vilka kameror som ska visas.")}</div>`;
    return;
  }
  const cols = wallColumns(chosen.length);
  const shown = chosen.slice(0, cols * cols);
  wall.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  wall.style.setProperty("--rows", Math.ceil(shown.length / cols));
  wall.innerHTML = "";
  for (const c of shown) {
    const tile = el(`<div class="tile" title="${esc(L("Open in full quality", "Öppna i full kvalitet"))}">
      <video muted autoplay playsinline></video><div class="state">${L("Connecting …", "Ansluter …")}</div>
      <div class="label">${esc(c.name)}</div></div>`);
    const state = tile.querySelector(".state");
    tile.onclick = () => openFromWall(c.channel);
    wall.append(tile);
    wallStops.push(wsLive(tile.querySelector("video"), c.channel, text => (state.textContent = text)));
  }
  if (chosen.length > shown.length)
    toast(L(`Showing ${shown.length} of ${chosen.length}; choose a larger layout to see all.`,
            `Visar ${shown.length} av ${chosen.length}; välj en större layout för att se alla.`));
}

// Opens one camera from the overview; a click on it goes back to the overview
// (in full screen again if the overview was in full screen).
let fromWall = null;

async function openFromWall(ch) {
  const wasFull = document.fullscreenElement === $("wall");
  if (wasFull) await document.exitFullscreen().catch(() => {});
  liveChannel = ch;
  $("livesub").checked = false;
  setLiveMode("single");
  fromWall = { full: wasFull };
  $("liveplayer").controls = false;          // a click should go back, not pause
  $("singlebox").classList.add("fromwall");
  $("backhint").textContent = L("Click to return to the overview · scroll to zoom", "Klicka för att gå tillbaka till översikten · scrolla för att zooma");
  $("backhint").classList.remove("hidden");
  setTimeout(() => $("backhint").classList.add("hidden"), 4000);
  if (wasFull) $("singlebox").requestFullscreen?.().catch(() => {});
}

function leaveFromWall() {
  fromWall = null;
  $("liveplayer").controls = true;
  $("singlebox").classList.remove("fromwall");
  $("backhint").classList.add("hidden");
}

async function backToWall() {
  if (!fromWall) return;
  const full = fromWall.full;
  leaveFromWall();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  setLiveMode("wall");
  if (full) $("wall").requestFullscreen?.().catch(() => {});
}

function stopWall() {
  wallStops.forEach(stop => stop());
  wallStops = [];
  $("wall").innerHTML = "";
}

// Digital zoom for one camera: mouse wheel or pinch to zoom towards the pointer,
// drag to move around, double-click to reset.
const zoom = { scale: 1, x: 0, y: 0, moved: false };

function applyZoom() {
  const box = $("singlebox"), v = $("liveplayer");
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;    // not laid out (hidden); keep the current zoom
  // Keep the picture covering the box: no empty edges when zoomed in.
  zoom.x = Math.min(0, Math.max(w - w * zoom.scale, zoom.x));
  zoom.y = Math.min(0, Math.max(h - h * zoom.scale, zoom.y));
  v.style.transform = zoom.scale === 1 ? "" : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  box.classList.toggle("zoomed", zoom.scale > 1);
  $("zoomlevel").textContent = zoom.scale.toFixed(1).replace(".0", "") + "×";
  $("zoomlevel").classList.toggle("hidden", zoom.scale === 1);
}

function zoomAt(px, py, factor) {
  const next = Math.min(8, Math.max(1, zoom.scale * factor));
  // Keep the point under the pointer in place.
  zoom.x = px - (px - zoom.x) * (next / zoom.scale);
  zoom.y = py - (py - zoom.y) * (next / zoom.scale);
  zoom.scale = next;
  if (next === 1) { zoom.x = 0; zoom.y = 0; }
  applyZoom();
}

function resetZoom() { zoom.scale = 1; zoom.x = 0; zoom.y = 0; applyZoom(); }

function setupZoom() {
  const box = $("singlebox");
  const pos = ev => { const r = box.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const pointers = new Map();
  let start = null;
  box.addEventListener("wheel", ev => {
    ev.preventDefault();
    pointers.clear();      // a drag that never saw its button released must not move the picture later
    start = null;
    const [x, y] = pos(ev);
    zoomAt(x, y, ev.deltaY < 0 ? 1.25 : 0.8);
  }, { passive: false });
  box.addEventListener("dblclick", ev => { ev.preventDefault(); ev.stopPropagation(); resetZoom(); }, true);
  // Gestures are always measured from a baseline taken when a finger (or the mouse
  // button) goes down or lifts, so lifting one finger after a pinch never jumps.
  const baseline = () => {
    const pts = [...pointers.values()];
    if (!pts.length) { start = null; return; }
    const mid = pts.length > 1 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : null;
    start = { x: zoom.x, y: zoom.y, scale: zoom.scale, mid, dist };
  };
  box.addEventListener("pointerdown", ev => {
    if (!pointers.size) zoom.moved = false;
    pointers.set(ev.pointerId, pos(ev));
    baseline();
    box.setPointerCapture?.(ev.pointerId);
  });
  box.addEventListener("pointermove", ev => {
    if (!pointers.has(ev.pointerId) || !start) return;
    // A mouse with no button pressed is not dragging, whatever we last saw.
    if (ev.pointerType === "mouse" && !ev.buttons) { pointers.delete(ev.pointerId); baseline(); return; }
    pointers.set(ev.pointerId, pos(ev));
    const pts = [...pointers.values()];
    if (pts.length >= 2 && start.dist) {
      // Pinch: zoom around the starting midpoint, then follow the fingers as they move.
      const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      const factor = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) / start.dist;
      const next = Math.min(8, Math.max(1, start.scale * factor));
      zoom.scale = next;
      zoom.x = start.mid[0] - (start.mid[0] - start.x) * (next / start.scale) + (mid[0] - start.mid[0]);
      zoom.y = start.mid[1] - (start.mid[1] - start.y) * (next / start.scale) + (mid[1] - start.mid[1]);
      if (next === 1) { zoom.x = 0; zoom.y = 0; }
      zoom.moved = true;
      applyZoom();
    } else if (pts.length === 1 && zoom.scale > 1) {
      const [x, y] = pts[0];
      if (Math.abs(x - start.mid[0]) + Math.abs(y - start.mid[1]) > 4) zoom.moved = true;
      zoom.x = start.x + x - start.mid[0];
      zoom.y = start.y + y - start.mid[1];
      applyZoom();
    }
  });
  const up = ev => {
    if (!pointers.delete(ev.pointerId)) return;
    baseline();     // continue from where the picture is now
  };
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);
  box.addEventListener("lostpointercapture", up);
  document.addEventListener("fullscreenchange", () => setTimeout(applyZoom, 50));
}

let singleStop = null;

function showLive(ch) {
  liveChannel = ch;
  stopSingle();
  resetZoom();
  document.querySelectorAll("button.live").forEach(b => b.classList.toggle("active", +b.dataset.channel === ch));
  $("livenow").textContent = `${camName(ch)} – ${L("connecting …", "ansluter …")}`;
  // Show a still picture at once; the video can only start at the camera's next keyframe.
  $("liveplayer").poster = `/api/snapshot?channel=${ch - 1}&t=${Date.now()}`;
  singleStop = wsLive($("liveplayer"), ch, text => ($("livenow").textContent = text ? `${camName(ch)} – ${text}` : camName(ch)),
                      $("livesub").checked);
  $("snapshot").disabled = false;
}

function stopSingle() {
  if (singleStop) { singleStop(); singleStop = null; }
}

function stopLive() { stopWall(); stopSingle(); }

// --------------------------------------------------------------------- playback

const COLOR = { timing: "var(--timing)", motion: "var(--motion)", alarm: "var(--alarm)", manual: "var(--manual)" };
const MAX_CLIP = 15 * 60;   // one playback runs at most 15 minutes ahead
let items = [], current = null, playbackReady = false;

// The NVR stores local wall-clock time as if it were UTC, so everything here is in UTC.
function dayStart(date) { return Date.parse(date + "T00:00:00Z") / 1000; }
function clock(t) { return new Date(t * 1000).toLocaleTimeString(LANG === "sv" ? "sv-SE" : "en-GB", { timeZone: "UTC" }); }
function today() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

function setupPlayback() {
  $("cams").innerHTML = cams.map(c =>
    `<label><input type="checkbox" value="${c.channel}" checked> ${esc(c.name)}</label>`).join("");
  if (!$("date").value) $("date").value = today();
  $("scale").innerHTML = [0, 3, 6, 9, 12, 15, 18, 21, 24].map(h =>
    `<span style="left:${h / 24 * 100}%">${String(h).padStart(2, "0")}</span>`).join("");
  if (!playbackReady) {
    playbackReady = true;
    $("show").onclick = search;
    $("date").onchange = search;
    $("cams").onchange = search;
    $("prevday").onclick = () => moveDay(-1);
    $("nextday").onclick = () => moveDay(1);
    $("back").onclick = () => current && play(current.ch, current.start + Math.floor($("player").currentTime) - 30);
    $("fwd").onclick = () => current && play(current.ch, current.start + Math.floor($("player").currentTime) + 30);
    $("download").onclick = download;
  }
  search();
}

function moveDay(n) {
  const x = new Date($("date").value + "T12:00:00");
  x.setDate(x.getDate() + n);
  $("date").value = x.toISOString().slice(0, 10);
  search();
}

async function search() {
  const channels = [...document.querySelectorAll("#cams input:checked")].map(i => +i.value);
  $("searchstatus").textContent = L("Loading recordings …", "Hämtar inspelningar …");
  $("timelines").innerHTML = "";
  try {
    items = (await api("/api/search", { date: $("date").value, channels })).items;
    $("searchstatus").textContent = items.length
      ? L(`${items.length} recordings.`, `${items.length} inspelningar.`)
      : L("No recordings that day.", "Inga inspelningar den dagen.");
    drawTimelines(channels);
  } catch (e) { $("searchstatus").textContent = L("Could not load: ", "Kunde inte hämta: ") + e.message; }
}

function drawTimelines(channels) {
  const start = dayStart($("date").value);
  $("timelines").innerHTML = channels.map(ch => {
    const recs = items.filter(i => i.channel === ch).map(i => {
      const left = Math.max(0, (i.start - start) / 864), width = Math.max(0.05, (i.end - i.start) / 864);
      return `<div class="rec" style="left:${left}%;width:${width}%;background:${COLOR[i.type] || "var(--timing)"}"
        title="${TEXT[i.type] || TEXT.other} ${clock(i.start)}–${clock(i.end)}"></div>`;
    }).join("");
    return `<div class="name">${esc(camName(ch))}</div><div class="line" data-channel="${ch}">${recs}</div>`;
  }).join("");
  document.querySelectorAll(".line").forEach(l => l.addEventListener("click", ev => {
    const r = l.getBoundingClientRect();
    play(+l.dataset.channel, Math.round(start + (ev.clientX - r.left) / r.width * 86400));
  }));
}

function play(ch, t) {
  // Start in the recording that covers the time, otherwise the next one after it.
  const own = items.filter(i => i.channel === ch);
  const rec = own.find(i => i.start <= t && t < i.end) || own.find(i => i.start > t);
  if (!rec) { $("now").textContent = L("No recording after that time.", "Ingen inspelning efter den tiden."); return; }
  const from = Math.max(t, rec.start);
  // Continue across recordings that follow each other (hour changes, motion clips).
  let end = rec.end;
  for (const i of own) if (i.start <= end + 5 && i.end > end) end = i.end;
  const to = Math.min(end, from + MAX_CLIP);
  current = { ch, start: from, end: to, type: rec.type_code };
  $("player").src = `/api/playback?channel=${ch}&start=${from}&end=${to}&type=${rec.type_code}`
    + ($("player").canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') ? "&hevc=1" : "");
  $("player").play().catch(() => {});
  $("now").textContent = `${camName(ch)}: ${$("date").value} ${clock(from)}–${clock(to)} (${TEXT[rec.type] || TEXT.other})`;
  ["back", "fwd", "download"].forEach(id => $(id).disabled = false);
  document.querySelectorAll(".cursor").forEach(m => m.remove());
  const line = document.querySelector(`.line[data-channel="${ch}"]`);
  if (line) {
    const m = document.createElement("div");
    m.className = "cursor";
    m.style.left = ((from - dayStart($("date").value)) / 864) + "%";
    line.appendChild(m);
  }
}

function download() {
  if (!current) return;
  $("download").disabled = true;
  $("download").textContent = L("Fetching clip …", "Hämtar klippet …");
  setTimeout(() => { $("download").disabled = false; $("download").textContent = TEXT.download; }, 15000);
  location.href = `/api/download?channel=${current.ch}&start=${current.start}&end=${current.end}`
    + `&type=${current.type}&name=${encodeURIComponent(camName(current.ch))}`;
}

// ------------------------------------------------------------------------ start

document.querySelectorAll("[data-t]").forEach(el => el.textContent = TEXT[el.dataset.t]);
document.querySelectorAll("#tabs button").forEach(b => { b.textContent = TEXT[b.dataset.tab]; b.onclick = () => showTab(b.dataset.tab); });
$("apptitle").textContent = TEXT.title;
$("logintitle").textContent = TEXT.title;
$("logout").textContent = TEXT.logout;

$("loginform").addEventListener("submit", async ev => {
  ev.preventDefault();
  $("loginerror").textContent = "";
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nvr: $("nvr").value.trim(), user: $("user").value, pass: $("pass").value,
                           remember: $("remember").checked }) });
  $("pass").value = "";
  if (r.ok) return start();
  const body = await r.text();
  let err = "";
  try { err = JSON.parse(body).error; } catch (e) { err = body; }
  $("loginerror").textContent = err === "unreachable" ? L("Could not reach the NVR.", "Kunde inte nå NVR:en.")
    : err === "login" ? L("Wrong user name or password.", "Fel användarnamn eller lösenord.") : err;
});
$("logout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  $("player").removeAttribute("src");
  stopLive();
  showLogin();
};

fetch("/api/config").then(r => r.json()).then(c => { if (c.nvr) $("nvr").value = c.nvr.replace(/^https?:\/\//, ""); }).catch(() => {});
start().catch(() => showLogin());
