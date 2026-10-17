// beecord background watcher & auto-updater.
// 1. Checks GitHub (https://github.com/blxstn/beecord) for updates every 20 seconds.
//    If a new commit is detected, pulls it, updates plugins/core in %APPDATA%\beecord,
//    and automatically restarts Discord so changes take effect immediately.
// 2. Checks Discord installations every 10 seconds.
//    If Discord updates to a new app-x.y.z version, re-applies the patch and restarts Discord.
// 3. Runs completely silently in the background via Windows Startup.

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync, spawn } = require("child_process");

const REPO_URL = "https://github.com/blxstn/beecord.git";
const MARKER = "/*BEECORD*/";
const discordDir = path.join(process.env.LOCALAPPDATA || "", "Discord");
const beecordDir = path.join(process.env.APPDATA || "", "beecord");
const dataDir = path.join(beecordDir, "data");
const logsDir = path.join(beecordDir, "logs");
const pluginsDir = path.join(beecordDir, "plugins");
const loaderPath = path.join(dataDir, "loader.js");
const pidFile = path.join(logsDir, "watcher.pid");
const logFile = path.join(logsDir, "updater.log");
const versionFile = path.join(logsDir, "version.json");
try { fs.mkdirSync(logsDir, { recursive: true }); } catch { }

const DISCORD_CHECK_INTERVAL = 10000;
const GITHUB_CHECK_INTERVAL = 20000;

function log(m) {
    try {
        let old = "";
        try { old = fs.readFileSync(logFile, "utf8"); } catch { }
        const lines = old.split("\n").filter(Boolean).slice(-200);
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

function findDiscordExe() {
    try {
        const apps = fs.readdirSync(discordDir).filter(d => /^app-/.test(d)).sort(cmpVersion).reverse();
        for (const app of apps) {
            const p = path.join(discordDir, app, "Discord.exe");
            if (fs.existsSync(p)) return p;
        }
    } catch { }
    return null;
}

function isDiscordRunning() {
    try {
        return /Discord\.exe/i.test(execFileSync("tasklist", ["/fi", "imagename eq Discord.exe", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

function restartDiscord() {
    log("Wymuszenie restartu Discorda w celu wdrozenia aktualizacji...");
    try {
        execFileSync("taskkill", ["/f", "/im", "Discord.exe"], { windowsHide: true, stdio: "ignore" });
    } catch { }

    setTimeout(() => {
        const updateExe = path.join(discordDir, "Update.exe");
        let started = false;
        if (fs.existsSync(updateExe)) {
            try {
                spawn(updateExe, ["--processStart", "Discord.exe"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
                started = true;
            } catch (e) {
                log("Update.exe error: " + e.message);
            }
        }
        if (!started) {
            const exe = findDiscordExe();
            if (exe) {
                try {
                    spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
                    started = true;
                } catch (e) {
                    log("Direct Discord.exe error: " + e.message);
                }
            }
        }
        log("Discord zrestartowany pomyslnie.");
    }, 2000);
}

// Sprawdza czy Discord jest spatchowany. Zwraca true jesli dokonal zmian.
function checkDiscordPatch() {
    if (!fs.existsSync(loaderPath)) return false;
    const files = findCoreFiles();
    if (!files.length) return false;
    const file = files[0];
    let original;
    try { original = fs.readFileSync(file, "utf8"); } catch { return false; }
    const normOrig = original.replace(/\\\\/g, "/").replace(/\\/g, "/");
    const normLoader = loaderPath.replace(/\\/g, "/");
    const normRootLoader = path.join(beecordDir, "loader.js").replace(/\\/g, "/");
    if (original.startsWith(MARKER) && (normOrig.includes(normLoader) || normOrig.includes(normRootLoader))) return false;

    let clean = original;
    if (original.startsWith(MARKER) || original.startsWith(LEGACY_MARKER)) {
        for (const suffix of [".beecord.bak", ".blxstncord.bak"]) {
            const bak = file + suffix;
            if (fs.existsSync(bak)) { clean = fs.readFileSync(bak, "utf8"); break; }
        }
        if (clean.startsWith(MARKER) || clean.startsWith(LEGACY_MARKER)) {
            clean = "module.exports = require('./core.asar');\n";
        }
    } else {
        fs.writeFileSync(file + ".beecord.bak", clean);
    }
    fs.writeFileSync(file, `${MARKER}\nrequire(${JSON.stringify(loaderPath)});\n${clean}`);
    log("Spatchowano nowy folder Discorda: " + file);
    return true;
}

let isSyncing = false;
function syncWithGitHub() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        // 1. Pobierz najnowszy commit z GitHuba
        let remoteCommit = "";
        try {
            const out = execSync(`git ls-remote ${REPO_URL} HEAD`, { encoding: "utf8", windowsHide: true }).trim();
            remoteCommit = out.split(/\s+/)[0];
        } catch (e) {
            isSyncing = false;
            return;
        }

        if (!remoteCommit || remoteCommit.length < 10) {
            isSyncing = false;
            return;
        }

        // 2. Sprawdz aktualny lokalny commit w %APPDATA%\beecord
        let localCommit = "";
        try {
            localCommit = execSync("git rev-parse HEAD", { cwd: beecordDir, encoding: "utf8", windowsHide: true }).trim();
        } catch { }

        if (remoteCommit === localCommit) {
            isSyncing = false;
            return;
        }

        log(`[Auto-Update] Wykryto nowa wersje na GitHubie (${remoteCommit.substring(0, 7)}). Pobieranie git pull...`);

        // 3. Pobierz zmiany bezposrednio w %APPDATA%\beecord
        execSync("git fetch origin main", { cwd: beecordDir, windowsHide: true, stdio: "ignore" });
        execSync("git reset --hard origin/main", { cwd: beecordDir, windowsHide: true, stdio: "ignore" });

        log(`[Auto-Update] Beecord zaktualizowany do ${remoteCommit.substring(0, 7)}!`);

        // 7. Sprawdz patch Discorda
        checkDiscordPatch();

        // 8. Zrestartuj Discorda, jesli dziala, zeby od razu przyjal update!
        if (isDiscordRunning()) {
            log("[Auto-Update] Discord jest uruchomiony - restartowanie, aby wdrozyc aktualizacje...");
            restartDiscord();
        }
    } catch (e) {
        log("[Auto-Update] Blad podczas aktualizacji: " + e.message);
    } finally {
        isSyncing = false;
    }
}

function tickDiscord() {
    try {
        if (checkDiscordPatch()) {
            if (isDiscordRunning()) restartDiscord();
        }
    } catch (e) { log("tickDiscord error: " + e.message); }
}

function isNodeProcess(pid) {
    try {
        return new RegExp("node(\\.exe)?", "i").test(execFileSync("tasklist", ["/fi", "PID eq " + pid, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

if (process.argv[2] === "--once") {
    tickDiscord();
    syncWithGitHub();
} else {
    try {
        const old = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        if (old && old !== process.pid && isNodeProcess(old)) process.exit(0);
    } catch { }
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.writeFileSync(pidFile, String(process.pid)); } catch { }
    log("watcher & auto-updater started");

    tickDiscord();
    syncWithGitHub();

    setInterval(tickDiscord, DISCORD_CHECK_INTERVAL);
    setInterval(syncWithGitHub, GITHUB_CHECK_INTERVAL);
}
