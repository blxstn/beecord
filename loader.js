// blxstncord loader: runs in Discord's main process.
// It only reads files from its own folder (renderer.js + plugins/*.js) and runs them in Discord's window.
// No network access. It writes a small log.txt next to itself so you can see what happened.
// Only while the "Spotify Controls" plugin is on, it also runs media.ps1 (a hidden local PowerShell helper that
// talks to the Windows media controls) and relays play/pause/next/previous/shuffle/repeat/volume between the page and that helper.
//
// Plugin detection: every plugins/*.js file (not starting with "_") is injected on startup and
// whenever you press "Rescan plugins" in the blxstncord settings tab.

const { app, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const logFile = path.join(__dirname, "log.txt");
const pluginsDir = path.join(__dirname, "plugins");
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
                `(function(){const blxstncord=window.blxstncord;if(!blxstncord)return;blxstncord.__file=${name};` +
                `try{\n${code}\n}catch(e){blxstncord.__pluginError(${name},e)}finally{blxstncord.__file=null}})();`;
            try {
                await wc.executeJavaScript(wrapped);
            } catch (e) {
                log("plugin " + f + " failed to parse/run: " + e);
                await wc.executeJavaScript(`window.blxstncord&&window.blxstncord.__pluginError(${name},${JSON.stringify(String(e && e.message || e))})`).catch(() => { });
            }
        }
        if (!wc.isDestroyed()) {
            await wc.executeJavaScript(`window.blxstncord&&window.blxstncord.__finishScan(${JSON.stringify(files)},${JSON.stringify(pluginsDir)})`);
        }
    } catch (e) {
        log("plugin injection error: " + e);
    } finally {
        scanning = false;
    }
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
    if (mediaArtKey !== null && mediaArtSeen.get(wc) !== mediaArtVer) {   // the cover is big, send it only when it changed
        out.art = mediaArt;
        mediaArtSeen.set(wc, mediaArtVer);
    }
    out.artKey = mediaArtKey;
    wc.executeJavaScript(`window.dispatchEvent(new CustomEvent("blxstncord-media",{detail:${JSON.stringify(out)}}))`).catch(() => { });
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
    if (!fs.existsSync(mediaScript)) { log("media: media.ps1 is missing, run install.bat again"); return; }
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

// "cmd:media:start|stop|toggle|next|prev|seek:<ms>|shuffle:on|off|repeat:none|track|list|volume:<0-100>|mute:on|off" coming from the page. Anything else is ignored.
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
    // Messages from the page console: copy [blxstncord] lines into log.txt, and handle commands from the settings tab
    win.webContents.on("console-message", (...args) => {
        const msg = typeof args[2] === "string" ? args[2] : (args[0] && args[0].message);
        if (typeof msg !== "string" || !msg.includes("[blxstncord]")) return;
        if (msg.includes("cmd:rescan")) { injectPlugins(win.webContents); return; }
        if (msg.includes("cmd:open-folder")) { shell.openPath(pluginsDir); return; }
        if (msg.includes("cmd:media:")) { mediaCommand(win.webContents, msg); return; }
        log(msg);
    });

    win.webContents.on("destroyed", () => mediaClients.delete(win.webContents));

    win.webContents.on("dom-ready", async () => {
        try {
            mediaArtSeen.delete(win.webContents);   // a reloaded page has no cover yet
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
