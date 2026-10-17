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

// Target directories (%APPDATA%\beecord and organized subdirectories)
const targetRootDir = path.join(process.env.APPDATA || "", "beecord");
const targetDataDir = path.join(targetRootDir, "data");
const targetPluginsDir = path.join(targetRootDir, "plugins");
const targetAssetsDir = path.join(targetRootDir, "assets");
const targetLogsDir = path.join(targetRootDir, "logs");
const legacyDataDir = path.join(process.env.APPDATA || "", "blxstncord");

// Source directories (where installer is being run from)
const sourceRootDir = fs.existsSync(path.join(__dirname, "install.js")) && path.basename(__dirname).toLowerCase() === "data"
    ? path.resolve(__dirname, "..")
    : __dirname;
const sourceDataDir = path.join(sourceRootDir, "data");
const sourcePluginsDir = path.join(sourceRootDir, "plugins");
const sourceAssetsDir = path.join(sourceRootDir, "assets");

// Startup files
const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const startupFile = path.join(startupDir, "beecord-updater.vbs");
const legacyStartupFile = path.join(startupDir, "blxstncord-updater.vbs");
const pidFile = path.join(targetLogsDir, "watcher.pid");

function isNodeProcess(pid) {
    try {
        return /node/i.test(execFileSync("tasklist", ["/fi", "PID eq " + pid, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

function stopWatcher() {
    const pidsToCheck = [
        pidFile,
        path.join(targetRootDir, "watcher.pid"),
        path.join(legacyDataDir, "watcher.pid")
    ];
    for (const pf of pidsToCheck) {
        try {
            const pid = parseInt(fs.readFileSync(pf, "utf8"), 10);
            if (pid && isNodeProcess(pid)) process.kill(pid);
        } catch { }
        try { fs.rmSync(pf, { force: true }); } catch { }
    }
}

function installWatcher() {
    stopWatcher();
    const watcher = path.join(targetDataDir, "watcher.js");
    if (!fs.existsSync(watcher)) {
        console.log("  [WARN] watcher.js nie istnieje w " + targetDataDir);
        return;
    }
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
}

function safeCopyFile(src, dst) {
    try {
        if (path.resolve(src) === path.resolve(dst)) return false;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        return true;
    } catch (e) {
        console.error(`  [WARN] Nie udalo sie skopiowac ${path.basename(src)}: ${e.message}`);
        return false;
    }
}

function copyDirRecursive(srcDir, dstDir) {
    if (!fs.existsSync(srcDir)) return [];
    fs.mkdirSync(dstDir, { recursive: true });
    const copied = [];
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const dstPath = path.join(dstDir, entry.name);
        if (path.resolve(srcPath) === path.resolve(dstPath)) continue;
        if (entry.isDirectory()) {
            copied.push(...copyDirRecursive(srcPath, dstPath));
        } else if (entry.isFile()) {
            if (safeCopyFile(srcPath, dstPath)) copied.push(dstPath);
        }
    }
    return copied;
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

function discordExePaths() {
    try {
        return fs.readdirSync(discordDir).filter(d => /^app-/.test(d)).sort().reverse()
            .map(d => path.join(discordDir, d, "Discord.exe")).filter(p => fs.existsSync(p));
    } catch { return []; }
}

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
    for (let w = 0; w < 20 && isDiscordRunning(); w++) sleepSync(500);
    sleepSync(1500);
    if (!launchDiscord()) {
        console.log("Nie udalo sie uruchomic Discorda automatycznie. Uruchom go recznie (skrot Discord na pulpicie lub w menu Start).");
    }
}

function uninstall() {
    console.log("======================================================");
    console.log("             ODINSTALOWYWANIE BEECORD");
    console.log("======================================================");
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
    console.log(n ? `Przywrocono ${n} plik(ow) Discorda. Beecord zostal odinstalowany.` : "Brak aktywnych modyfikacji do usuniecia w Discordzie.");
    if (isDiscordRunning()) restartDiscord();
}

function install() {
    console.log("======================================================");
    console.log("              INSTALACJA BEECORD");
    console.log("======================================================");

    if (fs.existsSync(discordDir)) cleanVencord();
    cleanLegacy();
    const files = findCoreFiles();
    if (!files.length) throw new Error("Nie znaleziono modulu discord_desktop_core. Uruchom Discorda raz, zamknij i sprobuj ponownie.");

    // Tworzenie zorganizowanej struktury 4 podfolderow
    for (const dir of [targetRootDir, targetDataDir, targetPluginsDir, targetAssetsDir, targetLogsDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 1. Kopiuj wszystkie pliki systemowe z folderu data
    console.log("[1/5] Instalowanie plikow systemowych (data/)...");
    if (fs.existsSync(sourceDataDir)) {
        copyDirRecursive(sourceDataDir, targetDataDir);
    }
    const dataFiles = fs.existsSync(targetDataDir) ? fs.readdirSync(targetDataDir) : [];
    console.log(`      Zainstalowano ${dataFiles.length} plik(ow) systemowych.`);

    // 2. Kopiuj wszystkie assety (ikony, zdjecia, grafiki)
    console.log("[2/5] Instalowanie zasobow i ikon (assets/)...");
    if (fs.existsSync(sourceAssetsDir)) {
        copyDirRecursive(sourceAssetsDir, targetAssetsDir);
    }
    const assetFiles = fs.existsSync(targetAssetsDir) ? fs.readdirSync(targetAssetsDir) : [];
    console.log(`      Zainstalowano ${assetFiles.length} plik(ow) zasobow.`);

    // 3. Kopiuj dynamicznie WSZYSTKIE wtyczki (aktualne i nowo dodane)
    console.log("[3/5] Instalowanie wtyczek (plugins/)...");
    if (fs.existsSync(sourcePluginsDir)) {
        copyDirRecursive(sourcePluginsDir, targetPluginsDir);
    }
    const installedPlugins = fs.existsSync(targetPluginsDir)
        ? fs.readdirSync(targetPluginsDir).filter(f => /\.js$/i.test(f) && !f.startsWith("_") && !f.startsWith("."))
        : [];
    console.log(`      Wykryto i zainstalowano wtyczki (${installedPlugins.length}):`);
    installedPlugins.forEach(p => console.log(`       -> ${p}`));

    // 4. Kopiowanie wszelkich innych podfolderow uzytkownika i plikow glownych
    if (path.resolve(sourceRootDir) !== path.resolve(targetRootDir)) {
        console.log("[4/5] Kopiowanie plikow glownych...");
        const ignored = new Set([".git", "logs", "inbox", "node_modules", "data", "plugins", "assets"]);
        for (const entry of fs.readdirSync(sourceRootDir, { withFileTypes: true })) {
            if (ignored.has(entry.name)) continue;
            const src = path.join(sourceRootDir, entry.name);
            const dst = path.join(targetRootDir, entry.name);
            if (entry.isDirectory()) {
                copyDirRecursive(src, dst);
            } else if (entry.isFile()) {
                safeCopyFile(src, dst);
            }
        }
    } else {
        console.log("[4/5] Synchronizacja plikow glownych...");
    }

    // Upewnij sie, ze w katalogu glownym istnieja pliki proxy wskazujace na data/
    fs.writeFileSync(path.join(targetRootDir, "loader.js"), "module.exports = require('./data/loader.js');\r\n");
    fs.writeFileSync(path.join(targetRootDir, "watcher.js"), "require(\"./data/watcher.js\");\r\n");

    // 5. Spatchuj najnowsza wersje Discorda wskazujac na targetDataDir/loader.js
    console.log("[5/5] Patchowanie Discorda...");
    const loaderPath = path.join(targetDataDir, "loader.js");
    const file = files[0];
    const bak = file + ".beecord.bak";
    let original = fs.readFileSync(file, "utf8");

    if (original.startsWith(MARKER)) {
        if (fs.existsSync(bak)) original = fs.readFileSync(bak, "utf8");
    } else {
        for (const m of LEGACY_MARKERS) {
            if (original.startsWith(m)) {
                const oldBak = file + ".blxstncord.bak";
                if (fs.existsSync(oldBak)) original = fs.readFileSync(oldBak, "utf8");
            }
        }
        fs.writeFileSync(bak, original);
    }

    fs.writeFileSync(file, `${MARKER}\nrequire(${JSON.stringify(loaderPath)});\n${original}`);
    console.log(`\nSukces! Beecord zostal zainstalowany do:`);
    console.log(`  Discord: ${file}`);
    console.log(`  Katalog moda: ${targetRootDir}`);
    console.log(`  Pliki systemowe: ${targetDataDir}`);
    console.log(`  Wtyczki: ${targetPluginsDir}`);
    console.log(`  Zasoby: ${targetAssetsDir}`);
    console.log(`  Logi: ${targetLogsDir}`);

    installWatcher();
    if (isDiscordRunning()) {
        restartDiscord();
    } else {
        console.log("\nUruchom Discorda. Od teraz modyfikacja laduje sie automatycznie.");
    }
}

function showLog() {
    const candidatePaths = [
        path.join(targetLogsDir, "log.txt"),
        path.join(targetLogsDir, "updater.log"),
        path.join(targetRootDir, "log.txt"),
        path.join(targetDataDir, "log.txt"),
        path.join(legacyDataDir, "log.txt")
    ];
    let lf = candidatePaths.find(p => fs.existsSync(p));
    if (!lf) { console.log("Brak pliku log.txt."); return; }
    console.log(`\n=== ZAWARTOSC LOGU (${lf}) ===\n`);
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
