// Language: Swedish if the browser prefers it, otherwise English.
// L("English", "Svenska") picks the right one; data-t attributes use TEXT.
const LANG = (navigator.language || "en").toLowerCase().startsWith("sv") ? "sv" : "en";
const L = (en, sv) => (LANG === "sv" ? sv : en);

const TEXT = {
  title: "netsdk-viewer",
  nvrAddress: L("NVR address", "NVR-adress"),
  user: L("User", "Användare"),
  password: L("Password", "Lösenord"),
  remember: L("Remember my password", "Spara mitt lösenord"),
  login: L("Log in", "Logga in"),
  logout: L("Log out", "Logga ut"),
  live: L("Live", "Live"),
  playback: L("Playback", "Uppspelning"),
  settings: L("Settings", "Inställningar"),
  manage: L("Management", "Hantering"),
  subStreamLive: L("Sub stream (lighter)", "Underström (lättare)"),
  snapshot: L("Save snapshot", "Spara stillbild"),
  clickTimeline: L("Click a timeline to play from that point.", "Klicka på en tidslinje för att spela upp därifrån."),
  download: L("Download clip", "Ladda ner klippet"),
  show: L("Show", "Visa"),
  timing: L("Schedule", "Schema"),
  motion: L("Motion", "Rörelse"),
  alarm: L("Alarm", "Larm"),
  manual: L("Manual", "Manuell"),
  other: L("Other", "Övrigt"),
};
document.documentElement.lang = LANG;
document.title = TEXT.title;
