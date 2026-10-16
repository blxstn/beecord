// blxstncord installer (Windows). Usage:
//   node install.js            -> install
//   node install.js uninstall  -> remove (also stops the auto-updater)
// Close Discord completely (also from the tray) before running.

const fs = require("fs");
const path = require("path");

const MARKER = "/*BLXSTNCORD*/";
const LEGACY_MARKER = "/*FAKECORD*/";   // injection from before the rename
const discordDir = path.join(process.env.LOCALAPPDATA || "", "Discord");
const dataDir = path.join(process.env.APPDATA || "", "blxstncord");
const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const startupFile = path.join(startupDir, "blxstncord-updater.vbs");
const pidFile = path.join(dataDir, "watcher.pid");

// ---- auto-updater (watcher.js keeps blxstncord installed after Discord updates) ----
function isNodeProcess(pid) {
    try {
        return /node/i.test(require("child_process").execFileSync("tasklist", ["/fi", "PID eq " + pid, "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }));
    } catch { return false; }
}

function stopWatcher() {
    try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        if (pid && isNodeProcess(pid)) process.kill(pid);
    } catch { }
    try { fs.rmSync(pidFile, { force: true }); } catch { }
}

function installWatcher() {
    stopWatcher();
    const watcher = path.join(dataDir, "watcher.js");
    fs.copyFileSync(path.join(__dirname, "watcher.js"), watcher);
    // hidden launcher in the Windows Startup folder (no admin rights needed)
    const cmd = `"${process.execPath}" "${watcher}"`;
    fs.mkdirSync(startupDir, { recursive: true });
    fs.writeFileSync(startupFile, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
    // start it now, hidden
    require("child_process").spawn(process.execPath, [watcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log("Auto-update enabled: blxstncord re-installs itself after Discord updates (takes effect on the next Discord start).");
}

function removeWatcher() {
    stopWatcher();
    try { fs.rmSync(startupFile, { force: true }); } catch { }
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

// All discord_desktop_core/index.js files, newest app version first
function findCoreFiles() {
    if (!fs.existsSync(discordDir)) throw new Error(`Discord not found at ${discordDir}`);
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

// Remove the old "FakeCord" injection (restore the original file from its backup)
function cleanLegacy() {
    for (const file of findCoreFiles()) {
        const bak = file + ".fakecord.bak";
        if (!fs.existsSync(bak)) continue;
        fs.copyFileSync(bak, file);
        fs.unlinkSync(bak);
        console.log("Removed old FakeCord injection from " + file);
    }
}

function uninstall() {
    removeWatcher();
    cleanLegacy();
    let n = 0;
    for (const file of findCoreFiles()) {
        const bak = file + ".blxstncord.bak";
        if (fs.existsSync(bak)) {
            fs.copyFileSync(bak, file);
            fs.unlinkSync(bak);
            n++;
        }
    }
    // the watcher treats a missing loader.js as "uninstalled" (plugins and settings are kept)
    for (const f of ["loader.js", "renderer.js", "media.ps1"]) { try { fs.rmSync(path.join(dataDir, f), { force: true }); } catch { } }
    console.log(n ? `Restored ${n} file(s). blxstncord removed.` : "Nothing to restore.");
}

// Undo a Vencord injection (it replaces app.asar with an "app" folder)
function cleanVencord() {
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
            console.log(`Removed old Vencord injection from ${a}`);
        } catch (e) {
            console.log(`Could not clean Vencord in ${a}: ${e.message}`);
        }
    }
}

function install() {
    if (fs.existsSync(discordDir)) cleanVencord();
    cleanLegacy();
    const files = findCoreFiles();
    if (!files.length) throw new Error("Could not find discord_desktop_core. Start Discord once, close it, and retry.");

    fs.mkdirSync(dataDir, { recursive: true });
    for (const f of ["loader.js", "renderer.js", "media.ps1"]) {
        fs.copyFileSync(path.join(__dirname, f), path.join(dataDir, f));
    }
    const loaderPath = path.join(dataDir, "loader.js");

    // Plugins: copy the bundled ones. Your own plugin files in that folder are never touched.
    const srcPlugins = path.join(__dirname, "plugins");
    const dstPlugins = path.join(dataDir, "plugins");
    fs.mkdirSync(dstPlugins, { recursive: true });
    for (const f of ["fake-badges.js"]) { // plugins removed in newer versions
        try { fs.rmSync(path.join(dstPlugins, f), { force: true }); } catch { }
    }
    if (!fs.existsSync(srcPlugins)) throw new Error("The 'plugins' folder is missing next to install.js. Unpack the whole blxstncord folder (zip) and run install.bat from inside it.");
    const installed = [];
    for (const f of fs.readdirSync(srcPlugins).filter(f => f.endsWith(".js"))) {
        fs.copyFileSync(path.join(srcPlugins, f), path.join(dstPlugins, f));
        if (!f.startsWith("_")) installed.push(f);
    }
    console.log("Plugins copied (" + installed.length + "): " + installed.join(", "));
    for (const f of ["loader.js", "renderer.js", "media.ps1"]) {
        console.log("  " + f + ": " + fs.statSync(path.join(dataDir, f)).size + " bytes");
    }

    // Only patch the newest app version (older ones are unused leftovers)
    const file = files[0];
    const bak = file + ".blxstncord.bak";
    let original = fs.readFileSync(file, "utf8");

    if (original.startsWith(MARKER)) {
        // Already patched: rebuild from the backup
        original = fs.readFileSync(bak, "utf8");
    } else {
        fs.writeFileSync(bak, original);
    }

    fs.writeFileSync(file, `${MARKER}\nrequire(${JSON.stringify(loaderPath)});\n${original}`);
    console.log(`Installed into:\n  ${file}\nFiles live in: ${dataDir}\nPlugins folder: ${dstPlugins}`);
    installWatcher();
    console.log("Start Discord. Updates are handled automatically from now on.");
}

try {
    process.argv[2] === "uninstall" ? uninstall() : install();
} catch (e) {
    console.error("Failed:", e.message);
    process.exit(1);
}
