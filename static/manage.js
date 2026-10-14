// Management tab: the NVR's channel list (which camera is on which channel),
// searching the network for cameras, adding, editing and removing them.

let manageSelected = -1, manageList = [], manageFound = [], manageProtocol = "N1";

async function openManage() {
  const page = $("managepage");
  page.innerHTML = `<h2>${TEXT.manage}</h2><p class="muted">${L("Loading …", "Hämtar …")}</p>`;
  try {
    const [list, stat] = await Promise.all([call("getChannelIPCamInfo"), call("getStatIPC")]);
    manageList = list;
    const status = {};
    (Array.isArray(stat) ? stat : []).forEach(s => (status[s.ID] = s));
    page.innerHTML = `<h2>${TEXT.manage}</h2>`;
    page.append(channelTable(status), channelActions(), searchSection());
  } catch (e) {
    page.innerHTML = `<h2>${TEXT.manage}</h2><p class="error">${esc(e.message)}</p>`;
  }
}

function channelTable(status) {
  const wrap = el(`<div class="table"></div>`);
  const rows = manageList.map((c, i) => {
    const on = c.Enable === "True";
    const s = status[i] || {};
    return `<tr class="selectable ${i === manageSelected ? "selected" : ""}" data-i="${i}">
      <td>${i + 1}</td><td>${on ? esc(camName(i + 1)) : ""}</td><td>${on ? esc(c.IPAddr) : ""}</td><td>${on ? esc(c.Modelname) : ""}</td>
      <td>${on ? esc(c.InterfaceType) : ""}</td><td>${on ? esc(s.Status || "") : L("empty", "tom")}</td>
      <td>${on && c.InterfaceType === "Wireless" && s.WifiSignal ? esc(s.WifiSignal) + " %" : ""}</td><td>${on ? esc(c.SWVersion) : ""}</td></tr>`;
  }).join("");
  wrap.innerHTML = `<table><tr><th>${L("Channel", "Kanal")}</th><th>${L("Name", "Namn")}</th><th>${L("IP address", "IP-adress")}</th>
    <th>${L("Model", "Modell")}</th><th>${L("Connection", "Anslutning")}</th><th>${L("Status", "Status")}</th>
    <th>${L("Wi-Fi signal", "Wi-Fi-signal")}</th><th>${L("Software", "Programvara")}</th></tr>${rows}</table>`;
  wrap.querySelectorAll("tr.selectable").forEach(tr => tr.onclick = () => {
    manageSelected = +tr.dataset.i;
    wrap.querySelectorAll("tr").forEach(r => r.classList.toggle("selected", r === tr));
  });
  return wrap;
}

function needSelection() {
  if (manageSelected < 0) { toast(L("Select a channel first", "Välj en kanal först"), true); return null; }
  return manageList[manageSelected];
}

function channelActions() {
  return actions(
    [L("Edit", "Redigera"), () => { const c = needSelection(); if (c) editChannel(manageSelected); }, "secondary"],
    [L("Restart camera", "Starta om kameran"), async () => {
      const c = needSelection(); if (!c) return;
      if (await confirmDialog(L(`Restart the camera on channel ${manageSelected + 1}?`, `Starta om kameran på kanal ${manageSelected + 1}?`), L("Restart", "Starta om")))
        await saved(call("ipcReboot", { Channel: manageSelected }));
    }, "secondary"],
    [L("Flip image", "Vänd bilden"), async () => {
      const c = needSelection(); if (c) await saved(call("imageFlip", { Channel: manageSelected }));
    }, "secondary"],
    [L("Remove from channel", "Ta bort från kanalen"), async () => {
      const c = needSelection(); if (!c) return;
      if (!await confirmDialog(L(`Remove the camera from channel ${manageSelected + 1}? Its recordings stay on the disk.`,
        `Ta bort kameran från kanal ${manageSelected + 1}? Dess inspelningar ligger kvar på disken.`), L("Remove", "Ta bort"))) return;
      const r = await saved(call("setOneIPC", { Channel: String(manageSelected), Enable: "False" }));
      if (succeeded(r)) openManage();
    }, "danger"]);
}

