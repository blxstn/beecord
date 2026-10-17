// Beecord installer (Windows). Usage:
//   node install.js            -> install
//   node install.js uninstall  -> remove (also stops background auto-updater)
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
        console.log("  [WARN] watcher.js does not exist in " + targetDataDir);
        return;
    }
    const cmd = `"${process.execPath}" "${watcher}"`;
    fs.mkdirSync(startupDir, { recursive: true });
    try { fs.rmSync(legacyStartupFile, { force: true }); } catch { }
    fs.writeFileSync(startupFile, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
    spawn(process.execPath, [watcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log("Auto-updater active: Beecord updates automatically when Discord updates.");
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
        console.error(`  [WARN] Could not copy ${path.basename(src)}: ${e.message}`);
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
    if (!fs.existsSync(discordDir)) throw new Error(`Discord directory not found at ${discordDir}`);
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
                console.log("Restored original file from backup: " + bak);
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
                console.log(`Removed legacy Vencord mod from ${a}`);
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
        () => { const exe = discordExePaths()[0]; if (!exe) throw new Error("Discord.exe not found"); return spawn(exe, [], { detached: true, stdio: "ignore" }); }
    ];
    for (let i = 0; i < ways.length; i++) {
        try {
            const child = ways[i]();
            child.on("error", e => console.log("Discord launch (method " + (i + 1) + ") reported error: " + e.message));
            child.unref();
        } catch (e) {
            console.log("Discord launch (method " + (i + 1) + ") failed: " + e.message);
            continue;
        }
        for (let w = 0; w < 12; w++) {
            sleepSync(1000);
            if (isDiscordRunning()) { console.log("Discord restarted successfully."); return true; }
        }
        console.log("Discord has not started yet (method " + (i + 1) + "), trying alternative...");
    }
    return false;
}

function restartDiscord() {
    console.log("Restarting Discord...");
    try {
        execFileSync("taskkill", ["/f", "/t", "/im", "Discord.exe"], { windowsHide: true, stdio: "ignore" });
    } catch { }
    for (let w = 0; w < 20 && isDiscordRunning(); w++) sleepSync(500);
    sleepSync(1500);
    if (!launchDiscord()) {
        console.log("Could not start Discord automatically. Please launch it manually from the desktop or Start Menu shortcut.");
    }
}

function uninstall() {
    console.log("======================================================");
    console.log("               UNINSTALLING BEECORD");
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
    console.log(n ? `Restored ${n} Discord file(s). Beecord has been uninstalled.` : "No active modifications found to remove.");
    if (isDiscordRunning()) restartDiscord();
}

function install() {
    console.log("======================================================");
    console.log("                BEECORD INSTALLATION");
    console.log("======================================================");

    if (fs.existsSync(discordDir)) cleanVencord();
    cleanLegacy();
    const files = findCoreFiles();
    if (!files.length) throw new Error("Could not find discord_desktop_core module. Launch Discord once, close it, and try again.");

    // Create organized folder structure
    for (const dir of [targetRootDir, targetDataDir, targetPluginsDir, targetAssetsDir, targetLogsDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 1. Copy core system files
    console.log("[1/5] Installing core system files (data/)...");
    if (fs.existsSync(sourceDataDir)) {
        copyDirRecursive(sourceDataDir, targetDataDir);
    }
    const dataFiles = fs.existsSync(targetDataDir) ? fs.readdirSync(targetDataDir) : [];
    console.log(`      Installed ${dataFiles.length} system file(s).`);

    // 2. Copy assets (icons, wallpapers, logos)
    console.log("[2/5] Installing assets and icons (assets/)...");
    if (fs.existsSync(sourceAssetsDir)) {
        copyDirRecursive(sourceAssetsDir, targetAssetsDir);
    }
    const assetFiles = fs.existsSync(targetAssetsDir) ? fs.readdirSync(targetAssetsDir) : [];
    console.log(`      Installed ${assetFiles.length} asset(s).`);

    // 3. Dynamically copy all plugins
    console.log("[3/5] Installing plugins (plugins/)...");
    if (fs.existsSync(sourcePluginsDir)) {
        copyDirRecursive(sourcePluginsDir, targetPluginsDir);
    }
    const installedPlugins = fs.existsSync(targetPluginsDir)
        ? fs.readdirSync(targetPluginsDir).filter(f => /\.js$/i.test(f) && !f.startsWith("_") && !f.startsWith("."))
        : [];
    console.log(`      Detected and installed plugins (${installedPlugins.length}):`);
    installedPlugins.forEach(p => console.log(`       -> ${p}`));

    // 4. Copy root files if source != target
    if (path.resolve(sourceRootDir) !== path.resolve(targetRootDir)) {
        console.log("[4/5] Synchronizing root files...");
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
        console.log("[4/5] Synchronizing root files...");
    }

    // 5. Patch Discord core
    console.log("[5/5] Patching Discord core...");
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
    console.log(`\nSuccess! Beecord has been installed to:`);
    console.log(`  Discord: ${file}`);
    console.log(`  Root: ${targetRootDir}`);
    console.log(`  System: ${targetDataDir}`);
    console.log(`  Plugins: ${targetPluginsDir}`);
    console.log(`  Assets: ${targetAssetsDir}`);
    console.log(`  Logs: ${targetLogsDir}`);

    installWatcher();
    if (isDiscordRunning()) {
        restartDiscord();
    } else {
        console.log("\nLaunch Discord. From now on, the enhancement loads automatically.");
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
    if (!lf) { console.log("No log.txt file found."); return; }
    console.log(`\n=== LOG CONTENT (${lf}) ===\n`);
    console.log(fs.readFileSync(lf, "utf8"));
}

try {
    const cmd = process.argv[2];
    if (cmd === "uninstall") uninstall();
    else if (cmd === "log") showLog();
    else install();
} catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
}
