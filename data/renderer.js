// beecord renderer (core): runs inside Discord's web page.
// It provides the plugin system and the "beecord" tab in Discord Settings.
// Plugins are separate files in %APPDATA%\beecord\plugins\*.js (detected by loader.js).
// Console helpers (Ctrl+Shift+I): beecord.plugins(), beecord.status(), beecord.open(), beecord.rescan()

(() => {
    if (window.beecord || window.blxstncord) return;

    // ---------- config ----------
    const KEY = "beecord_config_v1";
    const LEGACY_KEY = "blxstncord_config_v2";
    const OLD_KEY = "fakecord_config_v2";

    function loadConfig() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { }
        if (!saved) { try { saved = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); } catch { } }
        if (!saved) { try { saved = JSON.parse(localStorage.getItem(OLD_KEY) || "null"); } catch { } }
        if (!saved) {
            let old = {};
            try { old = JSON.parse(localStorage.getItem("fakecord_config") || "{}"); } catch { }
            saved = { enabled: { ...(old.enabled || {}) }, settings: {} };
            if (old.silentTyping === false) saved.enabled.typing = false;
            const v = {};
            if (old.fakeMute !== undefined) v.fakeMute = old.fakeMute;
            if (old.fakeDeafen !== undefined) v.fakeDeafen = old.fakeDeafen;
            if (Object.keys(v).length) saved.settings.voice = v;
            if (Array.isArray(old.badges)) saved.settings.badges = { badges: old.badges };
        }
        return { enabled: saved.enabled || {}, settings: saved.settings || {} };
    }
    const config = loadConfig();
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(config)); } catch { } };

    const log = (...a) => console.log("[beecord] " + a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
    log("renderer injected, waiting for Discord to finish loading");

    // ---------- webpack access ----------
    let req = null; // set once Discord has finished loading its modules
    function getRequire() {
        const chunk = window.webpackChunkdiscord_app;
        if (!Array.isArray(chunk)) return null;
        let r;
        chunk.push([[Symbol("blxstncord")], {}, x => { r = x; }]);
        chunk.pop();
        return r;
    }

    // req.m = every module definition (even ones that have not run yet). req.c = only the ones that ran.
    // So we search definitions by source text and load only the few matches.
    const idCache = {};
    function candidateIds(cacheKey, needles) {
        if (!req) return [];
        if (idCache[cacheKey]) return idCache[cacheKey];
        const out = [];
        for (const id of Object.keys(req.m)) {
            let s;
            try { s = req.m[id].toString(); } catch { continue; }
            if (needles.every(n => s.includes(n))) out.push(id);
        }
        const limited = out.slice(0, 80);
        if (limited.length) idCache[cacheKey] = limited;
        return limited;
    }

    function* exportsOf(id) {
        let m;
        const cached = req.c && req.c[id];
        if (cached) m = cached.exports;
        else { try { m = req(id); } catch { return; } }
        if (!m) return;
        yield m;
        let keys = [];
        try { keys = Object.keys(m); } catch { }
        for (const k of keys) {
            let v;
            try { v = m[k]; } catch { continue; }
            yield v;
        }
    }

    function findByProps(needles, ...props) {
        for (const id of candidateIds("props:" + needles.join("|") + ":" + props.join(","), needles)) {
            for (const e of exportsOf(id)) {
                try {
                    if (e && (typeof e === "object" || typeof e === "function") && props.every(p => e[p] !== undefined)) return e;
                } catch { }
            }
        }
    }

    function findByPrototype(needles, name) {
        for (const id of candidateIds("proto:" + needles.join("|") + ":" + name, needles)) {
            for (const e of exportsOf(id)) {
                try {
                    if (typeof e === "function" && e.prototype && typeof e.prototype[name] === "function") return e;
                } catch { }
            }
        }
    }

    // Source-based search with your own test: loads only modules whose source contains all needles,
    // then returns the first export (or direct property of an export) for which pred(obj) is true.
    function findBy(key, needles, pred) {
        for (const id of candidateIds("by:" + key + ":" + needles.join("|"), needles)) {
            for (const e of exportsOf(id)) {
                try { if (e && (typeof e === "object" || typeof e === "function") && pred(e)) return e; } catch { }
            }
        }
    }
    // How many module definitions contain all the needles (for diagnostics)
    function countModules(needles) {
        if (!req || !req.m) return -1;
        let n = 0;
        for (const id of Object.keys(req.m)) {
            let s;
            try { s = req.m[id].toString(); } catch { continue; }
            if (needles.every(x => s.includes(x))) n++;
        }
        return n;
    }

    // Search every module that has already run (req.c) for objects matching pred(obj).
    // depth 1 = the module's exports and their direct properties; higher goes deeper (slower).
    function scan(pred, depth, limit) {
        const out = [];
        if (!req || !req.c) return out;
        const seen = new Set();
        const walk = (obj, d) => {
            if (out.length >= limit) return;
            if (!obj || (typeof obj !== "object" && typeof obj !== "function") || obj.nodeType || seen.has(obj)) return;
            seen.add(obj);
            try { if (pred(obj)) { out.push(obj); return; } } catch { }
            if (d <= 0) return;
            let keys = [];
            try { keys = Object.keys(obj); } catch { return; }
            for (const k of keys) {
                if (out.length >= limit) return;
                let v;
                try { v = obj[k]; } catch { continue; }
                walk(v, d - 1);
            }
        };
        for (const id of Object.keys(req.c)) {
            if (out.length >= limit) break;
            let ex;
            try { ex = req.c[id] && req.c[id].exports; } catch { continue; }
            walk(ex, depth);
        }
        return out;
    }
    const find = (pred, depth = 1) => scan(pred, depth, 1)[0];
    const findAll = (pred, limit = 10, depth = 1) => scan(pred, depth, limit);
    const stats = () => ({
        defined: req && req.m ? Object.keys(req.m).length : -1,
        loaded: req && req.c ? Object.keys(req.c).length : -1
    });

    // Override obj[name] and verify it really took effect. Returns an "unpatch" function.
    // After unpatch the wrapper becomes a pass-through, even if someone else patched on top of it.
    function patch(obj, name, make) {
        const orig = obj[name];
        const inner = make(orig);
        let active = true;
        const wrapped = function (...args) { return (active ? inner : orig).apply(this, args); };
        try { obj[name] = wrapped; } catch { }
        if (obj[name] !== wrapped) {
            Object.defineProperty(obj, name, { value: wrapped, writable: true, configurable: true });
        }
        if (obj[name] !== wrapped) throw new Error("could not override " + name);
        return () => {
            active = false;
            try { if (obj[name] === wrapped) obj[name] = orig; } catch { }
            if (obj[name] === wrapped) {
                try { Object.defineProperty(obj, name, { value: orig, writable: true, configurable: true }); } catch { }
            }
        };
    }

    // ---------- plugin registry ----------
    // Plugin files call beecord.definePlugin({ id, name, description, author, version, enabledByDefault,
    //   webpack (default true), start(api), stop(api), options(api) }).
    // start() returns false when the Discord module it needs was not found yet (it is retried automatically).
    // Everything registered through api.patch / api.addStyle / api.on / api.cleanup is undone on stop.
    const plugins = new Map(); // id -> record
    const logSources = new Map(); // plugin id -> { title, list(), remove(id), clear() }  (shown in the Logs tab)
    const loadErrors = {};     // file name -> error text
    let pluginsDir = "";
    const lastLogged = {};

    const isEnabled = rec => {
        const v = config.enabled[rec.id];
        return v === undefined ? !!rec.def.enabledByDefault : !!v;
    };

    function runCleanups(rec) {
        while (rec.cleanups.length) {
            const fn = rec.cleanups.pop();
            try { fn(); } catch (e) { log("cleanup error in " + rec.name + ": " + (e && e.message || e)); }
        }
    }

    function makeApi(rec) {
        const id = rec.id;
        return {
            id,
            log: (...a) => log(rec.name + ":", ...a),
            settings: {
                get: (k, d) => { const s = config.settings[id]; return s && k in s ? s[k] : d; },
                set: (k, v) => { (config.settings[id] = config.settings[id] || {})[k] = v; save(); }
            },
            webpack: { findByProps, findByPrototype, findBy, count: countModules, find, findAll, stats },
            patch(obj, name, make) { const un = patch(obj, name, make); rec.cleanups.push(un); return un; },
            cleanup(fn) { rec.cleanups.push(fn); },
            addStyle(css) {
                const s = h("style", { "data-blxstncord-plugin": id });
                s.textContent = css;
                (document.head || document.documentElement).append(s);
                rec.cleanups.push(() => s.remove());
                return s;
            },
            on(target, ev, fn, opts) {
                target.addEventListener(ev, fn, opts);
                rec.cleanups.push(() => target.removeEventListener(ev, fn, opts));
            },
            logs: {
                register(src) {
                    logSources.set(id, src);
                    rec.cleanups.push(() => { logSources.delete(id); if (panel && panelView === "logs") refreshPanel(); });
                    if (panel && panelView === "logs") refreshPanel();
                },
                refresh() { if (panel && panelView === "logs") scheduleLogsRefresh(); }
            },
            ui: { h, toggle, row, note, chips, textarea }
        };
    }

    // A plugin whose start() fails is retried with a growing delay (2s, 4s, 8s, then every 15s). Before, it was retried
    // every 0.5s for 6 minutes, and each retry of a module search scans thousands of Discord modules, which could freeze the UI.
    function tryStart(rec, force) {
        if (!isEnabled(rec)) { rec.status = "off"; return; }
        if (rec.status === "ok") return;
        if (rec.def.webpack !== false && !req) { rec.status = "waiting"; return; }
        if (!force && rec.nextTry && Date.now() < rec.nextTry) return;
        runCleanups(rec);
        try {
            const r = rec.def.start(rec.api);
            if (r === false) { runCleanups(rec); rec.status = "NOT FOUND"; }
            else rec.status = "ok";
        } catch (e) {
            runCleanups(rec);
            rec.status = "FAILED: " + (e && e.message || e);
        }
        if (rec.status === "ok") { rec.fails = 0; rec.nextTry = 0; }
        else { rec.fails = (rec.fails || 0) + 1; rec.nextTry = Date.now() + Math.min(1000 * Math.pow(2, Math.min(rec.fails, 4)), 15000); }
    }

    function stopPlugin(rec) {
        try { if (rec.status === "ok" && typeof rec.def.stop === "function") rec.def.stop(rec.api); }
        catch (e) { log("stop error in " + rec.name + ": " + (e && e.message || e)); }
        runCleanups(rec);
        rec.status = "off";
    }

    function setEnabled(rec, value) {
        config.enabled[rec.id] = !!value;
        save();
        if (value) tryStart(rec, true); else stopPlugin(rec);
        logChanges();
        log("plugin " + rec.name + (value ? " enabled" : " disabled"));
    }

    function definePlugin(def) {
        if (!def || typeof def !== "object" || !def.id || typeof def.start !== "function") {
            throw new Error("definePlugin needs an object with { id, start() }");
        }
        const id = String(def.id);
        const file = (window.blxstncord && window.blxstncord.__file) || "?";
        const old = plugins.get(id);
        if (old) stopPlugin(old); // same id again = hot reload
        const rec = {
            id, def, file,
            name: String(def.name || id),
            description: String(def.description || ""),
            author: def.author ? String(def.author) : "",
            version: def.version ? String(def.version) : "",
            status: "off",
            cleanups: []
        };
        rec.api = makeApi(rec);
        plugins.set(id, rec);
        delete loadErrors[file];
        tryStart(rec, true);
        logChanges();
        return rec.id;
    }

    function logChanges() {
        for (const p of plugins.values()) {
            const s = p.status;
            if (s === "waiting" || lastLogged[p.id] === s) continue;
            lastLogged[p.id] = s;
            log("plugin " + p.name + ": " + (s === "ok" ? "WORKING" : s === "off" ? "off" : s));
        }
    }

    function logSummary() {
        const list = [...plugins.values()].filter(isEnabled);
        const works = list.filter(p => p.status === "ok").map(p => p.name);
        const broken = list.filter(p => p.status !== "ok").map(p => p.name + " (" + p.status + ")");
        log("PLUGINS WORKING: " + (works.join(", ") || "none"));
        if (broken.length) log("PLUGINS NOT WORKING: " + broken.join(", "));
    }

    let lastSig = "";
    const sig = () => [...plugins.values()].map(r => r.id + ":" + r.status).join("|") + "#" + Object.keys(loadErrors).join(",");
    function refreshIfChanged() {
        const s = sig();
        if (s !== lastSig) { lastSig = s; refreshPanel(); }
    }

    // ---------- tiny DOM helpers ----------
    function h(tag, attrs, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === "class") el.className = v;
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v);
        }
        for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
        return el;
    }

    function toggle(checked, onChange) {
        const el = h("div", { class: "fc-switch" + (checked ? " on" : ""), role: "switch", "aria-checked": String(checked), tabindex: "0" }, h("div", { class: "fc-knob" }));
        el.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); el.click(); } });
        el.addEventListener("click", () => {
            checked = !checked;
            el.classList.toggle("on", checked);
            el.setAttribute("aria-checked", String(checked));
            onChange(checked);
        });
        return el;
    }

    function chips(items, selected, onChange) {
        const wrap = h("div", { class: "fc-chips" });
        for (const it of items) {
            const chip = h("div", { class: "fc-chip" + (selected.includes(it) ? " on" : "") }, String(it).replace(/_/g, " ").toLowerCase());
            chip.addEventListener("click", () => {
                const i = selected.indexOf(it);
                if (i >= 0) selected.splice(i, 1); else selected.push(it);
                chip.classList.toggle("on", selected.includes(it));
                onChange(selected.slice());
            });
            wrap.append(chip);
        }
        return wrap;
    }

    function textarea(value, onInput, placeholder) {
        const el = h("textarea", { class: "fc-textarea", spellcheck: "false", placeholder: placeholder || "" });
        el.value = value || "";
        el.addEventListener("input", () => onInput(el.value));
        el.addEventListener("keydown", e => e.stopPropagation());
        return el;
    }

    const row = (label, control) => h("div", { class: "fc-row" }, h("span", null, label), control);
    const note = text => h("div", { class: "fc-note" }, text);

    // ---------- profile (shown in the Credits tab) ----------
    const PROFILE = {
        name: "blxstngoated",
        discord: "blxstngoated",
        instagram: "blxstnsobased",
        instagramUrl: "https://www.instagram.com/blxstnsobased/",
        avatar: "data:image/jpeg;base64,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"
    };
    const ICO_INSTAGRAM = "M7.8 2h8.4C19.4 2 22 4.6 22 7.8v8.4a5.8 5.8 0 0 1-5.8 5.8H7.8C4.6 22 2 19.4 2 16.2V7.8A5.8 5.8 0 0 1 7.8 2m-.2 2A3.6 3.6 0 0 0 4 7.6v8.8C4 18.39 5.61 20 7.6 20h8.8a3.6 3.6 0 0 0 3.6-3.6V7.6C20 5.61 18.39 4 16.4 4H7.6m9.65 1.5a1.25 1.25 0 0 1 1.25 1.25A1.25 1.25 0 0 1 17.25 8 1.25 1.25 0 0 1 16 6.75a1.25 1.25 0 0 1 1.25-1.25M12 7a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5m0 2a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3z";
    const ICO_PERSON = "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z";
    const ICO_NEXT = "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z";

    // ---------- settings panel ----------
    const CSS = `
    #blxstncord-panel{--bc-accent:#5865f2;--bc-line:rgba(255,255,255,.08);--bc-surface:rgba(255,255,255,.035);--bc-surface-2:rgba(255,255,255,.07);--bc-inset:rgba(0,0,0,.3);
        --bc-dim:var(--text-muted,#949ba4);--bc-text:var(--text-default,var(--text-normal,#dbdee1));--bc-head:var(--header-primary,#f2f3f5);
        position:fixed;top:0;right:0;bottom:0;z-index:99990;overflow-y:auto;padding:64px 40px 72px;box-sizing:border-box;
        background:var(--background-base-low,var(--background-primary,#313338));color:var(--bc-text);scrollbar-width:thin;
        font-family:var(--font-primary,"gg sans","Noto Sans",sans-serif);font-size:14px;line-height:1.4}
    #blxstncord-panel[data-light]{--bc-line:rgba(0,0,0,.1);--bc-surface:rgba(0,0,0,.03);--bc-surface-2:rgba(0,0,0,.06);--bc-inset:rgba(0,0,0,.05)}
    #blxstncord-panel *{box-sizing:border-box}
    #blxstncord-panel button{all:unset;box-sizing:border-box;cursor:pointer}
    #blxstncord-panel :focus-visible{outline:2px solid var(--bc-accent);outline-offset:2px}
    #blxstncord-panel .fc-wrap{max-width:720px;margin:0 auto}
    #blxstncord-panel .fc-close{position:fixed;top:22px;right:30px;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        color:var(--bc-dim);border:2px solid var(--bc-line);transition:color .15s,background .15s}
    #blxstncord-panel .fc-close:hover{color:var(--bc-head);background:var(--bc-surface-2)}
    #blxstncord-panel svg{width:18px;height:18px;fill:currentColor;flex:none}

    /* plugins page */
    #blxstncord-panel .fc-top h1{margin:0;font:800 30px/1.1 var(--font-display,var(--font-primary,sans-serif));letter-spacing:-.025em;color:var(--bc-head)}
    #blxstncord-panel .fc-sub{margin:6px 0 22px;color:var(--bc-dim);font-size:14px}
    #blxstncord-panel .fc-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
    #blxstncord-panel .fc-searchwrap{position:relative;flex:1 1 220px;color:var(--bc-dim)}
    #blxstncord-panel .fc-searchwrap svg{position:absolute;left:13px;top:11px}
    #blxstncord-panel .fc-search{width:100%;height:40px;padding:0 14px 0 40px;border-radius:10px;border:1px solid var(--bc-line);background:var(--bc-surface);
        color:var(--bc-text);font:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
    #blxstncord-panel .fc-search:focus{border-color:var(--bc-accent);box-shadow:0 0 0 3px rgba(88,101,242,.28)}
    #blxstncord-panel .fc-btn{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border-radius:10px;font-weight:600;
        background:var(--bc-accent);color:#fff;transition:filter .15s,background .15s}
    #blxstncord-panel .fc-btn:hover{filter:brightness(1.12)}
    #blxstncord-panel .fc-btn.sec{background:var(--bc-surface-2);color:var(--bc-text)}
    #blxstncord-panel .fc-btn.sec:hover{filter:none;background:var(--bc-line);color:var(--bc-head)}
    #blxstncord-panel .fc-path{display:flex;align-items:center;gap:8px;margin:12px 0 22px;color:var(--bc-dim);font:12px Consolas,monospace;word-break:break-all}
    #blxstncord-panel .fc-list{border:1px solid var(--bc-line);border-radius:14px;overflow:hidden;background:var(--bc-surface)}
    #blxstncord-panel .fc-item{padding:16px 18px 14px;border-top:1px solid var(--bc-line);transition:background .15s}
    #blxstncord-panel .fc-item:first-child{border-top:0}
    #blxstncord-panel .fc-item:hover{background:var(--bc-surface)}
    #blxstncord-panel .fc-item.fc-err{box-shadow:inset 3px 0 0 #f23f42}
    #blxstncord-panel .fc-head{display:flex;align-items:flex-start;gap:14px}
    #blxstncord-panel .fc-tile{flex:none;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;
        letter-spacing:-.02em;background:hsl(var(--h,235) 55% 50% / .2);color:hsl(var(--h,235) 85% 74%)}
    #blxstncord-panel .fc-tile.bad{background:rgba(242,63,66,.18);color:#f87578}
    #blxstncord-panel .fc-title{flex:1;min-width:0}
    #blxstncord-panel .fc-line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;min-height:24px}
    #blxstncord-panel .fc-name{font-size:16px;font-weight:700;color:var(--bc-head)}
    #blxstncord-panel .fc-ver{font-size:12px;color:var(--bc-dim)}
    #blxstncord-panel .fc-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--bc-dim)}
    #blxstncord-panel .fc-status i{width:8px;height:8px;border-radius:50%;background:#80848e}
    #blxstncord-panel .fc-status.ok{color:#2dc770}
    #blxstncord-panel .fc-status.ok i{background:#23a559;box-shadow:0 0 0 3px rgba(35,165,89,.22)}
    #blxstncord-panel .fc-status.wait i{background:#f0b232}
    #blxstncord-panel .fc-status.bad{color:#f23f42}
    #blxstncord-panel .fc-status.bad i{background:#f23f42}
    #blxstncord-panel .fc-desc{margin-top:3px;color:var(--bc-dim);font-size:13.5px;max-width:60ch}
    #blxstncord-panel .fc-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin:10px 0 0 58px;font-size:12px;color:var(--bc-dim)}
    #blxstncord-panel .fc-foot code{font:12px Consolas,monospace;padding:1px 6px;border-radius:5px;background:var(--bc-surface-2)}
    #blxstncord-panel .fc-morebtn{display:inline-flex;align-items:center;gap:2px;padding:2px 6px 2px 8px;margin-left:-8px;border-radius:7px;font-weight:600;color:var(--bc-dim)}
    #blxstncord-panel .fc-morebtn:hover{color:var(--bc-head);background:var(--bc-surface-2)}
    #blxstncord-panel .fc-morebtn svg{width:20px;height:20px;transition:transform .2s}
    #blxstncord-panel .fc-item.open .fc-morebtn svg{transform:rotate(180deg)}
    #blxstncord-panel .fc-optwrap{display:grid;grid-template-rows:0fr;margin-left:58px;transition:grid-template-rows .22s ease}
    #blxstncord-panel .fc-item.open .fc-optwrap{grid-template-rows:1fr}
    #blxstncord-panel .fc-optin{overflow:hidden;min-height:0}
    #blxstncord-panel .fc-opts{margin-top:12px;padding:4px 16px 10px;border-radius:10px;background:var(--bc-inset)}
    #blxstncord-panel .fc-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--bc-line)}
    #blxstncord-panel .fc-row:last-of-type{border-bottom:0}
    #blxstncord-panel .fc-note{margin-top:8px;font-size:12px;line-height:1.5;color:var(--bc-dim)}
    #blxstncord-panel .fc-empty{padding:48px 0;text-align:center;color:var(--bc-dim)}
    #blxstncord-panel .fc-switch{width:42px;height:26px;border-radius:13px;background:rgba(128,132,142,.5);position:relative;cursor:pointer;flex:none;transition:background .2s}
    #blxstncord-panel .fc-switch.on{background:#23a559}
    #blxstncord-panel .fc-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:left .2s cubic-bezier(.4,0,.2,1)}
    #blxstncord-panel .fc-switch.on .fc-knob{left:19px}
    #blxstncord-panel .fc-chips{display:flex;flex-wrap:wrap;gap:6px}
    #blxstncord-panel .fc-chip{cursor:pointer;padding:5px 13px;border-radius:999px;font-size:12.5px;font-weight:600;border:1px solid var(--bc-line);color:var(--bc-dim);user-select:none;transition:background .15s,color .15s}
    #blxstncord-panel .fc-chip:hover{color:var(--bc-head)}
    #blxstncord-panel .fc-chip.on{background:var(--bc-accent);border-color:var(--bc-accent);color:#fff}
    #blxstncord-panel .fc-textarea{width:100%;min-height:150px;resize:vertical;padding:10px 12px;border-radius:8px;border:1px solid var(--bc-line);background:rgba(0,0,0,.25);color:inherit;
        font:13px Consolas,monospace;outline:none}
    #blxstncord-panel .fc-textarea:focus{border-color:var(--bc-accent)}

    /* credits page */
    #blxstncord-panel .fc-hero{position:relative;overflow:hidden;padding:56px 44px 48px;border-radius:22px;border:1px solid var(--bc-line);
        background:radial-gradient(70% 120% at 0% 0%,rgba(88,101,242,.42),transparent 62%),var(--bc-surface)}
    #blxstncord-panel .fc-logo{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin-bottom:28px;
        background:var(--bc-accent);box-shadow:0 10px 30px rgba(88,101,242,.45);color:#fff}
    #blxstncord-panel .fc-logo svg{width:30px;height:30px}
    #blxstncord-panel .fc-word{margin:0;font:800 clamp(40px,8vw,68px)/.95 var(--font-display,var(--font-primary,sans-serif));letter-spacing:-.05em;color:var(--bc-head)}
    #blxstncord-panel .fc-tag{margin:14px 0 0;font-size:16px;color:var(--bc-text);opacity:.8}
    #blxstncord-panel .fc-by{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:28px 6px 26px;border-bottom:1px solid var(--bc-line)}
    #blxstncord-panel .fc-bylabel{font-size:13px;color:var(--bc-dim)}
    #blxstncord-panel .fc-handle{margin:2px 0;font:800 30px/1.1 var(--font-display,var(--font-primary,sans-serif));letter-spacing:-.03em;color:var(--bc-head)}
    #blxstncord-panel .fc-bysub{font-size:13px;color:var(--bc-dim)}
    #blxstncord-panel .fc-facts{margin:0;padding:0 6px}
    #blxstncord-panel .fc-fact{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 0;border-bottom:1px solid var(--bc-line)}
    #blxstncord-panel .fc-fact dt{color:var(--bc-dim)}
    #blxstncord-panel .fc-fact dd{margin:0;display:flex;align-items:center;gap:12px;min-width:0;font-weight:600;color:var(--bc-head)}
    #blxstncord-panel .fc-fact dd span{font:12px Consolas,monospace;font-weight:400;color:var(--bc-dim);word-break:break-all}
    #blxstncord-panel .fc-fact .fc-btn{height:32px;padding:0 12px;font-size:13px}
    #blxstncord-panel .fc-fine{margin:22px 6px 0;font-size:12px;color:var(--bc-dim);max-width:52ch}
    #blxstncord-panel.bc-anim .fc-hero{animation:bc-rise .55s cubic-bezier(.2,.7,.2,1) both}
    #blxstncord-panel.bc-anim .fc-handle{animation:bc-rise .55s .12s cubic-bezier(.2,.7,.2,1) both}
    @keyframes bc-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

    /* ===== animated UI (settings / plugins / credits) ===== */
    #blxstncord-panel a{color:inherit;text-decoration:none}
    #blxstncord-panel{background:radial-gradient(60% 50% at 15% 10%,rgba(88,101,242,.16),transparent 70%),radial-gradient(50% 45% at 90% 85%,rgba(235,69,158,.11),transparent 70%),var(--background-base-low,var(--background-primary,#313338));
        background-size:160% 160%,160% 160%,auto;background-attachment:fixed,fixed,scroll;animation:bc-aurora 16s ease-in-out infinite alternate}
    #blxstncord-panel.bc-anim{animation:bc-aurora 16s ease-in-out infinite alternate,bc-fade .35s ease backwards}
    #blxstncord-panel.bc-anim .fc-top,#blxstncord-panel.bc-anim .fc-toolbar,#blxstncord-panel.bc-anim .fc-path{animation:bc-rise .5s cubic-bezier(.2,.7,.2,1) backwards}
    #blxstncord-panel.bc-anim .fc-toolbar{animation-delay:.06s}
    #blxstncord-panel.bc-anim .fc-path{animation-delay:.1s}
    #blxstncord-panel.bc-anim .fc-item,#blxstncord-panel.bc-anim .fc-fact,#blxstncord-panel.bc-anim .fc-social,#blxstncord-panel.bc-anim .fc-project,#blxstncord-panel.bc-anim .fc-fine{
        animation:bc-rise .5s calc(.14s + var(--i,0) * .06s) cubic-bezier(.2,.7,.2,1) backwards}
    #blxstncord-panel .fc-close{transition:color .15s,background .15s,transform .3s cubic-bezier(.3,1.5,.5,1)}
    #blxstncord-panel .fc-close:hover{transform:rotate(90deg)}
    #blxstncord-panel .fc-btn{transition:filter .15s,background .15s,transform .15s}
    #blxstncord-panel .fc-btn:hover{transform:translateY(-1px)}
    #blxstncord-panel .fc-btn:active{transform:scale(.95)}
    #blxstncord-panel .fc-tile{transition:transform .3s cubic-bezier(.3,1.6,.5,1)}
    #blxstncord-panel .fc-item:hover .fc-tile{transform:rotate(-7deg) scale(1.1)}
    #blxstncord-panel .fc-status.ok i{animation:bc-pulse 2s ease-out infinite}
    #blxstncord-panel .fc-switch:active .fc-knob{width:26px}
    #blxstncord-panel .fc-switch.on:active .fc-knob{left:13px}
    #blxstncord-panel .fc-chip{transition:background .15s,color .15s,transform .15s}
    #blxstncord-panel .fc-chip:active{transform:scale(.93)}
    #blxstncord-panel .fc-opts{opacity:0;translate:0 -8px;transition:opacity .28s .04s,translate .28s .04s}
    #blxstncord-panel .fc-item.open .fc-opts{opacity:1;translate:0 0}
    #blxstncord-panel .fc-morebtn svg{transition:transform .3s cubic-bezier(.3,1.4,.5,1)}

    /* credits: profile card */
    #blxstncord-panel .fc-hero{--mx:50%;--my:0%;text-align:center;padding:52px 32px 44px;
        background:radial-gradient(420px circle at var(--mx) var(--my),rgba(255,255,255,.09),transparent 60%),
            radial-gradient(70% 120% at 0% 0%,rgba(88,101,242,.42),transparent 62%),
            radial-gradient(60% 100% at 100% 100%,rgba(235,69,158,.28),transparent 60%),var(--bc-surface)}
    #blxstncord-panel .fc-cardin{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;
        transform:perspective(900px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:transform .18s ease-out}
    #blxstncord-panel .fc-parts{position:absolute;inset:0;pointer-events:none;overflow:hidden}
    #blxstncord-panel .fc-parts i{position:absolute;bottom:-12px;left:var(--x);width:var(--s);height:var(--s);border-radius:50%;background:rgba(255,255,255,.55);opacity:0;
        animation:bc-up var(--d) var(--dl) linear infinite}
    #blxstncord-panel .fc-avatar{position:relative;width:var(--s,120px);height:var(--s,120px);border-radius:50%;flex:none;animation:bc-float 5s ease-in-out infinite}
    #blxstncord-panel.bc-anim .fc-avatar{animation:bc-pop .8s .08s cubic-bezier(.3,1.5,.5,1) backwards,bc-float 5s .9s ease-in-out infinite}
    #blxstncord-panel .fc-avatar::before,#blxstncord-panel .fc-avatar::after{content:"";position:absolute;inset:-5px;border-radius:50%;
        background:conic-gradient(#5865f2,#eb459e,#f0b232,#23a559,#5865f2);animation:bc-spin 5s linear infinite}
    #blxstncord-panel .fc-avatar::after{filter:blur(16px);opacity:.6;inset:-8px}
    #blxstncord-panel .fc-avatar img{position:relative;z-index:1;display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;
        border:5px solid var(--background-base-low,var(--background-primary,#313338));transition:transform .35s cubic-bezier(.3,1.5,.5,1)}
    #blxstncord-panel .fc-avatar:hover img{transform:scale(1.06)}
    #blxstncord-panel .fc-eyebrow{margin:26px 0 6px;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--bc-dim)}
    #blxstncord-panel .fc-pname{display:inline-block;margin:0;padding:.06em .08em .26em;
        font-family:Bahnschrift,"Segoe UI Variable Display","Segoe UI Black","Arial Black",var(--font-display,sans-serif);
        font-weight:700;font-variation-settings:"wght" 700,"wdth" 100;font-size:clamp(28px,5.4vw,42px);line-height:1.2;letter-spacing:.045em;
        background:linear-gradient(90deg,var(--bc-head) 0,#8ea1ff 100px,#eb459e 200px,var(--bc-head) 300px);background-size:300px 100%;
        -webkit-background-clip:text;background-clip:text;color:transparent;animation:bc-shimmer 5s linear infinite;
        filter:drop-shadow(0 0 16px rgba(139,120,255,.4))}
    #blxstncord-panel .fc-role{margin:10px 0 0;color:var(--bc-text);opacity:.75;font-size:15px}
    #blxstncord-panel .fc-socials{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:28px}
    #blxstncord-panel .fc-social{display:inline-flex;align-items:center;gap:12px;min-width:230px;padding:10px 14px 10px 10px;border-radius:14px;
        border:1px solid var(--bc-line);background:var(--bc-surface-2);color:var(--bc-head);text-align:left;cursor:pointer;
        transition:translate .22s cubic-bezier(.3,1.5,.5,1),box-shadow .2s,border-color .2s,background .2s}
    #blxstncord-panel .fc-social:hover{translate:0 -4px;box-shadow:0 12px 28px rgba(0,0,0,.3);border-color:rgba(255,255,255,.25)}
    #blxstncord-panel .fc-social:active{translate:0 -1px}
    #blxstncord-panel .fc-sico{width:40px;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;color:#fff;flex:none}
    #blxstncord-panel .fc-sico svg{width:22px;height:22px}
    #blxstncord-panel .fc-social.dc .fc-sico{background:var(--bc-accent)}
    #blxstncord-panel .fc-social.ig .fc-sico{background:linear-gradient(45deg,#f09433,#e6683c 30%,#dc2743 55%,#cc2366 75%,#bc1888)}
    #blxstncord-panel .fc-social.dc:hover{border-color:var(--bc-accent);box-shadow:0 12px 30px rgba(88,101,242,.35)}
    #blxstncord-panel .fc-social.ig:hover{border-color:#dc2743;box-shadow:0 12px 30px rgba(220,39,67,.32)}
    #blxstncord-panel .fc-stxt{display:flex;flex-direction:column;flex:1;min-width:0}
    #blxstncord-panel .fc-stxt b{font-weight:700;font-size:15px}
    #blxstncord-panel .fc-stxt small{font-size:12px;color:var(--bc-dim)}
    #blxstncord-panel .fc-social>svg{width:18px;height:18px;color:var(--bc-dim);transition:translate .2s,color .2s}
    #blxstncord-panel .fc-social:hover>svg{translate:3px 0;color:var(--bc-head)}
    #blxstncord-panel .fc-project{display:flex;align-items:center;gap:16px;margin:22px 0 8px;padding:18px 20px;border-radius:16px;border:1px solid var(--bc-line);background:var(--bc-surface)}
    #blxstncord-panel .fc-project .fc-logo{width:46px;height:46px;border-radius:13px;margin:0}
    #blxstncord-panel .fc-project .fc-logo svg{width:26px;height:26px}
    #blxstncord-panel .fc-project b{display:block;font-size:17px;color:var(--bc-head);letter-spacing:-.02em}
    #blxstncord-panel .fc-project span{font-size:13px;color:var(--bc-dim)}

    @keyframes bc-fade{from{opacity:0}to{opacity:1}}
    @keyframes bc-aurora{from{background-position:0% 0%,100% 100%,0 0}to{background-position:100% 60%,0% 20%,0 0}}
    @keyframes bc-pulse{0%{box-shadow:0 0 0 0 rgba(35,165,89,.55)}70%,100%{box-shadow:0 0 0 7px rgba(35,165,89,0)}}
    @keyframes bc-spin{to{transform:rotate(360deg)}}
    @keyframes bc-float{0%,100%{translate:0 0}50%{translate:0 -7px}}
    @keyframes bc-pop{from{opacity:0;transform:scale(.4) rotate(-12deg)}to{opacity:1;transform:none}}
    @keyframes bc-shimmer{to{background-position:-300px 0}}
    @keyframes bc-up{0%{opacity:0;translate:0 0}15%{opacity:.7}100%{opacity:0;translate:0 -460px}}
    @media (prefers-reduced-motion:reduce){#blxstncord-panel *{animation:none!important;transition:none!important}}`;

    function ensureStyle() {
        if (document.getElementById("blxstncord-style")) return;
        const s = h("style", { id: "blxstncord-style" });
        s.textContent = CSS + LOGS_CSS;
        (document.head || document.documentElement).append(s);
    }

    let toasted = false;
    let panel = null;
    let panelLeft = 0;
    let panelView = "plugins";   // "plugins" | "logs" | "credits"
    const ourTabs = {};          // view -> sidebar tab element
    const tabOrigClass = {};     // view -> its normal (not selected) class

    // ---------- panel content ----------
    const ICO = {
        refresh: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
        folder: "M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z",
        search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
        chevron: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z",
        close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
        trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
        copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z",
        server: "M4 4h16v4H4zm0 6h16v4H4zm0 6h16v4H4z",
        chat: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z",
        friends: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
        sparkles: "M12 2L9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"
    };
    function svgIcon(d) {
        const ns = "http://www.w3.org/2000/svg";
        const el = document.createElementNS(ns, "svg");
        el.setAttribute("viewBox", "0 0 24 24");
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", d);
        el.append(p);
        return el;
    }
    const hueOf = id => { let x = 0; for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
    const isLight = () => !!(document.documentElement.classList.contains("theme-light") || (document.body && document.body.classList.contains("theme-light")));
    const panelAttrs = () => ({ id: "blxstncord-panel", ...(isLight() ? { "data-light": "1" } : {}) });
    const openRows = new Set();   // plugin ids whose "Settings" are expanded
    let searchText = "";
    let animateNext = true;

    function closeBtn() {
        return h("button", { type: "button", class: "fc-close", title: "Close (Esc)", "aria-label": "Close", onclick: () => closePanel() }, svgIcon(ICO.close));
    }
    function btn(label, icon, onclick, secondary) {
        const lbl = h("span", null, label);
        const b = h("button", { type: "button", class: "fc-btn" + (secondary ? " sec" : "") }, svgIcon(icon), lbl);
        b.addEventListener("click", () => onclick(lbl));
        return b;
    }
    function statusEl(rec) {
        const st = rec.status;
        const cls = st === "ok" ? "ok" : st === "off" ? "off" : st === "waiting" ? "wait" : "bad";
        const txt = st === "ok" ? "Running" : st === "off" ? "Off" : st === "waiting" ? "Starting…" : st.startsWith("FAILED") ? "Failed" : "Not found";
        return h("span", { class: "fc-status " + cls, title: cls === "bad" ? st : "" }, h("i"), txt);
    }

    function pluginRow(rec) {
        let opts = [];
        if (typeof rec.def.options === "function") {
            try { opts = rec.def.options(rec.api) || []; }
            catch (e) { opts = [note("Options error: " + (e && e.message || e))]; }
        }
        const isOpen = opts.length > 0 && openRows.has(rec.id);
        const initials = rec.name.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
        const row = h("div", { class: "fc-item" + (isOpen ? " open" : ""), "data-q": (rec.name + " " + rec.description + " " + rec.file).toLowerCase() },
            h("div", { class: "fc-head" },
                h("div", { class: "fc-tile", style: "--h:" + hueOf(rec.id) }, initials),
                h("div", { class: "fc-title" },
                    h("div", { class: "fc-line" },
                        h("span", { class: "fc-name" }, rec.name),
                        rec.version ? h("span", { class: "fc-ver" }, "v" + rec.version) : null,
                        statusEl(rec)),
                    h("div", { class: "fc-desc" }, rec.description)),
                toggle(isEnabled(rec), v => { setEnabled(rec, v); lastSig = sig(); animateNext = false; refreshPanel(); }))
        );
        const foot = h("div", { class: "fc-foot" },
            rec.author ? h("span", null, "by " + rec.author) : null,
            h("code", null, rec.file));
        if (opts.length) {
            const more = h("button", { type: "button", class: "fc-morebtn", "aria-expanded": String(isOpen) }, "Settings", svgIcon(ICO.chevron));
            more.addEventListener("click", () => {
                const o = row.classList.toggle("open");
                more.setAttribute("aria-expanded", String(o));
                if (o) openRows.add(rec.id); else openRows.delete(rec.id);
            });
            foot.append(more);
        }
        row.append(foot);
        if (opts.length) row.append(h("div", { class: "fc-optwrap" }, h("div", { class: "fc-optin" }, h("div", { class: "fc-opts" }, opts))));
        return row;
    }

    function errorRow(file, msg) {
        return h("div", { class: "fc-item fc-err", "data-q": (file + " " + msg).toLowerCase() },
            h("div", { class: "fc-head" },
                h("div", { class: "fc-tile bad" }, "!"),
                h("div", { class: "fc-title" },
                    h("div", { class: "fc-line" }, h("span", { class: "fc-name" }, file), h("span", { class: "fc-status bad" }, h("i"), "Couldn't load")),
                    h("div", { class: "fc-desc" }, msg))));
    }

    function buildPanel() {
        const list = [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
        const errs = Object.entries(loadErrors);
        const running = list.filter(p => p.status === "ok").length;

        const search = h("input", { class: "fc-search", type: "text", placeholder: "Search plugins", spellcheck: "false", "aria-label": "Search plugins" });
        search.value = searchText;
        search.addEventListener("keydown", e => e.stopPropagation());

        const rows = h("div", { class: "fc-list" }, list.map(pluginRow), errs.map(([f, m]) => errorRow(f, m)));
        const empty = h("div", { class: "fc-empty" });
        const applyFilter = () => {
            searchText = search.value;
            const q = searchText.trim().toLowerCase();
            let shown = 0;
            for (const r of rows.querySelectorAll(".fc-item[data-q]")) {
                const hit = !q || r.getAttribute("data-q").includes(q);
                r.style.display = hit ? "" : "none";
                if (hit) shown++;
            }
            empty.textContent = shown ? "" : (list.length + errs.length)
                ? "No plugins match \u201c" + searchText.trim() + "\u201d."
                : "No plugins found. Put .js files in the plugins folder, then press Rescan.";
            empty.style.display = shown ? "none" : "";
            rows.style.display = shown ? "" : "none";
        };
        search.addEventListener("input", applyFilter);

        const el = h("div", panelAttrs(), closeBtn(),
            h("div", { class: "fc-wrap" },
                h("div", { class: "fc-top" },
                    h("h1", null, "Plugins"),
                    h("p", { class: "fc-sub" }, list.length ? list.length + " installed, " + running + " running" : "Nothing installed yet")),
                h("div", { class: "fc-toolbar" },
                    h("div", { class: "fc-searchwrap" }, svgIcon(ICO.search), search),
                    btn("Rescan", ICO.refresh, lbl => { lbl.textContent = "Scanning…"; log("cmd:rescan"); setTimeout(() => { animateNext = false; refreshPanel(); }, 3000); }),
                    btn("Open folder", ICO.folder, () => log("cmd:open-folder"), true)),
                pluginsDir ? h("div", { class: "fc-path", title: "Plugins folder" }, svgIcon(ICO.folder), pluginsDir) : h("div", { style: "height:22px" }),
                rows, empty));
        applyFilter();
        return el;
    }

    const LOGS_CSS = `
    #blxstncord-panel .fc-btn.danger{background:#da373c}
    #blxstncord-panel .bl-cats{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:18px 0 14px;user-select:none}
    #blxstncord-panel .bl-cat-pill{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:10px;font-size:13px;
        font-weight:600;cursor:pointer;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
        color:var(--bc-dim);transition:all .2s cubic-bezier(.16,1,.3,1)}
    #blxstncord-panel .bl-cat-pill svg{width:15px;height:15px;fill:currentColor;flex:none;opacity:.8}
    #blxstncord-panel .bl-cat-pill:hover{background:rgba(255,255,255,.08);color:var(--bc-head);border-color:rgba(245,158,11,.3);transform:translateY(-1px)}
    #blxstncord-panel .bl-cat-pill.active{background:linear-gradient(135deg,rgba(245,158,11,.22),rgba(217,119,6,.12));
        border-color:#f59e0b;color:#fbbf24;box-shadow:0 0 16px rgba(245,158,11,.25)}
    #blxstncord-panel .bl-cat-pill.active svg{opacity:1;filter:drop-shadow(0 0 4px rgba(245,158,11,.5))}
    #blxstncord-panel .bl-cat-count{padding:2px 7px;border-radius:999px;font-size:11px;background:rgba(0,0,0,.35);
        border:1px solid rgba(255,255,255,.1);transition:background .2s,border-color .2s}
    #blxstncord-panel .bl-cat-pill.active .bl-cat-count{background:rgba(245,158,11,.3);border-color:rgba(245,158,11,.5);color:#fff}
    
    #blxstncord-panel .bl-list{display:flex;flex-direction:column;gap:10px;margin-top:12px}
    #blxstncord-panel .bl-item{position:relative;display:flex;gap:14px;padding:14px 56px 14px 18px;border-radius:12px;
        background:rgba(20,20,24,.65);border:1px solid rgba(255,255,255,.07);box-shadow:0 4px 16px rgba(0,0,0,.3);
        animation:bl-card-in .25s cubic-bezier(.16,1,.3,1) both;transition:transform .2s cubic-bezier(.16,1,.3,1),box-shadow .2s,background .2s,border-color .2s;overflow:hidden}
    #blxstncord-panel .bl-item:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 16px var(--glow,rgba(245,158,11,.15));
        background:rgba(28,28,34,.88);border-color:rgba(255,255,255,.14)}
    
    #blxstncord-panel .bl-item.cat-servers{--glow:rgba(245,158,11,.2);box-shadow:inset 3px 0 0 #f59e0b,0 4px 16px rgba(0,0,0,.3)}
    #blxstncord-panel .bl-item.cat-dms{--glow:rgba(6,182,212,.2);box-shadow:inset 3px 0 0 #06b6d4,0 4px 16px rgba(0,0,0,.3)}
    #blxstncord-panel .bl-item.cat-friends{--glow:var(--item-glow,rgba(16,185,129,.2));box-shadow:inset 3px 0 0 var(--item-color,#10b981),0 4px 16px rgba(0,0,0,.3)}
    
    @keyframes bl-card-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
    @keyframes bl-card-out{0%{opacity:1;transform:none;max-height:220px;margin-bottom:0}50%{opacity:0;transform:translateX(35px) scale(.94);max-height:220px;margin-bottom:0}100%{opacity:0;transform:translateX(35px) scale(.9);max-height:0;padding-top:0;padding-bottom:0;border-width:0;margin-bottom:-10px}}
    #blxstncord-panel .bl-item.bl-deleting{animation:bl-card-out .28s cubic-bezier(.4,0,.2,1) forwards!important;pointer-events:none}
    
    #blxstncord-panel .bl-av{width:40px;height:40px;border-radius:50%;flex:none;opacity:.9;background:rgba(255,255,255,.05);object-fit:cover}
    #blxstncord-panel .bl-body{min-width:0;flex:1}
    #blxstncord-panel .bl-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
    #blxstncord-panel .bl-name{font-weight:700;color:var(--bc-head);font-size:14.5px}
    #blxstncord-panel .bl-where{font-size:11.5px;padding:1px 9px;border-radius:999px;background:var(--bc-surface-2);color:var(--bc-dim)}
    #blxstncord-panel .bl-cat-tag{font-size:10px;font-weight:700;letter-spacing:.04em;padding:1px 7px;border-radius:4px;text-transform:uppercase}
    #blxstncord-panel .bl-cat-tag.servers{background:rgba(245,158,11,.18);color:#fbbf24;border:1px solid rgba(245,158,11,.35)}
    #blxstncord-panel .bl-cat-tag.dms{background:rgba(6,182,212,.18);color:#22d3ee;border:1px solid rgba(6,182,212,.35)}
    #blxstncord-panel .bl-cat-tag.friends{background:rgba(16,185,129,.18);color:#34d399;border:1px solid rgba(16,185,129,.35)}
    #blxstncord-panel .bl-tag{font-size:10px;font-weight:700;letter-spacing:.04em;padding:0 7px;border-radius:4px;line-height:17px;color:#fff}
    #blxstncord-panel .bl-note{font-size:11.5px;color:var(--bc-dim);font-style:italic}
    #blxstncord-panel .bl-text{margin-top:6px;white-space:pre-wrap;word-break:break-word;color:var(--bc-text);line-height:1.42;font-size:13.5px}
    #blxstncord-panel .bl-text.none{font-style:italic;opacity:.7}
    #blxstncord-panel .bl-att{margin-top:8px;display:flex;flex-wrap:wrap;gap:8px 12px;font-size:13px}
    #blxstncord-panel .bl-att a{color:#00a8fc;word-break:break-all}
    #blxstncord-panel .bl-att img{max-width:260px;max-height:170px;border-radius:8px;display:block;border:1px solid rgba(255,255,255,.1)}
    #blxstncord-panel .bl-time{margin-top:7px;font-size:11.5px;color:var(--bc-dim)}
    
    #blxstncord-panel .bl-x{position:absolute;top:13px;right:14px;width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;
        cursor:pointer;color:var(--bc-dim);background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);transition:all .15s ease}
    #blxstncord-panel .bl-x svg{width:16px;height:16px;fill:currentColor}
    #blxstncord-panel .bl-x:hover{background:#da373c;border-color:#da373c;color:#fff;transform:scale(1.08);box-shadow:0 0 12px rgba(218,55,60,.4)}
    
    #blxstncord-panel .fc-empty-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center;
        border-radius:14px;background:rgba(255,255,255,.02);border:1px dashed rgba(255,255,255,.08);margin-top:16px}
    #blxstncord-panel .fc-empty-icon{width:44px;height:44px;margin-bottom:12px;color:#f59e0b;opacity:.85}
    #blxstncord-panel .fc-empty-icon svg{width:100%;height:100%;fill:currentColor}
    #blxstncord-panel .fc-empty-title{font-size:15.5px;font-weight:700;color:var(--bc-head);margin-bottom:6px}
    #blxstncord-panel .fc-empty-desc{font-size:13px;color:var(--bc-dim);max-width:440px;line-height:1.45}
    `;

    let logsRefreshTimer = null;
    function scheduleLogsRefresh() {
        if (logsRefreshTimer) return;
        logsRefreshTimer = setTimeout(() => { logsRefreshTimer = null; if (panel && panelView === "logs") refreshPanel(); }, 250);
    }

    let activeLogsCategory = "all";
    try { activeLogsCategory = localStorage.getItem("beecord_logs_cat") || "all"; } catch { }

    function buildLogs() {
        const allItems = [];
        for (const src of logSources.values()) {
            let list = [];
            try { list = src.list() || []; } catch (e) { log("logs source error: " + (e && e.message || e)); }
            for (const e of list) {
                const category = e.category || (e.guild ? "servers" : (e.kind ? "friends" : "dms"));
                allItems.push({ e: Object.assign({}, e, { category }), src });
            }
        }
        allItems.sort((a, b) => (b.e.deleted || b.e.ts || 0) - (a.e.deleted || a.e.ts || 0));
        const LIMIT = 300;

        let totalCount = allItems.length;
        let serversCount = allItems.filter(x => x.e.category === "servers").length;
        let dmsCount = allItems.filter(x => x.e.category === "dms").length;
        let friendsCount = allItems.filter(x => x.e.category === "friends").length;

        const sub = h("p", { class: "fc-sub" }, "");
        const updateSub = () => {
            const curCount = activeLogsCategory === "servers" ? serversCount
                : activeLogsCategory === "dms" ? dmsCount
                : activeLogsCategory === "friends" ? friendsCount : totalCount;
            const catName = activeLogsCategory === "servers" ? "server"
                : activeLogsCategory === "dms" ? "DM"
                : activeLogsCategory === "friends" ? "friend activity" : "total";
            sub.textContent = curCount
                ? `${curCount} ${catName} log${curCount === 1 ? "" : "s"} saved on PC`
                : "No logs recorded yet";
        };

        const search = h("input", { class: "fc-search", type: "text", placeholder: "Search logs", spellcheck: "false", "aria-label": "Search logs" });
        search.addEventListener("keydown", e => e.stopPropagation());

        const rows = h("div", { class: "bl-list" });
        const emptyWrap = h("div", { class: "fc-empty-wrap" });
        const emptyIcon = h("div", { class: "fc-empty-icon" }, svgIcon(ICO.sparkles));
        const emptyTitle = h("div", { class: "fc-empty-title" }, "No logs recorded");
        const emptyDesc = h("div", { class: "fc-empty-desc" }, "");
        emptyWrap.append(emptyIcon, emptyTitle, emptyDesc);

        // Category pills
        const catsWrap = h("div", { class: "bl-cats" });
        const pillEls = {};
        const countEls = {};
        const catDefs = [
            { id: "all", label: "All Logs", icon: ICO.sparkles, getCount: () => totalCount },
            { id: "servers", label: "Servers", icon: ICO.server, getCount: () => serversCount },
            { id: "dms", label: "Direct Messages", icon: ICO.chat, getCount: () => dmsCount },
            { id: "friends", label: "Friend Activity", icon: ICO.friends, getCount: () => friendsCount }
        ];

        function updatePillCounts() {
            for (const def of catDefs) {
                if (countEls[def.id]) countEls[def.id].textContent = String(def.getCount());
            }
        }

        catDefs.forEach(def => {
            const countSpan = h("span", { class: "bl-cat-count" }, String(def.getCount()));
            countEls[def.id] = countSpan;
            const pill = h("div", { class: "bl-cat-pill" + (activeLogsCategory === def.id ? " active" : ""), role: "button" },
                svgIcon(def.icon),
                h("span", null, def.label),
                countSpan
            );
            pill.addEventListener("click", () => {
                if (activeLogsCategory === def.id) return;
                activeLogsCategory = def.id;
                try { localStorage.setItem("beecord_logs_cat", activeLogsCategory); } catch { }
                Object.values(pillEls).forEach(p => p.classList.remove("active"));
                pill.classList.add("active");
                updateClearBtnLabel();
                updateSub();
                render();
            });
            pillEls[def.id] = pill;
            catsWrap.append(pill);
        });

        // Clear button with dynamic label per active category
        let armed = false, timer = null;
        function getClearBtnLabel() {
            if (activeLogsCategory === "servers") return "Clear server logs";
            if (activeLogsCategory === "dms") return "Clear DM logs";
            if (activeLogsCategory === "friends") return "Clear friend activity";
            return "Clear all logs";
        }

        const clearBtn = btn(getClearBtnLabel(), ICO.trash, lbl => {
            if (!armed) {
                armed = true;
                lbl.textContent = "Click again to confirm";
                timer = setTimeout(() => { armed = false; lbl.textContent = getClearBtnLabel(); }, 3500);
                return;
            }
            clearTimeout(timer);
            armed = false;
            for (const src of logSources.values()) {
                try { if (typeof src.clear === "function") src.clear(activeLogsCategory); } catch { }
            }
            try { log("cmd:log-clear:" + activeLogsCategory); } catch { }
            animateNext = false;
            refreshPanel();
        });
        clearBtn.classList.add("danger");

        function updateClearBtnLabel() {
            if (!armed) {
                const span = clearBtn.querySelector("span:last-child");
                if (span) span.textContent = getClearBtnLabel();
            }
        }

        const openFolderBtn = btn("Open folder", ICO.folder, () => {
            try { log("cmd:open-logs-folder"); } catch { }
        }, true);

        const fmt = ms => new Date(ms || Date.now()).toLocaleString();

        function entryRow(item) {
            const { e, src } = item;
            const cat = e.category || "servers";
            const isFriend = cat === "friends";

            const tagColor = e.color || "#da373c";
            const catLabel = cat === "servers" ? "Server" : cat === "dms" ? "DM" : "Friend";

            const head = h("div", { class: "bl-head" },
                h("span", { class: "bl-cat-tag " + cat }, catLabel),
                h("span", { class: "bl-name" }, e.name || "Unknown"),
                e.where ? h("span", { class: "bl-where" }, e.where) : null,
                h("span", { class: "bl-tag", style: "background:" + tagColor }, e.tag || (isFriend ? "FRIEND" : "DELETED"))
            );
            if (e.note) head.append(h("span", { class: "bl-note" }, "(" + e.note + ")"));

            const body = h("div", { class: "bl-body" }, head);

            if (e.content) body.append(h("div", { class: "bl-text" }, e.content));
            else if (!isFriend && !(e.attachments || []).length && !(e.links || []).length) {
                body.append(h("div", { class: "bl-text none" }, e.stickers ? "[sticker]" : "[no text]"));
            }

            const atts = e.attachments || [];
            if (atts.length || (e.links || []).length) {
                const box = h("div", { class: "bl-att" });
                for (const a of atts) {
                    if (/^image\//.test(a.type || "") || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(a.url)) {
                        const img = h("img", { src: a.url, alt: a.name || "image", loading: "lazy" });
                        img.addEventListener("error", () => img.replaceWith(h("span", null, "[image no longer available: " + (a.name || "image") + "]")));
                        box.append(img);
                    } else box.append(h("a", { href: a.url, target: "_blank", rel: "noreferrer noopener" }, a.name || a.url));
                }
                for (const l of e.links || []) box.append(h("a", { href: l, target: "_blank", rel: "noreferrer noopener" }, l));
                body.append(box);
            }

            const timeTxt = isFriend
                ? "Recorded " + fmt(e.ts)
                : "Sent " + fmt(e.ts) + "  \u00b7  deleted " + fmt(e.deleted || e.ts);
            body.append(h("div", { class: "bl-time" }, timeTxt));

            const x = h("div", { class: "bl-x", role: "button", title: "Delete this log permanently from PC", "aria-label": "Delete log" }, svgIcon(ICO.trash));
            const row = h("div", {
                class: `bl-item cat-${cat}`,
                style: isFriend ? `--item-color:${tagColor};--item-glow:color-mix(in srgb, ${tagColor} 25%, transparent)` : "",
                "data-q": ((e.name || "") + " " + (e.where || "") + " " + (e.content || "") + " " + (e.note || "") + " " + (e.tag || "")).toLowerCase()
            }, h("img", { class: "bl-av", src: e.avatar || "", alt: "" }), body, x);

            x.addEventListener("click", ev => {
                ev.stopPropagation();
                row.classList.add("bl-deleting");
                setTimeout(() => {
                    try { src.remove(e.id, cat); } catch { }
                    try { log("cmd:log-remove:" + JSON.stringify({ category: cat, id: e.id })); } catch { }
                    row.remove();
                    totalCount = Math.max(0, totalCount - 1);
                    if (cat === "servers") serversCount = Math.max(0, serversCount - 1);
                    else if (cat === "dms") dmsCount = Math.max(0, dmsCount - 1);
                    else if (cat === "friends") friendsCount = Math.max(0, friendsCount - 1);
                    updatePillCounts();
                    updateSub();
                    checkEmpty();
                }, 260);
            });
            return row;
        }

        const q = () => search.value.trim().toLowerCase();

        function checkEmpty() {
            const hasVisible = rows.children.length > 0;
            emptyWrap.style.display = hasVisible ? "none" : "";
            rows.style.display = hasVisible ? "" : "none";
        }

        function render() {
            rows.replaceChildren();
            const needle = q();
            let shown = 0;

            for (const item of allItems) {
                const e = item.e;
                if (activeLogsCategory !== "all" && e.category !== activeLogsCategory) continue;
                if (needle) {
                    const haystack = ((e.name || "") + " " + (e.where || "") + " " + (e.content || "") + " " + (e.note || "") + " " + (e.tag || "")).toLowerCase();
                    if (!haystack.includes(needle)) continue;
                }
                if (shown >= LIMIT) break;
                rows.append(entryRow(item));
                shown++;
            }

            const none = !shown;
            if (none) {
                if (needle) {
                    emptyTitle.textContent = "No matching logs";
                    emptyDesc.textContent = "No logs match \u201c" + search.value.trim() + "\u201d in this category.";
                } else if (activeLogsCategory === "servers") {
                    emptyTitle.textContent = "No server deleted messages";
                    emptyDesc.textContent = "When a message is deleted in any server channel, it will be automatically recorded here and saved on your PC.";
                } else if (activeLogsCategory === "dms") {
                    emptyTitle.textContent = "No DM deleted messages";
                    emptyDesc.textContent = "When someone deletes a direct message or group DM, it will be automatically recorded here and saved on your PC.";
                } else if (activeLogsCategory === "friends") {
                    emptyTitle.textContent = "No friend activity";
                    emptyDesc.textContent = "When someone sends you a friend request, removes you, blocks you, or withdraws a request, it will be recorded here.";
                } else {
                    emptyTitle.textContent = "No logs recorded yet";
                    emptyDesc.textContent = "All deleted messages from servers, DMs, and friend activity will be automatically saved here and safely stored on your PC.";
                }
            }
            emptyWrap.style.display = none ? "" : "none";
            rows.style.display = none ? "none" : "";
        }

        search.addEventListener("input", render);

        updateSub();
        render();

        return h("div", panelAttrs(), closeBtn(),
            h("div", { class: "fc-wrap" },
                h("div", { class: "fc-top" }, h("h1", null, "Logs"), sub),
                catsWrap,
                h("div", { class: "fc-toolbar" },
                    h("div", { class: "fc-searchwrap" }, svgIcon(ICO.search), search),
                    clearBtn,
                    openFolderBtn
                ),
                rows,
                emptyWrap
            )
        );
    }

    function buildCredits() {
        const list = [...plugins.values()];
        const running = list.filter(p => p.status === "ok").length;

        // Discord pill: click to copy the username
        const dcSub = h("small", null, "Click to copy username");
        const discord = h("button", { type: "button", class: "fc-social dc", title: "Copy Discord username" },
            h("span", { class: "fc-sico" }, svgIcon(ICO_PERSON)),
            h("span", { class: "fc-stxt" }, h("b", null, PROFILE.discord), dcSub),
            svgIcon(ICO.copy));
        discord.addEventListener("click", async () => {
            let ok = false;
            try { await navigator.clipboard.writeText(PROFILE.discord); ok = true; }
            catch {
                try { const t = h("textarea"); t.value = PROFILE.discord; document.body.append(t); t.select(); ok = document.execCommand("copy"); t.remove(); } catch { }
            }
            dcSub.textContent = ok ? "Copied!" : "Couldn't copy";
            setTimeout(() => { dcSub.textContent = "Click to copy username"; }, 1600);
        });

        // Instagram pill: opens the profile
        const instagram = h("a", { class: "fc-social ig", href: PROFILE.instagramUrl, target: "_blank", rel: "noopener noreferrer", title: "Open Instagram" },
            h("span", { class: "fc-sico" }, svgIcon(ICO_INSTAGRAM)),
            h("span", { class: "fc-stxt" }, h("b", null, "Instagram"), h("small", null, "@" + PROFILE.instagram)),
            svgIcon(ICO_NEXT));

        const particles = h("div", { class: "fc-parts" });
        for (let i = 0; i < 10; i++) {
            particles.append(h("i", { style: `--x:${(i * 37 + 8) % 96}%;--s:${3 + (i % 3) * 2}px;--d:${6 + (i % 4) * 1.5}s;--dl:${-(i * 0.9)}s` }));
        }

        const inner = h("div", { class: "fc-cardin" },
            h("div", { class: "fc-avatar", style: "--s:128px" }, h("img", { src: PROFILE.avatar, alt: PROFILE.name, draggable: "false" })),
            h("div", { class: "fc-eyebrow" }, "Made by"),
            h("h1", { class: "fc-pname" }, PROFILE.name),
            h("p", { class: "fc-role" }, "Creator of beecord"),
            h("div", { class: "fc-socials" }, discord, instagram));

        const hero = h("section", { class: "fc-hero" }, particles, inner);
        hero.addEventListener("pointermove", e => {
            const r = hero.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
            hero.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
            hero.style.setProperty("--my", (y * 100).toFixed(1) + "%");
            inner.style.setProperty("--ry", ((x - 0.5) * 8).toFixed(2) + "deg");
            inner.style.setProperty("--rx", ((0.5 - y) * 6).toFixed(2) + "deg");
        });
        hero.addEventListener("pointerleave", () => {
            inner.style.setProperty("--rx", "0deg");
            inner.style.setProperty("--ry", "0deg");
        });

        const fact = (label, ...value) => h("div", { class: "fc-fact" }, h("dt", null, label), h("dd", null, ...value));
        return h("div", panelAttrs(), closeBtn(),
            h("div", { class: "fc-wrap" },
                hero,
                h("section", { class: "fc-project" },
                    h("div", { class: "fc-logo" }, svgIcon(ICON_PLUGINS)),
                    h("div", null, h("b", null, "beecord"), h("span", null, "Plugins for the Discord desktop app."))),
                h("dl", { class: "fc-facts" },
                    fact("Plugins installed", String(list.length)),
                    fact("Plugins running", String(running)),
                    fact("Plugins folder", pluginsDir ? h("span", null, pluginsDir) : null, btn("Open", ICO.folder, () => log("cmd:open-folder"), true))),
                h("p", { class: "fc-fine" }, "beecord is an independent project. It isn't affiliated with or endorsed by Discord.")));
    }

    function positionPanel() {
        if (panel) panel.style.left = panelLeft + "px";
    }

    // our sidebar tabs look selected only while their panel is open
    function markTabs() {
        const sel = [...document.querySelectorAll('[role="tab"][aria-selected="true"], [class*="navScroller"] [role="link"][class*="selected"]')].find(t => !t.hasAttribute("data-blxstncord-tab"));
        for (const [view, el] of Object.entries(ourTabs)) {
            if (!el || !el.isConnected) continue;
            el.className = (panel && view === panelView && sel) ? sel.className : tabOrigClass[view];
        }
    }

    function openPanel(left, view) {
        ensureStyle();
        closePanel(true);
        panelLeft = typeof left === "number" ? left : 0;
        if (view) panelView = view;
        panel = panelView === "credits" ? buildCredits() : panelView === "logs" ? buildLogs() : buildPanel();
        positionPanel();
        if (animateNext) {
            panel.querySelectorAll(".fc-item, .fc-fact, .fc-social, .fc-project, .fc-fine").forEach((el, i) => el.style.setProperty("--i", String(Math.min(i, 14))));
            panel.classList.add("bc-anim");
        }
        animateNext = true;
        document.body.append(panel);
        markTabs();
    }

    function closePanel(keepTab) {
        if (panel) { panel.remove(); panel = null; }
        if (!keepTab) markTabs();
    }

    function refreshPanel() {
        if (!panel) return;
        const left = panelLeft;
        const scroll = panel.scrollTop;
        animateNext = false;
        openPanel(left);
        panel.scrollTop = scroll;
    }

    // ---------- settings sidebar tab ----------
    function commonAncestor(a, b) {
        const seen = new Set();
        for (let n = a; n; n = n.parentElement) seen.add(n);
        for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
        return null;
    }

    function finish(container, tabs, mode) {
        const usable = tabs.filter(t => !/danger/i.test(t.className));
        if (!usable.length) return null;
        const last = usable[usable.length - 1];
        const template = usable.find(t => t.getAttribute("aria-selected") !== "true") || last;
        return { container, tabs, anchor: last, template, mode };
    }

    // Strategy 1: elements with role="tab"
    function findByRole() {
        const tabs = [...document.querySelectorAll('[role="tab"]')].filter(t => !t.hasAttribute("data-blxstncord-tab"));
        if (tabs.length < 8) return null;
        const list = tabs[0].closest('[role="tablist"]');
        const container = list && list.querySelectorAll('[role="tab"]').length >= 8
            ? list : commonAncestor(tabs[0], tabs[tabs.length - 1]);
        return container ? finish(container, tabs, "role=tab") : null;
    }

    // Strategy 2: elements with a data-list-item-id that looks like a settings item
    function findByListItemId() {
        const groups = new Map();
        for (const e of document.querySelectorAll("[data-list-item-id]")) {
            if (e.hasAttribute("data-blxstncord-tab")) continue;
            if (!/sidebar|settings/i.test(e.getAttribute("data-list-item-id") || "")) continue;
            const p = e.parentElement;
            if (!p) continue;
            if (!groups.has(p)) groups.set(p, []);
            groups.get(p).push(e);
        }
        for (const [p, list] of groups) if (list.length >= 8) return finish(p, list, "data-list-item-id");
        return null;
    }

    // Strategy 3: find the "Log Out" entry (always at the bottom of the settings sidebar) and work from there
    let lastC = 0, cacheC = null, diagLogged = false;
    function findByLogout() {
        if (cacheC && cacheC.container.isConnected) return cacheC;
        cacheC = null;
        const now = Date.now();
        if (now - lastC < 1500 || !document.body) return null;
        lastC = now;
        const re = /^(log out|wyloguj się|wyloguj)$/i;
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node, hit = null;
        while ((node = w.nextNode())) {
            const v = node.nodeValue;
            if (v && v.length < 20 && re.test(v.trim())) { hit = node.parentElement; break; }
        }
        if (!hit) return null;
        let item = hit, depth = 0;
        while (item.parentElement && item.parentElement.children.length < 8 && depth++ < 12) item = item.parentElement;
        const container = item.parentElement;
        const kids = container ? [...container.children].filter(c => !c.hasAttribute("data-blxstncord-tab") && c.textContent.trim()) : [];
        if (!container || kids.length < 5) {
            if (!diagLogged) {
                diagLogged = true;
                const chain = [];
                for (let n = hit, i = 0; n && i < 8; n = n.parentElement, i++) {
                    chain.push(n.tagName.toLowerCase() + "[role=" + (n.getAttribute("role") || "") + ",kids=" + n.children.length + ",class=" + String(n.className).slice(0, 40) + "]");
                }
                log("diag: Log Out found but sidebar not recognized: " + chain.join(" < "));
            }
            return null;
        }
        let anchor = item.previousElementSibling;
        while (anchor && !anchor.textContent.trim()) anchor = anchor.previousElementSibling;
        if (!anchor) return null;
        let template = anchor;
        if (template.getAttribute("aria-selected") === "true") {
            template = kids.find(k => k !== item && k.getAttribute("aria-selected") !== "true" && !/danger/i.test(k.className)) || anchor;
        }
        cacheC = { container, tabs: kids, anchor, template, mode: "logout" };
        return cacheC;
    }

    function findSettingsSidebar() {
        return findNavSections() || findByRole() || findByListItemId() || findByLogout();
    }

    // Current Discord layout: nav.navScroller > ul.sublist > li.section > [header, ul.sectionList > li.itemContainer > div[role=link].item]
    function findNavSections() {
        const nav = document.querySelector('[class*="navScroller"]');
        if (!nav || !nav.querySelector('[class*="destructive"]')) return null;
        const sublist = nav.querySelector('ul[class*="sublist"]');
        if (!sublist) return null;
        const sections = [...sublist.children].filter(c => c.tagName === "LI");
        if (sections.length < 3) return null;
        return { container: nav, sublist, sections, mode: "nav-sections" };
    }

    function sidebarEdge() {
        const sb = findSettingsSidebar();
        return sb ? Math.round((sb.container.closest('[class*="sidebar"]') || sb.container).getBoundingClientRect().right) : 0;
    }

    function swapIcon(root, iconPath) {
        const svg = root.querySelector("svg");
        if (!svg) return;
        const ns = "http://www.w3.org/2000/svg";
        const icon = document.createElementNS(ns, "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", svg.getAttribute("width") || "24");
        icon.setAttribute("height", svg.getAttribute("height") || "24");
        if (svg.getAttribute("class")) icon.setAttribute("class", svg.getAttribute("class"));
        const path = document.createElementNS(ns, "path");
        path.setAttribute("fill", "currentColor");
        path.setAttribute("d", iconPath);
        icon.append(path);
        svg.replaceWith(icon);
    }

    // Adds a "Billing"-style section: clone a real section (header + items), fill it with our two items,
    // and put it just above the section that holds "Log Out".
    function placeNavSection(nav) {
        const { sublist, sections } = nav;
        const itemsOf = sec => [...sec.querySelectorAll('li[class*="itemContainer"]')];
        const headerOf = sec => [...sec.children].find(c => c.tagName !== "UL");
        const listOf = sec => [...sec.children].find(c => c.tagName === "UL");
        const textCount = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n = 0; while (w.nextNode()) if (w.currentNode.nodeValue.trim()) n++; return n; };
        const plain = li => { const l = li.querySelector('[role="link"]'); return !!l && !/destructive/i.test(l.className) && textCount(l) === 1; };

        const headed = sections.filter(sec => !sec.hasAttribute("data-blxstncord-sec") && headerOf(sec) && headerOf(sec).textContent.trim() && listOf(sec) && itemsOf(sec).length >= 2);
        const secTpl = headed.find(sec => /^(billing|rozliczenia)$/i.test(headerOf(sec).textContent.trim())) || headed[0];
        if (!secTpl) return false;
        const itemTpl = itemsOf(secTpl).find(plain) || sections.flatMap(itemsOf).find(plain);
        if (!itemTpl) return false;

        document.querySelectorAll("[data-blxstncord-sec]").forEach(e => e.remove());
        const sec = secTpl.cloneNode(true);
        sec.removeAttribute("id");
        sec.setAttribute("data-blxstncord-sec", "section");
        setLabel(headerOf(sec), "beecord");
        const ul = listOf(sec);
        ul.replaceChildren();

        const mk = (view, label, iconPath) => {
            const li = itemTpl.cloneNode(true);
            li.removeAttribute("id");
            const link = li.querySelector('[role="link"]');
            for (const a of ["id", "data-list-item-id", "aria-selected", "aria-controls", "href", "aria-label", "aria-current"]) link.removeAttribute(a);
            link.className = link.className.split(/\s+/).filter(c => c && !/selected|destructive/i.test(c)).join(" ");
            link.setAttribute("data-blxstncord-tab", view);
            swapIcon(link, iconPath);
            setLabel(link, label);
            link.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openPanel(sidebarEdge(), view); });
            ourTabs[view] = link;
            tabOrigClass[view] = link.className;
            return li;
        };
        ul.append(mk("plugins", "Plugins", ICON_PLUGINS), mk("logs", "Logs", ICON_LOGS), mk("credits", "Credits", ICON_CREDITS));

        const logoutSec = sections.find(c => c.querySelector('[class*="destructive"]')) || null;
        sublist.insertBefore(sec, logoutSec);
        return true;
    }

    const ICON_PLUGINS = "M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z";
    const ICON_LOGS = "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z";
    const ICON_CREDITS = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";

    // replace the visible label of a cloned sidebar element
    function setLabel(clone, text) {
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) texts.push(walker.currentNode);
        if (texts.length) texts.forEach((n, i) => { n.nodeValue = i === 0 ? text : ""; });
        else clone.append(text);
    }

    function makeTab(template, view, label, iconPath) {
        const clone = template.cloneNode(true);
        for (const a of ["id", "data-list-item-id", "aria-selected", "aria-controls", "href", "aria-label"]) clone.removeAttribute(a);
        clone.setAttribute("data-blxstncord-tab", view);
        clone.setAttribute("aria-selected", "false");
        // swap the icon for our own
        const svg = clone.querySelector("svg");
        if (svg) {
            const ns = "http://www.w3.org/2000/svg";
            const icon = document.createElementNS(ns, "svg");
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("width", svg.getAttribute("width") || "24");
            icon.setAttribute("height", svg.getAttribute("height") || "24");
            if (svg.getAttribute("class")) icon.setAttribute("class", svg.getAttribute("class"));
            const path = document.createElementNS(ns, "path");
            path.setAttribute("fill", "currentColor");
            path.setAttribute("d", iconPath);
            icon.append(path);
            svg.replaceWith(icon);
        }
        setLabel(clone, label);
        clone.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            const sidebar = findSettingsSidebar();
            const edge = sidebar ? (sidebar.container.closest('[class*="sidebar"]') || sidebar.container).getBoundingClientRect().right : 0;
            openPanel(Math.round(edge), view);
        });
        return clone;
    }

    // section header ("Billing"-style): clone an existing one, else draw a plain one
    function makeHeader(container, text) {
        const cands = [...container.querySelectorAll('[role="heading"], [class*="header"], [class*="Header"]')].filter(e =>
            !e.closest("[data-blxstncord-sec]") && !e.closest('[role="tab"]') && !e.querySelector('[role="tab"]') &&
            e.textContent.trim() && e.textContent.trim().length < 40 && e.children.length <= 3);
        const tpl = cands[0];
        let el;
        if (tpl) { el = tpl.cloneNode(true); el.removeAttribute("id"); setLabel(el, text); }
        else {
            el = h("div", { style: "padding:6px 10px;font-size:12px;font-weight:700;color:var(--channels-default,#949ba4);user-select:none" }, text);
        }
        el.setAttribute("data-blxstncord-sec", "header");
        return el;
    }

    function makeSeparator(container) {
        const tpl = container.querySelector('[role="separator"]');
        const el = tpl ? tpl.cloneNode(true) :
            h("div", { style: "height:1px;margin:8px 10px;background:var(--background-modifier-accent,rgba(128,128,128,.3))" });
        el.removeAttribute("id");
        el.setAttribute("data-blxstncord-sec", "sep");
        return el;
    }

    let tabLogged = false;
    let sidebarEl = null;
    let sidebarDiag = false;
    function ensureTab() {
        if (ourTabs.plugins && ourTabs.plugins.isConnected) return;
        const nav = findNavSections();
        if (nav) {
            sidebarEl = nav.container;
            if (nav.container.querySelector("[data-blxstncord-tab]")) return;
            ensureStyle();
            if (placeNavSection(nav)) { if (!tabLogged) { tabLogged = true; log("settings section added (found via nav-sections)"); } }
            else if (!sidebarDiag) { sidebarDiag = true; log("diag: settings nav found but no section/item template (sections=" + nav.sections.length + ")"); }
            return;
        }
        const found = findByRole() || findByListItemId() || findByLogout();
        if (!found) {
            sidebarEl = null;
            if (panel && panelLeft > 0) closePanel();
            return;
        }
        sidebarEl = found.container;
        if (found.container.querySelector("[data-blxstncord-tab]")) return;
        ensureStyle();
        document.querySelectorAll("[data-blxstncord-sec]").forEach(e => e.remove());
        const parent = found.anchor.parentElement;
        const ref = found.anchor.nextSibling;
        ourTabs.plugins = makeTab(found.template, "plugins", "Plugins", ICON_PLUGINS);
        ourTabs.logs = makeTab(found.template, "logs", "Logs", ICON_LOGS);
        ourTabs.credits = makeTab(found.template, "credits", "Credits", ICON_CREDITS);
        tabOrigClass.plugins = ourTabs.plugins.className;
        tabOrigClass.logs = ourTabs.logs.className;
        tabOrigClass.credits = ourTabs.credits.className;
        for (const el of [makeSeparator(found.container), makeHeader(found.container, "beecord"), ourTabs.plugins, ourTabs.logs, ourTabs.credits]) {
            parent.insertBefore(el, ref);
        }
        if (!tabLogged) { tabLogged = true; log("settings section added (found via " + found.mode + ")"); }
    }

    // ---------- entry points ----------
    function togglePanel() { if (panel) closePanel(); else openPanel(0, "plugins"); }

    function toast(msg) {
        if (!document.body) return;
        const t = h("div", { id: "beecord-toast" }, msg);
        t.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;padding:8px 16px;" +
            "border-radius:8px;background:#23a559;color:#fff;font:600 13px sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none";
        document.body.append(t);
        setTimeout(() => t.remove(), 6000);
    }

    function tick() {
        try { ensureTab(); } catch { }
    }

    let tabTimer = null;
    new MutationObserver(() => {
        if (tabTimer) return;
        tabTimer = setTimeout(() => { tabTimer = null; tick(); }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });

    // clicking another settings entry, pressing Esc, or resizing
    document.addEventListener("click", e => {
        if (!panel) return;
        const t = e.target;
        if (!t || !t.closest || t.closest("#blxstncord-panel") || t.closest("#beecord-panel") || t.closest("[data-blxstncord-tab]")) return;
        if (t.closest('[role="tab"]') || (panelLeft > 0 && sidebarEl && sidebarEl.contains(t))) closePanel();
    }, true);
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && panel) { e.stopPropagation(); e.preventDefault(); closePanel(); }
    }, true);
    window.addEventListener("resize", () => {
        if (!panel || panelLeft === 0) return;
        const sidebar = findSettingsSidebar();
        if (sidebar) panelLeft = Math.round((sidebar.container.closest('[class*="sidebar"]') || sidebar.container).getBoundingClientRect().right);
        positionPanel();
    });

    // ---------- public API ----------
    window.beecord = {
        definePlugin,
        config: () => config,
        plugins: () => [...plugins.values()].map(p => ({ id: p.id, name: p.name, file: p.file, enabled: isEnabled(p), status: p.status })),
        status: () => Object.fromEntries([...plugins.values()].map(p => [p.id, p.status])),
        enable(id, value = true) { const p = plugins.get(id); if (p) { setEnabled(p, value); refreshPanel(); } return !!p; },
        open: () => openPanel(0, "plugins"),
        openLogs: (view = "logs") => openPanel(0, view),
        rescan: () => log("cmd:rescan"),
        // used by loader.js:
        __file: null,
        __pluginError(file, err) {
            const msg = String(err && err.message || err);
            loadErrors[file] = msg;
            log("plugin file " + file + " failed: " + msg);
        },
        __finishScan(files, dir) {
            if (dir) pluginsDir = dir;
            for (const rec of [...plugins.values()]) {
                if (!files.includes(rec.file)) {
                    stopPlugin(rec);
                    plugins.delete(rec.id);
                    log("plugin removed: " + rec.name);
                }
            }
            for (const f of Object.keys(loadErrors)) if (!files.includes(f)) delete loadErrors[f];
            if (!toasted) { toasted = true; toast("beecord loaded: " + plugins.size + " plugins. Discord Settings > beecord"); }
            log("scan finished: " + plugins.size + " plugin(s) detected, " + Object.keys(loadErrors).length + " load error(s)");
            logChanges();
            lastSig = sig();
            refreshPanel();
        }
    };
    window.blxstncord = window.beecord;

    // ---------- wait for Discord, then start plugins that need its modules (retrying until each one works) ----------
    let tries = 0;
    const MAX_TRIES = 720; // 720 x 0.5s = 6 minutes
    const READY_LOADED = 600; // wait until Discord has actually RUN this many modules (not just defined them)

    const timer = setInterval(() => {
        tries++;
        try {
            if (!req) {
                const r = getRequire();
                const loadedNow = r && r.c ? Object.keys(r.c).length : 0;
                if (!r || !r.m || Object.keys(r.m).length < 5000 || (loadedNow < READY_LOADED && tries < 240)) {
                    if (tries >= MAX_TRIES) { clearInterval(timer); log("gave up waiting for Discord's modules"); }
                    return;
                }
                req = r;
                log("webpack ready (" + Object.keys(req.m).length + " modules defined, " + Object.keys(req.c || {}).length + " loaded)");
            }
            for (const rec of plugins.values()) if (isEnabled(rec) && rec.status !== "ok") tryStart(rec);
            logChanges();
            refreshIfChanged();
            const pending = [...plugins.values()].some(r => isEnabled(r) && r.status !== "ok");
            if (!pending || tries >= MAX_TRIES) {
                clearInterval(timer);
                logSummary();
            }
        } catch (e) {
            if (tries >= MAX_TRIES) { clearInterval(timer); log("gave up:", String(e && e.message || e)); }
        }
    }, 500);

    tick();
})();