function editChannel(i) {
  const c = JSON.parse(JSON.stringify(manageList[i]));
  const page = $("managepage");
  page.innerHTML = `<h2>${L("Channel", "Kanal")} ${i + 1}</h2>`;
  page.append(form(c, [
    { label: L("IP address", "IP-adress"), path: "IPAddr" },
    { label: L("Port", "Port"), path: "Port", type: "number" },
    { label: L("Protocol", "Protokoll"), path: "Protocolname", type: "select", options: ["N1", "ONVIF"] },
    { label: L("Camera user name", "Kamerans användarnamn"), path: "Username" },
    { label: L("Camera password", "Kamerans lösenord"), path: "Password", type: "password" },
    { label: L("Preview strategy", "Förhandsvisning"), path: "BufferStratage", type: "select",
      options: [["Realtime", L("Real time", "Realtid")], ["Balance", L("Balanced", "Balanserad")], ["Fluency", L("Smooth", "Jämn")], ["Adaptive", L("Adaptive", "Anpassad")]] },
    { label: L("Enabled", "Aktiverad"), path: "Enable", type: "bool" },
  ]));
  page.append(actions([L("Save", "Spara"), async () => {
    const list = JSON.parse(JSON.stringify(manageList));
    list[i] = { ...c, Modelname: manageList[i].Modelname };
    const r = await saved(call("setChannelIPCamInfo", list));
    if (succeeded(r)) openManage();
  }], [L("Back", "Tillbaka"), openManage, "secondary"]));
}

function searchSection() {
  const box = el(`<div><h3>${L("Cameras found on the network", "Kameror som hittas på nätverket")}</h3></div>`);
  const out = el(`<div class="table"></div>`);
  const proto = el(`<div class="row"><label>${L("Protocol", "Protokoll")}</label><select><option>N1</option><option>ONVIF</option></select></div>`);
  proto.querySelector("select").value = manageProtocol;
  proto.querySelector("select").onchange = e => (manageProtocol = e.target.value);
  let picked = -1;
  const draw = () => {
    if (!manageFound.length) { out.innerHTML = `<p class="muted">${L("Nothing found yet.", "Inget hittat ännu.")}</p>`; return; }
    const known = new Set(manageList.filter(c => c.Enable === "True").map(c => c.IPAddr));
    out.innerHTML = `<table><tr><th>${L("IP address", "IP-adress")}</th><th>${L("Model", "Modell")}</th><th>${L("Protocol", "Protokoll")}</th>
      <th>${L("Connection", "Anslutning")}</th><th>${L("Port", "Port")}</th><th></th></tr>
      ${manageFound.map((d, i) => `<tr class="selectable ${i === picked ? "selected" : ""}" data-i="${i}"><td>${esc(d.IPAddr)}</td><td>${esc(d.Modelname)}</td>
        <td>${esc(d.Protocolname)}</td><td>${esc(d.InterfaceType)}</td><td>${esc(d.Port)}</td>
        <td>${known.has(d.IPAddr) ? L("already added", "redan tillagd") : ""}</td></tr>`).join("")}</table>`;
    out.querySelectorAll("tr.selectable").forEach(tr => tr.onclick = () => { picked = +tr.dataset.i; draw(); });
  };
  box.append(proto, actions(
    [L("Search", "Sök"), async () => {
      out.innerHTML = `<p class="muted">${L("Searching …", "Söker …")}</p>`;
      const r = await call("ipcSearch", { ProtocolName: manageProtocol });
      manageFound = r.Item || [];
      picked = -1;
      draw();
    }, "secondary"],
    [L("Add selected camera", "Lägg till vald kamera"), async () => {
      const d = manageFound[picked];
      if (!d) return toast(L("Select a camera in the list", "Välj en kamera i listan"), true);
      if (manageList.some(c => c.Enable === "True" && c.IPAddr === d.IPAddr)) return toast(L("That camera is already added", "Kameran är redan tillagd"), true);
      let free = manageSelected >= 0 && manageList[manageSelected]?.Enable !== "True" ? manageSelected
        : manageList.findIndex(c => c.Enable !== "True");
      if (free < 0) free = manageList.length;
      if (free >= maxChannels) return toast(L("All channels are in use", "Alla kanaler är upptagna"), true);
      const r = await saved(call("setOneIPC", { Channel: String(free), IPAddr: d.IPAddr, ProtocolName: d.Protocolname,
        InterfaceType: d.InterfaceType, Port: d.Port, Enable: "True" }));
      if (succeeded(r)) openManage();
    }]), out);
  draw();
  return box;
}
