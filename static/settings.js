// Settings tab: the same pages as the NVR's own "Settings" menu.
// Each page loads the NVR's settings object, edits it in place and sends the
// whole object back, exactly as the NVR's own page does.

// ---------------------------------------------------------------- form helpers

// Reads or writes a nested value: path "Time.NTP.NtpServer".
function getPath(o, path) { return path.split(".").reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, path, v) {
  const keys = path.split("."), last = keys.pop();
  keys.reduce((a, k) => a[k], o)[last] = v;
}

const YESNO = [["True", L("Yes", "Ja")], ["False", L("No", "Nej")]];
const ONOFF = [["Enable", L("On", "På")], ["Disable", L("Off", "Av")]];
const opts = list => list.map(v => (Array.isArray(v) ? v : [v, v]));

// Builds a two-column form. Fields: { label, path, type, options, min, max, note, readonly }.
// type: text | password | number | select | bool (for "True"/"False") | range
function form(obj, fields) {
  const wrap = document.createElement("div");
  wrap.className = "form";
  for (const f of fields) {
    if (f.heading) { const h = document.createElement("h3"); h.textContent = f.heading; h.style.gridColumn = "1 / -1"; wrap.append(h); continue; }
    const label = document.createElement("label");
    label.textContent = f.label;
    const value = getPath(obj, f.path);
    let input;
    if (f.type === "select" || f.type === "bool") {
      input = document.createElement("select");
      const list = f.type === "bool" ? YESNO : opts(f.options);
      const values = list.map(o => String(o[0]));
      const all = values.includes(String(value)) || value == null ? list : [[value, value], ...list];
      input.innerHTML = all.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
      input.value = String(value);
      input.onchange = () => setPath(obj, f.path, typeof value === "number" ? +input.value : input.value);
    } else if (f.type === "range") {
      input = document.createElement("div");
      input.className = "row";
      input.innerHTML = `<input type="range" min="${f.min}" max="${f.max}" value="${value}"><span>${value}</span>`;
      const [r, s] = input.children;
      r.oninput = () => { s.textContent = r.value; setPath(obj, f.path, +r.value); f.onchange && f.onchange(); };
    } else {
      input = document.createElement("input");
      input.type = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
      input.value = value ?? "";
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.readonly) input.readOnly = true;
      if (f.maxlength) input.maxLength = f.maxlength;
      input.oninput = () => setPath(obj, f.path, f.type === "number" ? +input.value : input.value);
    }
    const cell = document.createElement("div");
    cell.append(input);
    if (f.note) { const n = document.createElement("div"); n.className = "muted"; n.textContent = f.note; cell.append(n); }
    wrap.append(label, cell);
  }
  return wrap;
}


function actions(...buttons) {
  const row = document.createElement("div");
  row.className = "actions";
  for (const [text, fn, cls] of buttons) {
    const b = document.createElement("button");
    b.textContent = text;
    if (cls) b.className = cls;
    b.onclick = async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } };
    row.append(b);
  }
  return row;
}

// Channel picker for per-channel pages. Channels are 1-based here; the NVR's arrays are 0-based.
function channelPicker(onChange, selected) {
  const row = el(`<div class="row"><label>${L("Channel", "Kanal")}</label><select></select></div>`);
  const sel = row.querySelector("select");
  sel.innerHTML = cams.map(c => `<option value="${c.channel}">${c.channel} · ${esc(c.name)}</option>`).join("");
  if (selected) sel.value = selected;
  sel.onchange = () => onChange(+sel.value);
  return row;
}

// "Copy to" checkboxes: returns a function giving the 0-based indexes picked.
function copyTo() {
  const row = el(`<div class="row"><label>${L("Also apply to", "Gäller även")}</label></div>`);
  for (const c of cams) row.append(el(`<label class="plain"><input type="checkbox" value="${c.channel - 1}"> ${esc(c.name)}</label>`));
  return { node: row, picked: () => [...row.querySelectorAll("input:checked")].map(i => +i.value) };
}

const DAYS = () => L("Sun Mon Tue Wed Thu Fri Sat", "Sön Mån Tis Ons Tor Fre Lör").split(" ");

// Week schedule editor: bits[day] is a 24-bit mask, bit n = hour n. Click or drag to toggle.
function scheduleGrid(bits, cls = "") {
  const g = document.createElement("div");
  g.className = "grid";
  g.append(el(`<div></div>`));
  for (let h = 0; h < 24; h++) g.append(el(`<div class="h">${h}</div>`));
  let painting = null;
  DAYS().forEach((name, d) => {
    g.append(el(`<div class="d">${name}</div>`));
    for (let h = 0; h < 24; h++) {
      const c = document.createElement("div");
      c.className = "c " + cls + ((bits[d] >> h) & 1 ? " on" : "");
      const apply = () => {
        if (painting) bits[d] |= (1 << h); else bits[d] &= ~(1 << h);
        bits[d] >>>= 0;
        c.classList.toggle("on", painting);
      };
      c.onmousedown = ev => { ev.preventDefault(); painting = !c.classList.contains("on"); apply(); };
      c.onmouseenter = () => painting !== null && apply();
      g.append(c);
    }
  });
  document.addEventListener("mouseup", () => (painting = null));
  const all = actions([L("Whole week", "Hela veckan"), () => { bits.fill(0xffffff); g.replaceWith(scheduleGrid(bits, cls)); }, "secondary small"],
                      [L("Clear", "Rensa"), () => { bits.fill(0); g.replaceWith(scheduleGrid(bits, cls)); }, "secondary small"]);
  const box = document.createElement("div");
  box.append(g, all);
  return box;
}

