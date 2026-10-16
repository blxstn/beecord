// beecord loader: runs in Discord's main process.
// It reads files from its own folder (renderer.js + plugins/*.js) and runs them in Discord's window.
// Writes log.txt next to itself so you can see what happened.
// Runs media.ps1 for the "Spotify Controls" plugin to bridge Windows media controls.

const { app, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "log.txt");
const pluginsDir = fs.existsSync(path.join(__dirname, "plugins"))
    ? path.join(__dirname, "plugins")
    : path.join(__dirname, "..", "plugins");
const log = m => { try { fs.appendFileSync(logFile, new Date().toLocaleTimeString() + "  " + m + "\n"); } catch { } };
try { fs.writeFileSync(logFile, ""); } catch { }
try { fs.mkdirSync(pluginsDir, { recursive: true }); } catch { }
log("loader started");

function listPlugins() {
    try {
        return fs.readdirSync(pluginsDir)
            .filter(f => /\.js$/i.test(f) && !f.startsWith("_") && !f.startsWith("."))
            .sort();
    } catch (e) {
        log("cannot read plugins folder: " + e);
        return [];
    }
}

// Runs every plugin file inside the page. A broken plugin can't break the others.
let scanning = false;
async function injectPlugins(wc) {
    if (scanning || wc.isDestroyed()) return;
    scanning = true;
    try {
        const files = listPlugins();
        log("plugin files found: " + (files.join(", ") || "none"));
        for (const f of files) {
            if (wc.isDestroyed()) return;
            let code;
            try { code = fs.readFileSync(path.join(pluginsDir, f), "utf8"); }
            catch (e) { log("cannot read " + f + ": " + e); continue; }
            const name = JSON.stringify(f);
            const wrapped =
                `(function(){\n` +
                `const beecord = window.beecord || window.blxstncord;\n` +
                `const blxstncord = beecord;\n` +
                `if (!beecord) return;\n` +
                `beecord.__file = ${name};\n` +
                `try {\n${code}\n} catch(e) {\n` +
                `  beecord.__pluginError(${name}, e);\n` +
                `} finally {\n` +
                `  beecord.__file = null;\n` +
                `}\n` +
                `})();`;
            try {
                await wc.executeJavaScript(wrapped);
            } catch (e) {
                log("plugin " + f + " failed to parse/run: " + e);
                await wc.executeJavaScript(`(window.beecord||window.blxstncord)&&(window.beecord||window.blxstncord).__pluginError(${name},${JSON.stringify(String(e && e.message || e))})`).catch(() => { });
            }
        }
        if (!wc.isDestroyed()) {
            await wc.executeJavaScript(`(window.beecord||window.blxstncord)&&(window.beecord||window.blxstncord).__finishScan(${JSON.stringify(files)},${JSON.stringify(pluginsDir)})`);
        }
    } catch (e) {
        log("plugin injection error: " + e);
    } finally {
        scanning = false;
    }
}

// ---------- live reload of the plugins folder ----------
const pages = new Set();
let hotTimer = null;
function hotReload() {
    clearTimeout(hotTimer);
    hotTimer = setTimeout(async () => {
        for (const wc of [...pages]) {
            if (wc.isDestroyed()) { pages.delete(wc); continue; }
            if (scanning) { hotReload(); return; }
            await injectPlugins(wc);
        }
    }, 800);
}
let pluginWatcher = null;
try {
    pluginWatcher = fs.watch(pluginsDir, () => hotReload());
    log("watching the plugins folder for changes");
} catch (e) {
    log("cannot watch the plugins folder: " + e.message);
}

// ---------- media bridge (Spotify Controls plugin) ----------
const mediaScript = path.join(__dirname, "media.ps1");
const mediaClients = new Set();     // webContents that asked for media updates
const mediaArtSeen = new WeakMap(); // webContents -> version of the album cover it already has
let mediaProc = null, mediaBuf = "", mediaLast = null;
let mediaArt = "", mediaArtKey = null, mediaArtVer = 0;
let mediaCmdN = 0, mediaRestarts = 0;

function mediaSend(wc, o) {
    if (wc.isDestroyed()) { mediaClients.delete(wc); return; }
    const out = Object.assign({}, o);
    delete out.art;
    if (mediaArtKey !== null && mediaArtSeen.get(wc) !== mediaArtVer) {
        out.art = mediaArt;
        mediaArtSeen.set(wc, mediaArtVer);
    }
    out.artKey = mediaArtKey;
    wc.executeJavaScript(
        `window.dispatchEvent(new CustomEvent("beecord-media",{detail:${JSON.stringify(out)}}));` +
        `window.dispatchEvent(new CustomEvent("blxstncord-media",{detail:${JSON.stringify(out)}}));`
    ).catch(() => { });
}

