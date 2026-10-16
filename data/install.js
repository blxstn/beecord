// beecord installer (Windows). Usage:
//   node install.js            -> install
//   node install.js uninstall  -> remove (also stops the auto-updater)
//   node install.js log        -> show log.txt

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const MARKER = "/*BEECORD*/";
const LEGACY_MARKERS = ["/*BLXSTNCORD*/", "/*FAKECORD*/"];
const discordDir = path.join(process.env.LOCALAPPDATA || "", "Discord");
const dataDir = path.join(process.env.APPDATA || "", "beecord");
const legacyDataDir = path.join(process.env.APPDATA || "", "blxstncord");
const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const startupFile = path.join(startupDir, "beecord-updater.vbs");
const legacyStartupFile = path.join(startupDir, "blxstncord-updater.vbs");
const pidFile = path.join(dataDir, "watcher.pid");

function isNodeProcess(pid) {
    try {
        return /node/i.test(execFileSync("tasklist", ["/fi", "PID eq " + pid, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

function stopWatcher() {
    for (const pf of [pidFile, path.join(legacyDataDir, "watcher.pid")]) {
        try {
            const pid = parseInt(fs.readFileSync(pf, "utf8"), 10);
            if (pid && isNodeProcess(pid)) process.kill(pid);
        } catch { }
        try { fs.rmSync(pf, { force: true }); } catch { }
    }
}

function installWatcher() {
    stopWatcher();
    const watcher = path.join(dataDir, "watcher.js");
    const cmd = `"${process.execPath}" "${watcher}"`;
    fs.mkdirSync(startupDir, { recursive: true });
    try { fs.rmSync(legacyStartupFile, { force: true }); } catch { }
    fs.writeFileSync(startupFile, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
    spawn(process.execPath, [watcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log("Auto-updater aktywny: beecord aktualizuje sie automatycznie po update Discorda.");
}

function removeWatcher() {
    stopWatcher();
    try { fs.rmSync(startupFile, { force: true }); } catch { }
    try { fs.rmSync(legacyStartupFile, { force: true }); } catch { }
    try { fs.rmSync(path.join(dataDir, "watcher.js"), { force: true }); } catch { }
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
    if (!fs.existsSync(discordDir)) throw new Error(`Nie znaleziono folderu Discorda w ${discordDir}`);
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

function cleanLegacy() {
    try {
        for (const file of findCoreFiles()) {
            for (const suffix of [".fakecord.bak", ".blxstncord.bak"]) {
                const bak = file + suffix;
                if (!fs.existsSync(bak)) continue;
                fs.copyFileSync(bak, file);
                try { fs.unlinkSync(bak); } catch { }
                console.log("Przywrocono oryginalny plik z kopii zapasowej: " + bak);
            }
        }
    } catch { }
}

function cleanVencord() {
    try {
        const apps = fs.readdirSync(discordDir).filter(d => /^app-\d/.test(d));
        for (const a of apps) {
            const res = path.join(discordDir, a, "resources");
            const asarBak = path.join(res, "_app.asar");
            const appDir = path.join(res, "app");
            const idx = path.join(appDir, "index.js");
            if (!fs.existsSync(asarBak) || !fs.existsSync(idx)) continue;
            try {
                if (!/vencord|patcher\.js/i.test(fs.readFileSync(idx, "utf8"))) continue;
                fs.rmSync(appDir, { recursive: true, force: true });
                if (!fs.existsSync(path.join(res, "app.asar"))) fs.renameSync(asarBak, path.join(res, "app.asar"));
                console.log(`Usunieto stara modyfikacje Vencord z ${a}`);
            } catch (e) { }
        }
    } catch { }
}

function isDiscordRunning() {
    try {
        return /Discord\.exe/i.test(execFileSync("tasklist", ["/fi", "imagename eq Discord.exe", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };

// Discord.exe of the newest app-* folder (used when Update.exe cannot start it)
function discordExePaths() {
    try {
        return fs.readdirSync(discordDir).filter(d => /^app-/.test(d)).sort().reverse()
            .map(d => path.join(discordDir, d, "Discord.exe")).filter(p => fs.existsSync(p));
    } catch { return []; }
}

// Starts Discord and CHECKS that it is really running. Tries three ways, one after another.
function launchDiscord() {
    const update = path.join(discordDir, "Update.exe");
    const ways = [
        () => spawn(update, ["--processStart", "Discord.exe"], { detached: true, stdio: "ignore", windowsHide: true }),
        () => spawn("cmd.exe", ["/c", "start", "", update, "--processStart", "Discord.exe"], { detached: true, stdio: "ignore", windowsHide: true }),
        () => { const exe = discordExePaths()[0]; if (!exe) throw new Error("nie znaleziono Discord.exe"); return spawn(exe, [], { detached: true, stdio: "ignore" }); }
    ];
    for (let i = 0; i < ways.length; i++) {
        try {
            const child = ways[i]();
            child.on("error", e => console.log("Start Discorda (metoda " + (i + 1) + ") zglosil blad: " + e.message));
            child.unref();
        } catch (e) {
            console.log("Start Discorda (metoda " + (i + 1) + ") nie powiodl sie: " + e.message);
            continue;
        }
        for (let w = 0; w < 12; w++) {
            sleepSync(1000);
            if (isDiscordRunning()) { console.log("Discord zostal uruchomiony ponownie."); return true; }
        }
        console.log("Discord sie nie uruchomil (metoda " + (i + 1) + "), probuje inaczej...");
    }
    return false;
}

function restartDiscord() {
    console.log("Restartowanie Discorda...");
    try {
        execFileSync("taskkill", ["/f", "/t", "/im", "Discord.exe"], { windowsHide: true, stdio: "ignore" });
    } catch { }
    for (let w = 0; w < 20 && isDiscordRunning(); w++) sleepSync(500);   // wait until it is really gone
    sleepSync(1500);
    if (!launchDiscord()) {
        console.log("Nie udalo sie uruchomic Discorda automatycznie. Uruchom go recznie (skrot Discord na pulpicie lub w menu Start).");
    }
}

function uninstall() {
    removeWatcher();
    cleanLegacy();
    cleanVencord();
    let n = 0;
    for (const file of findCoreFiles()) {
        const bak = file + ".beecord.bak";
        if (fs.existsSync(bak)) {
            fs.copyFileSync(bak, file);
            fs.unlinkSync(bak);
            n++;
        }
    }
    for (const f of ["loader.js", "renderer.js", "media.ps1"]) {
        try { fs.rmSync(path.join(dataDir, f), { force: true }); } catch { }
    }
    console.log(n ? `Przywrocono ${n} plik(ow). Beecord zostal odinstalowany.` : "Brak aktywnych modyfikacji do usuniecia.");
    if (isDiscordRunning()) restartDiscord();
}

function install() {
    if (fs.existsSync(discordDir)) cleanVencord();
    cleanLegacy();
    const files = findCoreFiles();
    if (!files.length) throw new Error("Nie znaleziono modulu discord_desktop_core. Uruchom Discorda raz, zamknij i sprobuj ponownie.");

    // Kopiuj pliki launch/systemu do %APPDATA%\beecord oraz %APPDATA%\blxstncord
    for (const targetDir of [dataDir, legacyDataDir]) {
        fs.mkdirSync(targetDir, { recursive: true });
        for (const f of ["loader.js", "renderer.js", "media.ps1", "watcher.js"]) {
            const src = path.join(__dirname, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, f));
        }
    }

    const loaderPath = path.join(dataDir, "loader.js");

    // Kopiuj pluginy z folderu ../plugins
    const srcPlugins = path.join(__dirname, "..", "plugins");
    if (!fs.existsSync(srcPlugins)) throw new Error("Nie znaleziono folderu 'plugins' obok folderu data!");

    for (const targetDir of [dataDir, legacyDataDir]) {
        const dstPlugins = path.join(targetDir, "plugins");
        fs.mkdirSync(dstPlugins, { recursive: true });
        for (const f of fs.readdirSync(srcPlugins).filter(f => f.endsWith(".js") && !f.startsWith("_"))) {
            fs.copyFileSync(path.join(srcPlugins, f), path.join(dstPlugins, f));
        }
        const template = path.join(srcPlugins, "_template.js");
        if (fs.existsSync(template)) fs.copyFileSync(template, path.join(dstPlugins, "_template.js"));
    }

    const copiedPlugins = fs.readdirSync(srcPlugins).filter(f => f.endsWith(".js") && !f.startsWith("_"));
    console.log("Skopiowano pluginy (" + copiedPlugins.length + "): " + copiedPlugins.join(", "));

    // Spatchuj najnowsza wersje Discorda
    const file = files[0];
    const bak = file + ".beecord.bak";
    let original = fs.readFileSync(file, "utf8");

    if (original.startsWith(MARKER)) {
        if (fs.existsSync(bak)) original = fs.readFileSync(bak, "utf8");
    } else {
        // Jesli jest stary marker blxstncord lub fakecord
        for (const m of LEGACY_MARKERS) {
            if (original.startsWith(m)) {
                const oldBak = file + ".blxstncord.bak";
                if (fs.existsSync(oldBak)) original = fs.readFileSync(oldBak, "utf8");
            }
        }
        fs.writeFileSync(bak, original);
    }

    fs.writeFileSync(file, `${MARKER}\nrequire(${JSON.stringify(loaderPath)});\n${original}`);
    console.log(`Zainstalowano pomyslnie do:\n  ${file}\nPliki moda: ${dataDir}\nPluginy: ${path.join(dataDir, "plugins")}`);
    
    installWatcher();
    if (isDiscordRunning()) {
        restartDiscord();
    } else {
        console.log("Uruchom Discorda. Od teraz modyfikacja laduje sie automatycznie.");
    }
}

function showLog() {
    const lf = fs.existsSync(path.join(dataDir, "log.txt")) ? path.join(dataDir, "log.txt") : path.join(legacyDataDir, "log.txt");
    if (!fs.existsSync(lf)) { console.log("Brak pliku log.txt."); return; }
    console.log(fs.readFileSync(lf, "utf8"));
}

try {
    const cmd = process.argv[2];
    if (cmd === "uninstall") uninstall();
    else if (cmd === "log") showLog();
    else install();
} catch (e) {
    console.error("Blad:", e.message);
    process.exit(1);
}