const snapshotUrl = ch => `/api/snapshot?channel=${ch - 1}&t=${Date.now()}`;
const NO_SNAPSHOT = L("No still image from this camera", "Ingen stillbild från den här kameran");

// ------------------------------------------------------------------- the pages

const PAGES = [
  ["deviceinfo", L("Device information", "Enhetsinformation"), pageDeviceInfo],
  ["record", L("Recording schedule", "Inspelningsschema"), pageRecord],
  ["time", L("Time and general", "Tid och allmänt"), pageTime],
  ["network", L("Network", "Nätverk"), pageNetwork],
  ["email", L("E-mail", "E-post"), pageEmail],
  ["wifi", L("Wi-Fi", "Wi-Fi"), pageWifi],
  ["color", L("Image", "Bild"), pageColor],
  ["encoding", L("Encoding", "Kodning"), pageEncoding],
  ["streamvalue", L("Stream value", "Strömvärden"), pageStreamValue],
  ["channeldetail", L("Channel detail", "Kanaldetaljer"), pageChannelDetail],
  ["osd", L("Channel names and OSD", "Kanalnamn och OSD"), pageOsd],
  ["detection", L("Video detection", "Videodetektering"), pageDetection],
  ["password", L("Change password", "Byt lösenord"), pagePassword],
  ["log", L("Log", "Logg"), pageLog],
  ["upgrade", L("Firmware upgrade", "Uppgradering"), pageUpgrade],
  ["factory", L("Restart and factory reset", "Omstart och fabriksåterställning"), pageFactory],
];
let settingsPage = "deviceinfo", pageTimer = null;

function openSettings() {
  $("settingsmenu").innerHTML = "";
  for (const [id, title] of PAGES) {
    const b = document.createElement("button");
    b.textContent = title;
    b.dataset.page = id;
    b.onclick = () => showPage(id);
    $("settingsmenu").append(b);
  }
  showPage(settingsPage);
}