function mediaOnLine(line) {
    line = line.trim();
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { log("media: unreadable output: " + line.slice(0, 120)); return; }
    mediaRestarts = 0;
    if (o.error) log("media: " + o.error);
    if (typeof o.art === "string") { mediaArt = o.art; mediaArtKey = o.key; mediaArtVer++; }
    mediaLast = o;
    for (const wc of mediaClients) mediaSend(wc, o);
}

function mediaStart() {
    if (mediaProc) return;
    if (!fs.existsSync(mediaScript)) { log("media: media.ps1 is missing in " + __dirname); return; }
    try { for (const f of fs.readdirSync(__dirname).filter(f => /^media-.*\.cmd$/.test(f))) fs.unlinkSync(path.join(__dirname, f)); } catch { }
    mediaBuf = "";
    let p;
    try {
        p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", mediaScript,
            "-CmdDir", __dirname, "-ParentPid", String(process.pid)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { log("media: cannot start PowerShell: " + e.message); return; }
    mediaProc = p;
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", d => {
        mediaBuf += d;
        let i;
        while ((i = mediaBuf.indexOf("\n")) >= 0) { const l = mediaBuf.slice(0, i); mediaBuf = mediaBuf.slice(i + 1); mediaOnLine(l); }
    });
    p.stderr.on("data", d => log("media helper: " + String(d).trim().slice(0, 300)));
    p.on("error", e => { log("media: cannot start PowerShell: " + e.message); if (mediaProc === p) mediaProc = null; });
    p.on("exit", code => {
        const unexpected = mediaProc === p;
        if (unexpected) mediaProc = null;
        log("media: helper exited (" + code + ")");
        if (unexpected && mediaClients.size && mediaRestarts++ < 5) setTimeout(mediaStart, 3000);
    });
    log("media: helper started");
}

function mediaStopProc() {
    const p = mediaProc;
    mediaProc = null;
    if (p) { try { p.kill(); } catch { } }
}

function mediaCommand(wc, msg) {
    const m = /cmd:media:([a-z]+(?::(?:\d{1,9}|[a-z]{2,5}))?)(?![\w:])/.exec(msg);
    if (!m) return;
    const c = m[1];
    if (c === "start") {
        mediaClients.add(wc);
        mediaArtSeen.delete(wc);
        mediaStart();
        if (mediaLast) mediaSend(wc, mediaLast);
        return;
    }
    if (c === "stop") {
        mediaClients.delete(wc);
        if (!mediaClients.size) mediaStopProc();
        return;
    }
    if (!mediaClients.has(wc) || !/^(toggle|next|prev|seek:\d{1,9}|shuffle:(on|off)|repeat:(none|track|list)|volume:\d{1,3}|mute:(on|off))$/.test(c)) return;
    try { fs.writeFileSync(path.join(__dirname, "media-" + Date.now() + "-" + String(mediaCmdN++ % 1000).padStart(3, "0") + ".cmd"), c); }
    catch (e) { log("media: cannot write command: " + e.message); }
}
app.on("will-quit", mediaStopProc);

app.on("browser-window-created", (_event, win) => {
    pages.add(win.webContents);

    win.webContents.on("console-message", (...args) => {
        const msg = typeof args[2] === "string" ? args[2] : (args[0] && args[0].message);
        if (typeof msg !== "string" || (!msg.includes("[beecord]") && !msg.includes("[blxstncord]"))) return;
        if (msg.includes("cmd:rescan")) { injectPlugins(win.webContents); return; }
        if (msg.includes("cmd:open-folder")) { shell.openPath(pluginsDir); return; }
        if (msg.includes("cmd:media:")) { mediaCommand(win.webContents, msg); return; }
        log(msg);
    });

    win.webContents.on("destroyed", () => {
        mediaClients.delete(win.webContents);
        pages.delete(win.webContents);
    });

    win.webContents.on("dom-ready", async () => {
        try {
            mediaArtSeen.delete(win.webContents);
            const url = win.webContents.getURL();
            if (!/discord\.com/.test(url)) return;
            log("injecting into " + url);
            const code = fs.readFileSync(path.join(__dirname, "renderer.js"), "utf8");
            await win.webContents.executeJavaScript(code);
            await injectPlugins(win.webContents);
        } catch (e) {
            log("loader error: " + e);
        }
    });
});
