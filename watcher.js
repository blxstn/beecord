// blxstncord auto-updater: tiny background script (started at Windows login).
// Every few seconds it checks whether the newest Discord version is still patched.
// After a Discord update the new app-x.y.z folder is clean, so it re-applies the patch.
// The patch takes effect the next time Discord starts. Optional: automatic restart (see updater.json).
//
//   node watcher.js          -> run forever (what the startup entry does)
//   node watcher.js --once   -> check once and exit

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const MARKER = "/*BLXSTNCORD*/";
const discordDir = path.join(process.env.LOCALAPPDATA || "", "Discord");
const dataDir = path.join(process.env.APPDATA || "", "blxstncord");
const loaderPath = path.join(dataDir, "loader.js");
const pidFile = path.join(dataDir, "watcher.pid");
const logFile = path.join(dataDir, "updater.log");
const cfgFile = path.join(dataDir, "updater.json");   // { "restartDiscord": true } restarts Discord right after patching
const INTERVAL = 10000;

function log(m) {
    try {
        let old = "";
        try { old = fs.readFileSync(logFile, "utf8"); } catch { }
        const lines = old.split("\n").filter(Boolean).slice(-100);
        lines.push(new Date().toLocaleString() + "  " + m);
        fs.writeFileSync(logFile, lines.join("\n") + "\n");
    } catch { }
}

function cmpVersion(a, b) {
    const pa = a.replace("app-", "").split(".").map(Number);
    const pb = b.replace("app-", "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function findCoreFiles() {
    if (!fs.existsSync(discordDir)) return [];
    const apps = fs.readdirSync(discordDir).filter(d => /^app-\d/.test(d)).sort((a, b) => cmpVersion(b, a));
    const found = [];
    for (const app of apps) {
        const modDir = path.join(discordDir, app, "modules");
        if (!fs.existsSync(modDir)) continue;
        for (const m of fs.readdirSync(modDir).filter(d => d.startsWith("discord_desktop_core"))) {
            const file = path.join(modDir, m, "discord_desktop_core", "index.js");
            if (fs.existsSync(file)) found.push(file);
        }
    }
    return found;
}

function isDiscordRunning() {
    try {
        return /Discord\.exe/i.test(execFileSync("tasklist", ["/fi", "imagename eq Discord.exe", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

function restartDiscord() {
    try {
        execFileSync("taskkill", ["/f", "/im", "Discord.exe"], { windowsHide: true, stdio: "ignore" });
    } catch { }
    setTimeout(() => {
        try {
            spawn(path.join(discordDir, "Update.exe"), ["--processStart", "Discord.exe"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
            log("Discord restarted");
        } catch (e) { log("could not restart Discord: " + e.message); }
    }, 3000);
}

// Patches the newest Discord version if needed. Returns true when it changed something.
function check() {
    if (!fs.existsSync(loaderPath)) return false;          // blxstncord was uninstalled
    const files = findCoreFiles();
    if (!files.length) return false;
    const file = files[0];
    let original;
    try { original = fs.readFileSync(file, "utf8"); } catch { return false; }
    if (!original || original.startsWith(MARKER)) return false;   // empty (still being written) or already patched
    fs.writeFileSync(file + ".blxstncord.bak", original);
    fs.writeFileSync(file, `${MARKER}\nrequire(${JSON.stringify(loaderPath)});\n${original}`);
    log("patched new Discord version: " + file);
    return true;
}

function tick() {
    try {
        if (!check()) return;
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { }
        if (cfg.restartDiscord && isDiscordRunning()) restartDiscord();
    } catch (e) { log("error: " + e.message); }
}

// single instance (the pid is only trusted if that process is really a node.exe)
function isNodeProcess(pid) {
    try {
        return new RegExp("node(\\.exe)?", "i").test(execFileSync("tasklist", ["/fi", "PID eq " + pid, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

if (process.argv[2] === "--once") {
    tick();
} else {
    try {
        const old = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        if (old && old !== process.pid && isNodeProcess(old)) process.exit(0);
    } catch { }
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(pidFile, String(process.pid)); } catch { }
    log("watcher started");
    tick();
    setInterval(tick, INTERVAL);
}