async function showPage(id) {
  settingsPage = id;
  clearInterval(pageTimer);
  document.querySelectorAll("#settingsmenu button").forEach(b => b.classList.toggle("active", b.dataset.page === id));
  const [, title, render] = PAGES.find(p => p[0] === id);
  const page = $("settingspage");
  page.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${L("Loading …", "Hämtar …")}</p>`;
  try {
    const body = await render();
    page.innerHTML = `<h2>${esc(title)}</h2>`;
    page.append(body);
  } catch (e) {
    page.innerHTML = `<h2>${esc(title)}</h2><p class="error">${esc(e.message)}</p>`;
  }
}

async function pageDeviceInfo() {
  const [d, st] = await Promise.all([call("getDeviceInfo"), api("/api/status")]);
  const box = document.createElement("div");
  const rows = [[L("Device name", "Enhetsnamn"), d.DeviceName], [L("Model", "Modell"), d.DeviceModel],
    [L("Firmware", "Programvara"), d.FWVersion], [L("Built", "Byggd"), d.BuildTime],
    [L("Serial number", "Serienummer"), d.HWID], [L("Cloud ID", "Moln-id"), d.UID],
    [L("Channels", "Kanaler"), d.MAX_CHN]];
  box.append(el(`<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>`));
  const disk = st.disks[0] || {};
  const perDay = st.channels.reduce((a, c) => a + c.mb_per_hour, 0) * 24 / 1024;
  const days = perDay ? Math.round((parseFloat(st.total) || 0) / perDay) : null;
  box.append(el(`<h3>${L("Disk", "Hårddisk")}</h3>`));
  box.append(el(`<div class="muted">${esc(disk.model || "?")} · ${esc(st.total || "?")} · ${L("used", "använt")} ${esc(st.used_percent || "?")}
    ${days ? " · " + L(`lasts about ${days} days at the current rate (${Math.round(perDay)} GB/day)`, `räcker cirka ${days} dygn med nuvarande inspelning (${Math.round(perDay)} GB/dygn)`) : ""}
    <div class="bar"><div style="width:${parseFloat(st.used_percent) || 0}%"></div></div></div>`));
  box.append(el(`<h3>${L("Cameras", "Kameror")}</h3>`));
  box.append(el(`<div class="table"><table><tr><th>${L("Camera", "Kamera")}</th><th>${L("Channel", "Kanal")}</th>
    <th>${L("Main stream", "Huvudström")}</th><th>${L("Sub stream", "Underström")}</th><th>${L("Recording now", "Spelar in nu")}</th>
    <th>${L("Per hour", "Per timme")}</th><th>${L("Connection", "Anslutning")}</th></tr>
    ${st.channels.map(c => `<tr><td>${esc(c.name)}</td><td>${c.channel}</td><td>${esc(c.main)}</td><td>${esc(c.sub)}</td>
      <td>${c.kbps ? (c.kbps / 1000).toFixed(1) + " Mbit/s" : "–"}</td><td>${c.mb_per_hour} MB</td><td>${esc(c.connection)}</td></tr>`).join("")}
    </table></div>`));
  return box;
}

async function pageRecord() {
  const rec = await call("getRecord");
  const box = document.createElement("div");
  const TYPES = [["Timer", L("Scheduled", "Schemalagd"), ""], ["Motion", L("Motion", "Rörelse"), "motion"], ["Alarm", L("Alarm", "Larm"), "alarm"]];
  let ch = cams[0].channel, type = "Timer";
  const body = document.createElement("div");
  const copy = copyTo();
  function draw() {
    const i = ch - 1;
    body.innerHTML = "";
    body.append(form(rec.RecordTriggers[i], [
      { label: L("Recording on", "Inspelning på"), path: "MasterSwitch", type: "bool" },
      { label: L("Continuous recording", "Kontinuerlig inspelning"), path: "Continuous", type: "bool" },
      { label: L("Motion recording", "Rörelseinspelning"), path: "Motion", type: "bool" },
      { label: L("Record sound", "Spela in ljud"), path: "AudioSwitch", type: "bool" },
    ]));
    const chips = el(`<div class="row"></div>`);
    for (const [key, name] of TYPES) {
      const b = el(`<button class="chip secondary small ${key === type ? "active" : ""}">${name}</button>`);
      b.onclick = () => { type = key; draw(); };
      chips.append(b);
    }
    body.append(el(`<h3>${L("Schedule", "Schema")}</h3>`), chips,
                scheduleGrid(rec.BitRecordSchedule[i][type], TYPES.find(t => t[0] === type)[2]));
  }
  box.append(channelPicker(c => { ch = c; draw(); }), body, copy.node, actions([L("Save", "Spara"), async () => {
    const i = ch - 1;
    for (const j of copy.picked()) {
      if (j === i) continue;
      for (const [key] of TYPES) rec.BitRecordSchedule[j][key] = [...rec.BitRecordSchedule[i][key]];
      Object.assign(rec.RecordTriggers[j], { ...rec.RecordTriggers[i], ID: j });
    }
    await saved(call("setRecord", rec));
  }]));
  draw();
  return box;
}

async function pageTime() {
  const [gen, stat] = await Promise.all([call("getGeneral"), call("getStat")]);
  const clockData = { Date: stat.SystemState?.Date || "", Time: stat.SystemState?.Time || "" };
  let clockChanged = false;
  const vga = gen.Screen.VGAResolution;
  const box = document.createElement("div");
  const clockForm = form(clockData, [
    { label: L("Date (YYYY-MM-DD)", "Datum (ÅÅÅÅ-MM-DD)"), path: "Date" },
    { label: L("Time (HH:MM:SS)", "Tid (TT:MM:SS)"), path: "Time" },
  ]);
  clockForm.addEventListener("input", () => (clockChanged = true));
  box.append(clockForm, actions([L("Use this computer's time", "Använd den här datorns tid"), async () => {
    const n = new Date();
    clockData.Date = n.toLocaleDateString("sv-SE");
    clockData.Time = n.toLocaleTimeString("sv-SE");
    clockChanged = true;
    clockForm.querySelectorAll("input")[0].value = clockData.Date;
    clockForm.querySelectorAll("input")[1].value = clockData.Time;
  }, "secondary small"]));
  const zones = ["+00:00", "+01:00", "+02:00", "+03:00", "+03:30", "+04:00", "+04:30", "+05:00", "+05:30", "+05:45", "+06:00",
    "+06:30", "+07:00", "+08:00", "+09:00", "+09:30", "+10:00", "+11:00", "+12:00", "+13:00", "-01:00", "-02:00", "-03:00",
    "-03:30", "-04:00", "-05:00", "-06:00", "-07:00", "-08:00", "-09:00", "-10:00", "-11:00", "-12:00"];
  box.append(form(gen, [
    { label: L("Device name", "Enhetsnamn"), path: "DeviceName" },
    { label: L("Time zone", "Tidszon"), path: "Time.TimeZone", type: "select", options: zones },
    { label: L("Date format", "Datumformat"), path: "Time.DateFMT", type: "select", options: ["YYYY/MM/DD", "MM/DD/YYYY", "DD/MM/YYYY"] },
    { label: L("Time format", "Tidsformat"), path: "Time.TimeFMT", type: "select", options: ["24h", "12h"] },
    { label: L("Synchronise time (NTP)", "Synkronisera tid (NTP)"), path: "Time.NTP.IsSyncTime", type: "bool" },
    { label: L("NTP server", "NTP-server"), path: "Time.NTP.NtpServer" },
    { label: L("Daylight saving time", "Sommartid"), path: "Time.SummerTime.SummerTimeUse", type: "bool" },
    { label: L("Key buzzer", "Knappljud"), path: "KeyBuzzer", type: "select", options: ONOFF },
    { label: L("Menu transparency", "Menyns genomskinlighet"), path: "Screen.Alpha", type: "number", min: 0, max: 128 },
    { label: L("Monitor resolution", "Skärmupplösning"), path: "Screen.VGAResolution", type: "select",
      options: ["1024x768", "1280x1024", "1366x768", "1440x900", "1080p@50Hz", "1080p@60Hz"],
      note: L("Changing it restarts the NVR.", "Ändring startar om NVR:en.") },
    { heading: L("Disk", "Hårddisk") },
    { label: L("Overwrite oldest recordings when full", "Skriv över äldsta inspelningar när disken är full"), path: "HDD.Overwrite", type: "bool" },
    { heading: L("Automatic maintenance restart", "Automatisk omstart för underhåll") },
    { label: L("When", "När"), path: "Maintenance.Mode", type: "select",
      options: [["Never", L("Never", "Aldrig")], ["Everyday", L("Every day", "Varje dag")], ["Everyweek", L("Every week", "Varje vecka")], ["Everymonth", L("Every month", "Varje månad")]] },
    { label: L("Time", "Klockslag"), path: "Maintenance.Time" },
  ]));
  box.append(actions([L("Save", "Spara"), async () => {
    if (gen.Screen.VGAResolution !== vga &&
        !await confirmDialog(L("The NVR restarts to change the monitor resolution.", "NVR:en startar om för att byta skärmupplösning."))) return;
    if (clockChanged) {
      const r = await call("setLocalTime", { TimeZone: gen.Time.TimeZone, Date: clockData.Date, Time: clockData.Time });
      if (!succeeded(r)) return toast(L("The clock was not set: ", "Klockan ställdes inte: ") + (r.RetDetail || ""), true);
    }
    const r = await saved(call("setGeneral", gen));
    if (succeeded(r) && gen.Screen.VGAResolution !== vga) call("reboot");
  }]));
  return box;
}

async function pageNetwork() {
  const [net, ppp] = await Promise.all([call("getNetwork"), call("getPppoeParam")]);
  const pppoe = { PPPoEUse: ppp.PPPoEUse, UserName: ppp.UserName ?? ppp.PPPoEUser ?? "",
                  PassWord: ppp.PassWord ?? ppp.PPPoEPwd ?? "", PPPoEProtocol: "Auto" };
  const box = document.createElement("div");
  box.append(el(`<p class="warn">${L("Wrong values here can make the NVR unreachable. The cameras and this page then stop working until it is fixed on the NVR's own screen.",
    "Fel värden här kan göra NVR:en onåbar. Kamerorna och den här sidan slutar då fungera tills det rättas på NVR:ens egen skärm.")}</p>`));
  box.append(form(net, [
    { label: L("Get address automatically (DHCP)", "Hämta adress automatiskt (DHCP)"), path: "Network.DHCPUse", type: "bool" },
    { label: L("IP address", "IP-adress"), path: "Network.IPAddr" },
    { label: L("Subnet mask", "Nätmask"), path: "Network.SubMask" },
    { label: L("Gateway", "Gateway"), path: "Network.Gateway" },
    { label: L("DNS server", "DNS-server"), path: "Network.DNSAddr" },
    { label: L("DNS server 2", "DNS-server 2"), path: "Network.DNSAddr2" },
    { label: L("Web port", "Webbport"), path: "Network.PortHTTP", type: "number" },
    { label: L("MAC address", "MAC-adress"), path: "Network.MACAddr", readonly: true },
    { label: L("Video stream server (RTSP)", "Videoströmserver (RTSP)"), path: "NetworkService.RtspServer.Enabled", type: "bool",
      note: L("Needed for live view on this page and in other programs.", "Behövs för livebild här och i andra program.") },
    { heading: "DDNS" },
    { label: L("Use DDNS", "Använd DDNS"), path: "DDNS.DDNSUse", type: "bool" },
    { label: L("Provider", "Leverantör"), path: "DDNS.DDNSProvider", type: "select", options: ["Hiview", "Dyndns", "3322", "Changeip", "No-ip", "Oray", "NVR163"] },
    { label: L("Domain name", "Domännamn"), path: "DDNS.DDNSUrl" },
    { label: L("User name", "Användarnamn"), path: "DDNS.DDNSUser" },
    { label: L("Password", "Lösenord"), path: "DDNS.DDNSPassword", type: "password" },
  ]));
  box.append(el(`<h3>PPPoE</h3>`), form(pppoe, [
    { label: L("Use PPPoE", "Använd PPPoE"), path: "PPPoEUse", type: "bool" },
    { label: L("User name", "Användarnamn"), path: "UserName" },
    { label: L("Password", "Lösenord"), path: "PassWord", type: "password" },
  ]));
  box.append(actions([L("Save", "Spara"), async () => {
    if (!await confirmDialog(L("Save the network settings? If the address changes, open this page's NVR address again.",
      "Spara nätverksinställningarna? Om adressen ändras måste NVR-adressen här också ändras."))) return;
    const r = await saved(call("setNetwork", net));
    if (succeeded(r)) await call("setPppoeParam", pppoe).catch(() => {});
  }]));
  return box;
}

async function pageEmail() {
  const mail = await call("getEmail");
  const box = document.createElement("div");
  box.append(form(mail, [
    { label: L("Send e-mail", "Skicka e-post"), path: "SMTPUse", type: "bool" },
    { label: L("Provider", "Leverantör"), path: "SMTPProvider", type: "select", options: ["USER CUSTOM", "163", "126", "qq", "sina", "hotmail", "yahoo", "icloud", "gmail", "sohu", "outlook"] },
    { label: L("SMTP server", "SMTP-server"), path: "SMTPServer" },
    { label: L("Port", "Port"), path: "SMTPPort", type: "number" },
    { label: L("Encryption", "Kryptering"), path: "SMTPEncryptType", type: "select", options: ["None", "TLS", "SSL"] },
    { label: L("Sender", "Avsändare"), path: "SMTPSender" },
    { label: L("Password", "Lösenord"), path: "SMTPPwd", type: "password" },
    { label: L("Recipient 1", "Mottagare 1"), path: "SMTPSendee1" },
    { label: L("Recipient 2", "Mottagare 2"), path: "SMTPSendee2" },
    { label: L("Subject", "Ämne"), path: "SMTPSubject" },
    { label: L("Interval (seconds)", "Intervall (sekunder)"), path: "SMTPInterval", type: "number" },
    { label: L("Health e-mail", "Hälsorapport per e-post"), path: "SMTPHealthEnable", type: "bool" },
    { label: L("Health e-mail interval (minutes)", "Intervall för hälsorapport (minuter)"), path: "SMTPHealthInterval", type: "number" },
  ]));
  box.append(actions([L("Save", "Spara"), () => saved(call("setEmail", mail))],
    [L("Send test e-mail", "Skicka testmejl"), async () => {
      const r = await call("testEmail", mail);
      toast(succeeded(r) ? L("Test e-mail sent", "Testmejl skickat") : (r.RetDetail || L("Test failed", "Testet misslyckades")), !succeeded(r));
    }, "secondary"]));
  return box;
}

async function pageWifi() {
  const [wifi, net] = await Promise.all([call("getWifi"), call("getNetwork")]);
  const box = document.createElement("div");
  box.append(el(`<p class="muted">${L("The NVR's own wireless network, which the cameras connect to.", "NVR:ens eget trådlösa nät, som kamerorna ansluter till.")}</p>`));
  box.append(form(wifi, [
    { label: L("Network name (ESSID)", "Nätverksnamn (ESSID)"), path: "WifiESSID", readonly: true },
    { label: L("Password", "Lösenord"), path: "WifiPassword", type: "password", readonly: true },
    { label: L("Wireless channel", "Trådlös kanal"), path: "WifiChn", type: "select", options: ["Auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"] },
    { label: L("Region", "Region"), path: "WifiRegion", type: "select", options: ["FCC", "EU", "MKK"] },
  ]));
  box.append(actions([L("Save", "Spara"), () => saved(call("setWifi", { Region: wifi.WifiRegion, Channel: wifi.WifiChn }))],
    [L("Reset name and password", "Återställ namn och lösenord"), async () => {
      if (!await confirmDialog(L("Reset the NVR's wireless name and password? The cameras may need to be paired again.",
        "Återställa NVR:ens trådlösa namn och lösenord? Kamerorna kan behöva paras om."))) return;
      await saved(call("resetWifi"));
      showPage("wifi");
    }, "danger"]));
  if (net.WIFI && "AutoAdaptChnReslution" in net.WIFI) {
    box.append(el(`<h3>${L("Automatic camera resolution", "Automatisk kameraupplösning")}</h3>`));
    box.append(el(`<p class="muted">${L("When on, the NVR lowers the wireless cameras' resolution by itself (the setting is hidden in the NVR's own page).",
      "När den är på sänker NVR:en själv de trådlösa kamerornas upplösning (inställningen är dold i NVR:ens egen sida).")}</p>`));
    box.append(form(net, [{ label: L("Adjust resolution automatically", "Anpassa upplösningen automatiskt"), path: "WIFI.AutoAdaptChnReslution", type: "bool" }]));
    box.append(actions([L("Save", "Spara"), () => saved(call("setNetwork", net))]));
  }
  return box;
}

async function pageColor() {
  const color = await call("getStreamColor");
  const box = document.createElement("div");
  let ch = cams[0].channel;
  const img = el(`<img class="snap" alt="${NO_SNAPSHOT}">`);
  const body = document.createElement("div");
  const copy = copyTo();
  function draw() {
    img.src = snapshotUrl(ch);
    body.innerHTML = "";
    const fields = [["Hue", L("Hue", "Färgton")], ["Brightness", L("Brightness", "Ljusstyrka")],
      ["Contrast", L("Contrast", "Kontrast")], ["Saturation", L("Saturation", "Färgmättnad")]];
    if ("Sharpness" in color[ch - 1]) fields.push(["Sharpness", L("Sharpness", "Skärpa")]);
    body.append(form(color[ch - 1], fields.map(([path, label]) => ({ label, path, type: "range", min: 0, max: 64 }))));
  }
  box.append(channelPicker(c => { ch = c; draw(); }), img, body, copy.node, actions([L("Save", "Spara"), async () => {
    for (const j of copy.picked()) if (j !== ch - 1) Object.assign(color[j], { ...color[ch - 1], ID: color[j].ID });
    await saved(call("setStreamColor", color));
    setTimeout(() => (img.src = snapshotUrl(ch)), 1500);
  }], [L("Default values", "Standardvärden"), () => {
    Object.assign(color[ch - 1], { Hue: 32, Brightness: 32, Contrast: 32, Saturation: 32, ...("Sharpness" in color[ch - 1] ? { Sharpness: 32 } : {}) });
    draw();
  }, "secondary"]));
  draw();
  return box;
}

const BITRATES = ["32kbps", "64kbps", "128kbps", "256kbps", "384kbps", "512kbps", "768kbps", "1Mbps", "1.5Mbps", "2Mbps", "3Mbps", "4Mbps", "5Mbps", "6Mbps", "8Mbps"];
const kbps = v => parseFloat(v) * (/Mbps/.test(v) ? 1024 : 1);

async function pageEncoding() {
  const stream = await call("getStream");
  const encode = stream.Encode, ranges = stream.EncodeRange || [];
  const box = document.createElement("div");
  box.append(el(`<p class="muted">${L("Note: with automatic camera resolution on (see Wi-Fi), the NVR sets wireless cameras back to its own choice within seconds.",
    "Obs: med automatisk kameraupplösning påslagen (se Wi-Fi) sätter NVR:en tillbaka trådlösa kameror till sitt eget val inom några sekunder.")}</p>`));
  let ch = cams[0].channel;
  const body = document.createElement("div");
  function streamFields(s, r, title) {
    const fps = [];
    for (let f = r?.Fps?.Min || 1; f <= (r?.Fps?.Max || 30); f++) fps.push(f + "fps");
    const bps = BITRATES.filter(b => !r?.Bps || (kbps(b) >= r.Bps.Min && kbps(b) <= r.Bps.Max));
    return [{ heading: title },
      { label: L("Resolution", "Upplösning"), path: "Format", type: "select", options: (r?.Resolution || [s.Format]).filter(x => x !== "0x0") },
      { label: L("Bit rate control", "Bithastighetsstyrning"), path: "BitrateMode", type: "select",
        options: [["Variable", L("Variable", "Variabel")], ["Constant", L("Constant", "Konstant")], ["Average", L("Average", "Genomsnitt")]] },
      { label: L("Bit rate", "Bithastighet"), path: "BitrateValue", type: "select", options: bps },
      { label: L("Frame rate", "Bildtakt"), path: "Framerate", type: "select", options: fps },
      { label: L("Coding", "Kodning"), path: "CodingFmt", type: "select", options: (r?.CodingFmt || [s.CodingFmt]).map(x => x.trim()).filter(Boolean) }];
  }
  function draw() {
    const e = encode.find(x => x.ID === ch - 1), r = ranges.find(x => x.ID === ch - 1);
    body.innerHTML = "";
    body.append(form(e.Stream[0], streamFields(e.Stream[0], r?.Stream?.[0], L("Main stream", "Huvudström"))));
    body.append(form(e.Stream[1], streamFields(e.Stream[1], r?.Stream?.[1], L("Sub stream", "Underström"))));
  }
  box.append(channelPicker(c => { ch = c; draw(); }), body, actions([L("Save", "Spara"), () => saved(call("setStreamEncode", encode))]));
  draw();
  return box;
}

async function pageStreamValue() {
  const box = document.createElement("div");
  const table = el(`<div class="table"></div>`);
  async function refresh() {
    const r = await call("getBitrate");
    table.innerHTML = `<table><tr><th>${L("Channel", "Kanal")}</th><th>${L("Camera", "Kamera")}</th><th>kbit/s</th><th>MB/${L("h", "tim")}</th></tr>
      ${(r.Item || []).filter(i => cams.some(c => "Ch" + c.channel === i.Channel)).map(i => { const ch = +i.Channel.slice(2);
        return `<tr><td>${ch}</td><td>${esc(camName(ch))}</td><td>${esc(i["Kb/s"])}</td><td>${esc(i["MB/H"])}</td></tr>`; }).join("")}</table>`;
  }
  await refresh();
  pageTimer = setInterval(() => refresh().catch(() => {}), 2000);
  box.append(table);
  return box;
}

async function pageChannelDetail() {
  const r = await call("getChannelDetail");
  return el(`<div class="table"><table><tr><th>${L("Channel", "Kanal")}</th><th>${L("Camera", "Kamera")}</th><th>${L("Main stream", "Huvudström")}</th>
    <th>${L("Sub stream", "Underström")}</th><th>${L("Camera software", "Kamerans programvara")}</th></tr>
    ${(r.Item || []).map((d, i) => d.MainStream ? `<tr><td>${i + 1}</td><td>${esc(camName(i + 1))}</td><td>${esc(d.MainStream)}</td>
      <td>${esc(d.SubStream)}</td><td>${esc(d.SWVersion)}</td></tr>` : "").join("")}</table></div>`);
}

async function pageOsd() {
  const stream = await call("getStream");
  const box = document.createElement("div");
  box.append(el(`<p class="muted">${L("The name is shown in the camera image and on this page (unless CHANNEL_NAMES overrides it). At most 16 characters. The NVR only accepts the letters A–Z: å, ä, ö and other accented letters are replaced (å → a, ö → o …).",
    "Namnet visas i kamerabilden och på den här sidan (om inte CHANNEL_NAMES anger annat). Högst 16 tecken. NVR:en klarar bara bokstäverna A–Z: å, ä, ö och andra specialtecken byts ut (å → a, ö → o …).")}</p>`));
  const titles = {};
  stream.Title.forEach(t => (titles["c" + t.ID] = t.Text));
  box.append(form(titles, stream.Title.filter(t => t.ID < maxChannels).map(t =>
    ({ label: `${L("Channel", "Kanal")} ${t.ID + 1}`, path: "c" + t.ID, maxlength: 16 }))));   // as in the NVR's own page
  box.append(form(stream.OSD, [
    { heading: L("Shown in the image", "Visas i bilden") },
    { label: L("Connection quality", "Anslutningskvalitet"), path: "ConnectQuality", type: "select", options: ONOFF },
    ...("ChnStatus" in stream.OSD ? [{ label: L("Channel status", "Kanalstatus"), path: "ChnStatus", type: "select", options: ONOFF }] : []),
  ]));
  box.append(actions([L("Save", "Spara"), async () => {
    // The NVR cuts a name at the first letter outside A–Z, so replace accented letters first.
    const plain = text => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[æÆ]/g, m => (m === "æ" ? "ae" : "AE")).replace(/[øØ]/g, m => (m === "ø" ? "o" : "O")).replace(/[^\x20-\x7e]/g, "");
    stream.Title.forEach(t => (t.Text = plain(titles["c" + t.ID])));
    // The whole Stream object is refused ("Save failure"); only the parts this page edits are accepted.
    const r = await saved(call("setStream", { OSD: stream.OSD, Title: stream.Title }));
    if (succeeded(r)) cams = (await api("/api/info")).channels;
  }]));
  return box;
}

async function pageDetection() {
  const ev = await call("getEvent");
  const box = document.createElement("div");
  let ch = cams[0].channel, kind = "MotionDetection";
  const body = document.createElement("div");
  const copy = copyTo();
  const DURATIONS = [["1 seconds", "1 s"], ["2 seconds", "2 s"], ["3 seconds", "3 s"], ["4 seconds", "4 s"], ["5 seconds", "5 s"],
    ["8 seconds", "8 s"], ["10 seconds", "10 s"], ["Continued", L("Continuous", "Kontinuerligt")]];
  function areaEditor(md) {
    // MDArea: 18 rows, each a 22-bit mask (bit n = column n).
    const wrap = el(`<div class="area"><img alt="${NO_SNAPSHOT}"><div class="cells"></div></div>`);
    wrap.querySelector("img").src = snapshotUrl(ch);
    const cells = wrap.querySelector(".cells");
    let painting = null;
    for (let r = 0; r < 18; r++) for (let c = 0; c < 22; c++) {
      const d = document.createElement("div");
      if ((md.MDArea[r] >> c) & 1) d.className = "on";
      const apply = () => { if (painting) md.MDArea[r] |= (1 << c); else md.MDArea[r] &= ~(1 << c); d.classList.toggle("on", painting); };
      d.onmousedown = e => { e.preventDefault(); painting = !d.classList.contains("on"); apply(); };
      d.onmouseenter = () => painting !== null && apply();
      cells.append(d);
    }
    document.addEventListener("mouseup", () => (painting = null));
    const box = document.createElement("div");
    box.append(wrap, actions([L("Whole image", "Hela bilden"), () => { md.MDArea.fill(0x3fffff); draw(); }, "secondary small"],
                             [L("Clear", "Rensa"), () => { md.MDArea.fill(0); draw(); }, "secondary small"]));
    return box;
  }
  function draw() {
    const i = ch - 1;
    body.innerHTML = "";
    const chips = el(`<div class="row"></div>`);
    for (const [key, name] of [["MotionDetection", L("Motion", "Rörelse")], ["VideoLoss", L("Video loss", "Videobortfall")]]) {
      const b = el(`<button class="chip secondary small ${key === kind ? "active" : ""}">${name}</button>`);
      b.onclick = () => { kind = key; draw(); };
      chips.append(b);
    }
    body.append(chips);
    if (kind === "MotionDetection") {
      const md = ev.MotionDetection[i];
      const fields = [
        { label: L("Motion detection", "Rörelsedetektering"), path: "MDEnable", type: "bool" },
        { label: L("Sensitivity", "Känslighet"), path: "MDSensitivity", type: "select",
          options: [["Highest", L("Highest", "Högst")], ["High", L("Higher", "Hög")], ["Medium", L("Medium", "Medel")], ["Low", L("Lower", "Låg")], ["Lowest", L("Lowest", "Lägst")]] },
        { label: L("Alarm lasts", "Larmet varar"), path: "Duration", type: "select", options: DURATIONS },
        { label: L("Buzzer", "Summer"), path: "Actions.Buzzer", type: "bool" },
        { label: L("E-mail", "E-post"), path: "Actions.SMTP", type: "bool" },
        { label: L("Phone app alarm", "Larm i mobilappen"), path: "Actions.AppAlarm", type: "bool" },
        { label: L("Full screen on the monitor", "Helskärm på NVR:ens skärm"), path: "Actions.FullScreen", type: "bool" },
      ];
      if (md.humanDetect?.[0]) fields.push({ label: L("Person detection", "Persondetektering"), path: "humanDetect.0.HumanEnable", type: "bool" });
      body.append(form(md, fields));
      body.append(el(`<h3>${L("Area (click or drag)", "Område (klicka eller dra)")}</h3>`), areaEditor(md));
      body.append(el(`<h3>${L("Schedule", "Schema")}</h3>`), scheduleGrid(md.BitWorkdayShedule, "motion"));
    } else {
      const vl = ev.VideoLoss[i];
      body.append(form(vl, [
        { label: L("Alarm lasts", "Larmet varar"), path: "Duration", type: "select", options: DURATIONS },
        { label: L("Buzzer", "Summer"), path: "Actions.Buzzer", type: "bool" },
        { label: L("E-mail", "E-post"), path: "Actions.SMTP", type: "bool" },
      ]));
      body.append(el(`<h3>${L("Schedule", "Schema")}</h3>`), scheduleGrid(vl.BitWorkdayShedule, "alarm"));
    }
  }
  box.append(channelPicker(c => { ch = c; draw(); }), body, copy.node, actions([L("Save", "Spara"), async () => {
    const i = ch - 1;
    for (const j of copy.picked()) {
      if (j === i) continue;
      ev[kind][j] = { ...JSON.parse(JSON.stringify(ev[kind][i])), ID: ev[kind][j].ID };
    }
    await saved(call("setEvent", ev));
  }]));
  draw();
  return box;
}

async function pagePassword() {
  const data = { NewPasswd: "", Confirm: "" };
  const box = document.createElement("div");
  box.append(el(`<p class="muted">${L("Changes the password of the user you are logged in as. Remember to update other programs that use it (for example camera software or Home Assistant).",
    "Byter lösenord för användaren du är inloggad som. Kom ihåg att uppdatera andra program som använder det (till exempel kameraprogram eller Home Assistant).")}</p>`));
  box.append(form(data, [
    { label: L("New password", "Nytt lösenord"), path: "NewPasswd", type: "password" },
    { label: L("Repeat new password", "Upprepa nytt lösenord"), path: "Confirm", type: "password" },
  ]));
  box.append(actions([L("Change password", "Byt lösenord"), async () => {
    if (!data.NewPasswd || data.NewPasswd !== data.Confirm) return toast(L("The passwords do not match", "Lösenorden är inte lika"), true);
    if (!await confirmDialog(L("Change the NVR password?", "Byta NVR:ens lösenord?"))) return;
    await saved(call("changePassword", { NewPasswd: data.NewPasswd }));
  }]));
  return box;
}

async function pageLog() {
  const today = new Date().toLocaleDateString("sv-SE");
  const q = { Type: 7, BeginDate: today, BeginTime: "00:00:00", EndDate: today, EndTime: "23:59:59", PageSize: 20 };
  const TYPES = [L("System startup", "Systemstart"), L("System shutdown", "Avstängning"), L("Configuration change", "Inställningsändring"),
    L("Recording", "Inspelning"), L("Alarm", "Larm"), L("Device warning", "Enhetsvarning"), L("Exception", "Fel"), L("All", "Alla")];
  const box = document.createElement("div");
  box.append(form(q, [
    { label: L("Type", "Typ"), path: "Type", type: "select", options: TYPES.map((t, i) => [i, t]) },
    { label: L("From date", "Från datum"), path: "BeginDate" }, { label: L("From time", "Från tid"), path: "BeginTime" },
    { label: L("To date", "Till datum"), path: "EndDate" }, { label: L("To time", "Till tid"), path: "EndTime" },
  ]));
  const out = document.createElement("div");
  let page = 1, pages = 1;
  const render = items => {
    if (!items.length) { out.innerHTML = `<p class="muted">${L("No entries.", "Inga poster.")}</p>`; return; }
    const keys = Object.keys(items.find(i => typeof i === "object") || {});
    out.innerHTML = `<div class="table"><table><tr>${keys.map(k => `<th>${esc(k)}</th>`).join("")}</tr>
      ${items.filter(i => typeof i === "object").map(i => `<tr>${keys.map(k => `<td>${esc(i[k])}</td>`).join("")}</tr>`).join("")}</table></div>
      <div class="row"><span class="muted">${L("Page", "Sida")} ${page} / ${pages}</span></div>`;
    const nav = actions([L("Previous", "Föregående"), () => goTo(page - 1), "secondary small"], [L("Next", "Nästa"), () => goTo(page + 1), "secondary small"]);
    out.append(nav);
  };
  async function goTo(p) {
    if (p < 1 || p > pages) return;
    page = p;
    const r = await call("logPage", { ...q, CurrentPage: p });
    render(r.Item || []);
  }
  box.append(actions([L("Search", "Sök"), async () => {
    const r = await call("logSearch", q);
    page = 1;
    pages = Math.max(1, Math.ceil((+r.SearchCnt || 0) / q.PageSize));
    render((r.Item || []).filter(i => i !== 0));
  }]), out);
  return box;
}

async function pageUpgrade() {
  const box = document.createElement("div");
  box.append(el(`<p class="warn">${L("Only use firmware made for exactly this model. A wrong file can make the NVR unusable. Do not switch off the NVR during the upgrade.",
    "Använd bara programvara gjord för exakt den här modellen. Fel fil kan göra NVR:en obrukbar. Stäng inte av NVR:en under uppgraderingen.")}</p>`));
  box.append(el(`<p class="muted">${L("Current version", "Nuvarande version")}: ${esc(device.FWVersion)} (${esc(device.BuildTime)})</p>`));
  const file = el(`<input type="file" accept=".rom">`);
  const status = el(`<p class="muted"></p>`);
  box.append(file, actions([L("Upgrade", "Uppgradera"), async () => {
    const f = file.files[0];
    if (!f) return toast(L("Choose a .rom file", "Välj en .rom-fil"), true);
    if (!await confirmDialog(L(`Upgrade the NVR with ${f.name}?`, `Uppgradera NVR:en med ${f.name}?`), L("Upgrade", "Uppgradera"))) return;
    status.textContent = L("Uploading …", "Laddar upp …");
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch("/api/upgrade", { method: "POST", body: fd });
    status.textContent = r.ok ? L("Uploaded. The NVR is upgrading …", "Uppladdad. NVR:en uppgraderar …") : await r.text();
    pageTimer = setInterval(async () => {
      try { const p = await call("getUpgradeRate"); status.textContent = L("Progress: ", "Förlopp: ") + JSON.stringify(p).slice(0, 120); }
      catch (e) { status.textContent = L("The NVR is restarting …", "NVR:en startar om …"); }
    }, 2000);
  }, "danger"]), status);
  return box;
}

async function pageFactory() {
  const box = document.createElement("div");
  box.append(actions([L("Restart the NVR", "Starta om NVR:en"), async () => {
    if (!await confirmDialog(L("Restart the NVR? Recording stops for a minute or two.", "Starta om NVR:en? Inspelningen står still en minut eller två."), L("Restart", "Starta om"))) return;
    await saved(call("reboot"));
  }, "secondary"]));
  box.append(el(`<h3>${L("Factory reset", "Fabriksåterställning")}</h3>`));
  box.append(el(`<p class="warn">${L("Resets the settings to how the NVR was delivered and restarts it. A full reset also removes the cameras and network settings.",
    "Återställer inställningarna till hur NVR:en levererades och startar om den. En fullständig återställning tar också bort kamerorna och nätverksinställningarna.")}</p>`));
  const reset = async simple => {
    if (!await confirmDialog(simple ? L("Reset the settings (keep cameras and network)?", "Återställa inställningarna (behåll kameror och nätverk)?")
                                    : L("Reset EVERYTHING to factory settings?", "Återställa ALLT till fabriksinställningar?"), L("Reset", "Återställ"))) return;
    const r = await saved(call("restoreFactory", { isSimple: simple }));
    if (succeeded(r)) call("reboot");
  };
  box.append(actions([L("Reset settings", "Återställ inställningar"), () => reset(true), "danger"],
                     [L("Full factory reset", "Fullständig återställning"), () => reset(false), "danger"]));
  return box;
}
