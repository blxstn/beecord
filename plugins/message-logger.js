// Message Logger v1.6.0: deleted messages stay visible in the chat (red, marked "DELETED") and are listed in
// Discord Settings > beecord > Logs, until YOU remove them (x on a message / "Clear all logs" button).
// Images, videos and files are downloaded when the message arrives and kept in IndexedDB, so they still
// open after the message is deleted (Discord's CDN links stop working or expire after a delete).
//
// How it works:
//  1. We subscribe to Discord's gateway events (Flux dispatcher). Every incoming MESSAGE_CREATE (and every message
//     that Discord loads when you open a channel) is copied into an in-memory cache, even for DMs you never opened.
//  2. On MESSAGE_DELETE / MESSAGE_DELETE_BULK the cached copy (or Discord's message store) goes into the log.
//     If a DM message was never seen, a placeholder entry is logged so you can see that the delete was detected.
//  3. The log is saved in localStorage, the media files in IndexedDB. Ghost entries for logged messages of the
//     open channel are put back into the chat list at their old position.
// v1.4.0 (fix: "Running" but nothing was ever logged): Discord changed its internals, the dispatcher that used to be found
// was either not found or a wrong object was accepted without verification, and the gateway tap was then never switched on.
// Now EVERY source runs at the same time and the duplicates are ignored:
//   a) Discord's Flux dispatcher(s): all candidates are hooked (not just one) and a watchdog searches again after a few
//      seconds if nothing arrives (modules may not have been loaded yet at startup)
//   b) the gateway tap (JSON.parse watcher), always on
//   c) fallback until the first real message event has been seen from a) or b): Discord's message store, and if that
//      cannot be found either, the chat on screen (React data of the message list, no webpack needed). A message that
//      vanishes from the MIDDLE of what is loaded in a channel is treated as deleted.
// v1.6.0 (fix: deleting the NEWEST message of a chat was never logged, and nothing was logged at all when Discord's dispatcher and
// gateway could not be read): the message-store watcher below is now always on and reacts to the store's own change events.
// The status line in the plugin settings shows which source is delivering events.
const BLX_MSGLOG_KEY = "blxstncord_msglog_v1";
let blxMsgLog = null; // lets the settings tab talk to the running plugin
let blxMsgLogWhy = ""; // why the plugin could not start (shown in its settings)
let blxMsgLogNote = ""; // extra info shown in the settings while it runs

(window.beecord || window.blxstncord).definePlugin({
    id: "message-logger",
    name: "Message Logger",
    description: "Keeps deleted messages and their media visible (red, DELETED) in DMs and servers, and lists them in the Logs tab until you clear them.",
    author: "beecord",
    version: "1.6.0",
    enabledByDefault: true,
    webpack: true,

    start(api) {
        const { h } = api.ui;
        const MAX = 1000;                    // messages kept in the log
        const CACHE_MAX = 4000;              // incoming messages remembered in memory
        const MEDIA_MAX = 25 * 1024 * 1024;  // biggest single file that is saved
        const MEDIA_SMALL = 8 * 1024 * 1024; // limit for files of messages that were only loaded (not new)
        const MEDIA_CAP = 400 * 1024 * 1024; // total media storage, oldest is removed first
        const stats = { msgEvents: 0, actions: 0, creates: 0, loads: 0, deletes: 0, kept: 0, unknown: 0, media: 0, mediaFail: 0, viaStore: 0, watchErr: 0, storeListener: 0 };

        // ---------- find Discord's modules ----------
        const isDisp = (o, strict) => !!o && (typeof o === "object" || typeof o === "function") && typeof o.dispatch === "function" && typeof o.subscribe === "function" && (!strict || typeof o.unsubscribe === "function");
        function probe(c) {
            const t = "BLXSTNCORD_PROBE_" + Math.random().toString(36).slice(2);
            let hit = false;
            const f = () => { hit = true; };
            try {
                c.subscribe(t, f);
                c.dispatch({ type: t });
            } catch { }
            try { c.unsubscribe && c.unsubscribe(t, f); } catch { }
            return hit;
        }
        let diagInfo = "";
        function findDispatcher() {
            const cands = [];
            const add = c => { if (c && (typeof c === "object" || typeof c === "function") && !cands.includes(c)) cands.push(c); };
            const safe = fn => { try { return fn(); } catch (e) { api.log("search error: " + (e && e.message || e)); } };
            add(safe(() => api.webpack.find(o => isDisp(o, true), 1)));
            for (const needle of [["called without an action type"], ["isDispatching"], ["_subscriptions"], ["_actionHandlers"],
                ["_interceptors"], ["_currentDispatchActionType"], ["flushWaitQueue"], ["addInterceptor"], ["Cannot dispatch in the middle"],
                ["subscribe", "unsubscribe", "dispatch", "register"]]) {
                add(safe(() => api.webpack.findBy("flux-" + needle[0], needle, o => isDisp(o, false))));
            }
            for (const c of (safe(() => api.webpack.findAll(o => isDisp(o, false), 20, 3)) || [])) add(c);
            const storeList = safe(() => api.webpack.findAll(o => typeof o.getCurrentUser === "function" || (typeof o.getMessage === "function" && typeof o.getMessages === "function") || typeof o.getChannel === "function", 6, 1)) || [];
            const srcStore = safe(() => api.webpack.findBy("flux-userstore", ["getCurrentUser", "getUser"], o => typeof o.getCurrentUser === "function" && typeof o.getUser === "function"));
            if (srcStore) storeList.push(srcStore);
            for (const st of storeList) {
                for (const k of ["_dispatcher", "dispatcher", "_flux", "__dispatcher"]) { let v; try { v = st[k]; } catch { } if (isDisp(v, false)) add(v); }
            }
            api.log("dispatcher candidates: " + cands.length);
            const describe = c => { try { return Object.keys(c).slice(0, 14).join(",") + " | proto: " + Object.getOwnPropertyNames(Object.getPrototypeOf(c) || {}).slice(0, 14).join(","); } catch { return "?"; } };
            cands.slice(0, 4).forEach((c, i) => api.log("  candidate " + i + ": " + describe(c)));
            const good = cands.filter(c => probe(c)).slice(0, 8);
            const markedAll = cands.filter(c => { try { return c._subscriptions !== undefined || c.isDispatching !== undefined || c._actionHandlers !== undefined; } catch { return false; } }).slice(0, 8);
            const both = good.concat(markedAll.filter(c => !good.includes(c)));
            if (both.length) { api.log("dispatchers: " + good.length + " verified by probe, " + markedAll.length + " with Flux markers, hooking " + both.length); return both; }
            if (cands.length) { api.log("dispatcher: nothing verified, hooking the first " + Math.min(cands.length, 3) + " unverified candidates (the watchdog checks them)"); return cands.slice(0, 3); }
            const sees = safe(() => api.webpack.findAll(o => typeof o.dispatch === "function", 8, 2)) || [];
            api.log("objects with a dispatch() function: " + sees.length);
            sees.slice(0, 6).forEach((c, i) => api.log("  dispatch-object " + i + ": " + describe(c)));
            const subs = safe(() => api.webpack.findAll(o => typeof o.subscribe === "function" && typeof o.unsubscribe === "function", 8, 2)) || [];
            api.log("objects with subscribe()+unsubscribe(): " + subs.length);
            subs.slice(0, 6).forEach((c, i) => api.log("  subscribe-object " + i + ": " + describe(c)));
            diagInfo = "objects with dispatch(): " + sees.length + ", with subscribe()+unsubscribe(): " + subs.length;
            return null;
        }
        let useTap = true;   // the gateway tap is always on now (v1.4.0)
        const dispatchers = findDispatcher() || [];
        const startedAt = Date.now();
        const store = (key, needles, pred) => { let r; try { r = api.webpack.find(pred); } catch { } if (!r) { try { r = api.webpack.findBy(key, needles, pred); } catch { } } return r; };
        const messages = store("msgstore", ["getMessage", "getMessages"], o => typeof o.getMessage === "function" && typeof o.getMessages === "function");
        const users = store("userstore", ["getCurrentUser", "getUser"], o => typeof o.getCurrentUser === "function" && typeof o.getUser === "function");
        const channels = store("channelstore", ["getChannel", "getDMFromUserId"], o => typeof o.getChannel === "function" && typeof o.getDMFromUserId === "function");
        const guilds = store("guildstore", ["getGuild", "getGuilds"], o => typeof o.getGuild === "function" && typeof o.getGuilds === "function");
        if (!dispatchers.length) {
            const counts = [["_interceptors"], ["_currentDispatchActionType"], ["flushWaitQueue"], ["addInterceptor"], ["Cannot dispatch in the middle"], ["isDispatching"], ["_subscriptions"], ["subscribe", "unsubscribe", "dispatch", "register"]].map(n => n.join("+") + "=" + api.webpack.count(n)).join(", ");
            let st = {}; try { st = api.webpack.stats(); } catch { }
            api.log("needle counts: " + counts);
            api.log("Flux dispatcher not found. webpack: " + JSON.stringify(st) + ", modules with the dispatcher marker: " + api.webpack.count(["called without an action type"]));
            useTap = true;
            blxMsgLogNote = "Discord's event dispatcher was not found (modules defined/loaded: " + st.defined + "/" + st.loaded + "; " + diagInfo + "). Using the gateway tap instead.";
            api.log("no dispatcher: switching to the gateway tap");
        }
        blxMsgLogWhy = "";
        api.log("modules: dispatchers=" + dispatchers.length + " messageStore=" + !!messages + " users=" + !!users + " channels=" + !!channels + " guilds=" + !!guilds);

        // ---------- media storage (IndexedDB) ----------
        let dbp = null;
        const idb = () => dbp || (dbp = new Promise((res, rej) => {
            const rq = indexedDB.open("blxstncord_msglog_media", 1);
            rq.onupgradeneeded = () => { rq.result.createObjectStore("media", { keyPath: "key" }); };
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error);
        }));
        const idbReq = (mode, fn) => idb().then(db => new Promise((res, rej) => {
            const tx = db.transaction("media", mode);
            let out;
            try { out = fn(tx.objectStore("media")); } catch (e) { rej(e); return; }
            tx.oncomplete = () => res(out && typeof out === "object" && "result" in out ? out.result : undefined);
            tx.onerror = tx.onabort = () => rej(tx.error);
        }));
        const mediaPut = rec => idbReq("readwrite", s => s.put(rec));
        const mediaGet = key => idbReq("readonly", s => s.get(key));
        const mediaDel = key => idbReq("readwrite", s => s.delete(key)).catch(() => { });
        const mediaKeep = key => mediaGet(key).then(rec => { if (rec && !rec.kept) { rec.kept = true; return mediaPut(rec); } }).catch(() => { });
        let mediaBytes = 0;
        // at start: remove files of messages that were never deleted (their cache is gone), count what is kept
        idb().then(db => new Promise(res => {
            const tx = db.transaction("media", "readwrite");
            let bytes = 0;
            tx.objectStore("media").openCursor().onsuccess = e => {
                const c = e.target.result;
                if (!c) return;
                if (!c.value.kept) c.delete(); else bytes += c.value.size || 0;
                c.continue();
            };
            tx.oncomplete = () => res(bytes);
            tx.onerror = tx.onabort = () => res(bytes);
        })).then(b => { mediaBytes = b; }).catch(e => api.log("media storage unavailable: " + (e && e.message || e)));
        async function trim() {
            try {
                const db = await idb();
                const all = await new Promise(res => {
                    const out = [];
                    const tx = db.transaction("media", "readonly");
                    tx.objectStore("media").openCursor().onsuccess = e => {
                        const c = e.target.result;
                        if (!c) return;
                        out.push({ key: c.value.key, ts: c.value.ts, size: c.value.size || 0, kept: !!c.value.kept });
                        c.continue();
                    };
                    tx.oncomplete = () => res(out);
                    tx.onerror = tx.onabort = () => res(out);
                });
                all.sort((a, b) => (a.kept - b.kept) || (a.ts - b.ts));   // unkept first, oldest first
                let total = all.reduce((s, x) => s + x.size, 0);
                for (const x of all) {
                    if (total <= MEDIA_CAP * 0.8) break;
                    await mediaDel(x.key);
                    total -= x.size;
                }
                mediaBytes = total;
            } catch { }
        }

        const objUrls = new Map();   // media key -> blob: URL
        function loadObjUrl(a) {
            if (!a || !a.key) return Promise.resolve(null);
            const have = objUrls.get(a.key);
            if (have) return Promise.resolve(have);
            return mediaGet(a.key).then(rec => {
                if (!rec || !rec.blob) return null;
                const u = URL.createObjectURL(rec.blob);
                objUrls.set(a.key, u);
                return u;
            }).catch(() => null);
        }

        // ---------- log storage ----------
        const BLX_CHAT_DISMISSED_KEY = "blxstncord_chat_dismissed_v1";
        const storage = typeof window !== "undefined" && window.localStorage ? window.localStorage : (typeof localStorage !== "undefined" ? localStorage : null);
        const getStored = k => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
        const setStored = (k, v) => { try { if (storage) storage.setItem(k, v); } catch { } };
        let log = [];
        try { const v = JSON.parse(getStored(BLX_MSGLOG_KEY) || "[]"); if (Array.isArray(v)) log = v.filter(r => r && r.id && r.ch); } catch { }
        // Merge from disk logs if available
        if (typeof window !== "undefined" && window.__beecordDiskLogs) {
            const diskItems = [
                ...(Array.isArray(window.__beecordDiskLogs.servers) ? window.__beecordDiskLogs.servers : []),
                ...(Array.isArray(window.__beecordDiskLogs.dms) ? window.__beecordDiskLogs.dms : [])
            ];
            const hasId = new Set(log.map(r => r.id));
            for (const d of diskItems) {
                if (d && d.id && !hasId.has(d.id)) {
                    log.push(d);
                    hasId.add(d.id);
                }
            }
        }
        for (const r of log) { r.attachments = r.attachments || []; r.links = r.links || []; }
        const save = () => { try { setStored(BLX_MSGLOG_KEY, JSON.stringify(log)); } catch (e) { api.log("cannot save log: " + e.message); } };
        const logged = new Set(log.map(r => r.id));

        const dismissedInChat = new Set();
        try {
            const dis = JSON.parse(getStored(BLX_CHAT_DISMISSED_KEY) || "[]");
            if (Array.isArray(dis)) dis.forEach(id => dismissedInChat.add(String(id)));
        } catch { }
        const saveDismissed = () => { try { setStored(BLX_CHAT_DISMISSED_KEY, JSON.stringify([...dismissedInChat].slice(-2500))); } catch { } };

        const syncToDisk = r => {
            try {
                const cat = r.guild ? "servers" : "dms";
                console.log("[beecord] cmd:log-entry:" + JSON.stringify({
                    category: cat,
                    id: r.id,
                    ch: r.ch,
                    guild: r.guild,
                    author: r.author,
                    name: r.name,
                    avatar: r.avatar,
                    bot: r.bot,
                    content: r.content,
                    attachments: (r.attachments || []).map(a => ({ name: a.name, type: a.type, size: a.size, url: a.url })),
                    links: r.links || [],
                    stickers: r.stickers || 0,
                    ts: r.ts,
                    deleted: r.deleted || r.ts,
                    where: r.where
                }));
            } catch { }
        };
        // Initial sync of existing logs to disk
        setTimeout(() => { for (const r of log) syncToDisk(r); }, 600);

        const changed = () => { try { api.logs && api.logs.refresh(); } catch { } };
        for (const r of log) for (const a of r.attachments) if (a.key) loadObjUrl(a).then(u => { if (u) changed(); });

        const cmp = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);   // snowflakes as strings
        const snowflakeTime = id => { try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return Date.now(); } };
        const avatarUrl = r => r.avatar
            ? "https://cdn.discordapp.com/avatars/" + r.author + "/" + r.avatar + ".webp?size=80"
            : "https://cdn.discordapp.com/embed/avatars/" + (function () { try { return Number((BigInt(r.author) >> 22n) % 6n); } catch { return 0; } })() + ".png";
        const me = () => { try { return users && users.getCurrentUser(); } catch { return null; } };

        // ---------- media download queue ----------
        const queue = [];
        const inflight = new Set();
        let active = 0;
        function pump() {
            while (active < 3 && queue.length) {
                const job = queue.shift();
                active++;
                job().catch(() => { }).then(() => { active--; pump(); });
            }
        }
        async function saveOne(r, a, i) {
            const key = r.id + ":" + i;
            if (a.key || inflight.has(key) || !a.url) return;
            inflight.add(key);
            try {
                const resp = await fetch(a.url);
                if (!resp.ok) { stats.mediaFail++; return; }
                const blob = await resp.blob();
                if (blob.size > MEDIA_MAX) return;
                const kept = logged.has(r.id);
                await mediaPut({ key, msg: r.id, blob, size: blob.size, ts: Date.now(), kept });
                a.key = key;
                mediaBytes += blob.size;
                stats.media++;
                if (kept) { save(); loadObjUrl(a).then(u => { if (u) { changed(); schedule(50); } }); }
                if (mediaBytes > MEDIA_CAP) trim();
            } catch (e) {
                stats.mediaFail++;
                if (stats.mediaFail <= 3) api.log("media download failed: " + (e && e.message || e));
            } finally { inflight.delete(key); }
        }
        function saveMedia(r, urgent, small) {
            if (!api.settings.get("saveMedia", true)) return;
            r.attachments.forEach((a, i) => {
                if (a.key) return;
                if (a.size && a.size > (small ? MEDIA_SMALL : MEDIA_MAX)) return;
                const job = () => saveOne(r, a, i);
                if (urgent) queue.unshift(job); else { queue.push(job); if (queue.length > 300) queue.shift(); }
            });
            pump();
        }
        function dropMedia(r) {
            if (!r || logged.has(r.id)) return;
            for (const a of r.attachments || []) if (a.key) mediaDel(a.key);
        }

        // ---------- cache of incoming messages ----------
        const cache = new Map();
        const chSeen = new Map();   // channels we have seen messages in (checked by the store watcher)
        const touchCh = ch => { if (!ch) return; ch = String(ch); chSeen.delete(ch); chSeen.set(ch, Date.now()); if (chSeen.size > 250) chSeen.delete(chSeen.keys().next().value); };
        function trimCache() {
            while (cache.size > CACHE_MAX) {
                const k = cache.keys().next().value;
                const old = cache.get(k);
                cache.delete(k);
                dropMedia(old);
            }
        }
        function toRecord(m, guildId, chId) {
            if (!m || !m.id) return null;
            const a = m.author || {};
            const attachments = (m.attachments || []).map(x => ({
                url: x.url || x.proxy_url, name: x.filename || "file", type: x.content_type || x.contentType || "", size: x.size || 0
            })).filter(x => x.url);
            const links = (m.embeds || []).map(e => e && e.url).filter(Boolean).slice(0, 5);
            const stickers = (m.sticker_items || m.stickerItems || []).length;
            const content = String(m.content || "");
            if (!content && !attachments.length && !links.length && !stickers) return null;
            return {
                id: String(m.id), ch: String(m.channel_id || m.channelId || chId || ""), guild: guildId || m.guild_id || m.guildId || "",
                author: a.id || "0", name: a.globalName || a.global_name || a.username || "Unknown", avatar: a.avatar || "",
                bot: !!a.bot, content, attachments, links, stickers, ts: snowflakeTime(m.id)
            };
        }
        const onCreate = action => {
            try {
                if (!action || action.optimistic || !action.message) return;
                const r = toRecord(action.message, action.guildId, action.channelId);
                if (!r || !r.ch) return;
                if (cache.has(r.id) || logged.has(r.id)) return;   // the same event arrives through several sources
                stats.creates++;
                cache.set(r.id, r);
                touchCh(r.ch);
                trimCache();
                saveMedia(r, false, false);
            } catch (e) { api.log("cache error: " + (e && e.message || e)); }
        };
        // messages Discord loads when a channel is opened are remembered too
        const onLoad = action => {
            try {
                const list = action && action.messages;
                if (!Array.isArray(list)) return;
                const chId = String(action.channelId || "");
                touchCh(chId);
                let gid = "";
                try { const c = channels && channels.getChannel(chId); gid = (c && (c.guild_id || c.guildId)) || ""; } catch { }
                stats.loads++;
                let n = 0;
                for (const m of list) {
                    if (!m || !m.id) continue;
                    const id = String(m.id);
                    if (cache.has(id) || logged.has(id)) continue;
                    const r = toRecord(m, gid, chId);
                    if (!r) continue;
                    cache.set(id, r);
                    if (n++ < 25 && r.attachments.length) saveMedia(r, false, true);
                }
                trimCache();
            } catch (e) { api.log("load cache error: " + (e && e.message || e)); }
        };
        const onUpdate = action => {
            try {
                const m = action && action.message;
                const r = m && cache.get(String(m.id));
                if (!r) return;
                if (typeof m.content === "string") r.content = m.content;
            } catch { }
        };

        // ---------- where did it happen (label for the Logs tab) ----------
        function whereOf(r) {
            try {
                const ch = channels && channels.getChannel(r.ch);
                if (!r.guild) {
                    let names = (ch && ch.rawRecipients || []).map(u => u.global_name || u.username).filter(Boolean);
                    if (!names.length && ch && Array.isArray(ch.recipients) && users) names = ch.recipients.map(id => { const u = users.getUser(id); return u && (u.globalName || u.username); }).filter(Boolean);
                    if (ch && ch.name && !names.length) names = [ch.name];
                    if (!names.length) names = [r.mine ? "me" : r.name];
                    return "DM \u00b7 " + names.join(", ");
                }
                const g = guilds && guilds.getGuild(r.guild);
                return (ch && ch.name ? "#" + ch.name : "channel") + (g && g.name ? " \u00b7 " + g.name : "");
            } catch { return r.guild ? "server" : "DM"; }
        }

        // ---------- capture on delete ----------
        let why = "", whyLogged = 0;
        function keep(id, ch, guildId) {
            id = String(id);
            why = "";
            if (logged.has(id)) { why = "dup"; return false; }
            let r = cache.get(id);
            if (!r && messages) {   // fallback: Discord still had it loaded
                try { r = toRecord(messages.getMessage(ch, id), guildId, ch); } catch { }
            }
            if (!r) {
                // never seen: in DMs still log that a delete happened, so you can tell the plugin is hooked
                let chObj = null; try { chObj = channels && channels.getChannel(ch); } catch { }
                const isDM = !!ch && !guildId && !(chObj && (chObj.guild_id || chObj.guildId));
                if (isDM && api.settings.get("logUnknown", true) && api.settings.get("logDMs", true)) {
                    r = {
                        id, ch: String(ch), guild: "", author: "0", name: "Unknown", avatar: "", bot: false,
                        content: "[A message was deleted here, but it was not seen before it was deleted, so its content could not be saved.]",
                        attachments: [], links: [], stickers: 0, ts: snowflakeTime(id), unknown: true
                    };
                    stats.unknown++;
                } else { why = "not in cache and not in Discord's store (message was never seen by the plugin)"; return false; }
            }
            if (!r.guild && guildId) r.guild = guildId;
            const mm = me();
            r.mine = !!(mm && r.author === mm.id);
            if (r.mine && api.settings.get("ignoreSelf", false)) { why = "own message (ignored by setting)"; return false; }
            if (!r.guild && !api.settings.get("logDMs", true)) { why = "DM logging is off"; return false; }
            if (r.guild && !api.settings.get("logServers", true)) { why = "server logging is off"; return false; }
            r.where = whereOf(r);
            r.deleted = Date.now();
            log.push(r);
            logged.add(id);
            cache.delete(id);
            for (const a of r.attachments) if (a.key) { mediaKeep(a.key); loadObjUrl(a); }
            saveMedia(r, true, false);   // anything not saved yet: try right now, before the link dies
            syncToDisk(r);
            stats.kept++;
            return true;
        }
        function onDelete(action) {
            try {
                if (!action) return;
                const ids = action.type === "MESSAGE_DELETE_BULK" ? (action.ids || []) : [action.id];
                let n = 0;
                for (const id of ids) {
                    if (!id) continue;
                    stats.deletes++;
                    if (keep(id, action.channelId, action.guildId)) n++;
                    else if (why && why !== "dup" && whyLogged++ < 15) api.log("delete event for " + id + " not kept: " + why);
                }
                if (n) {
                    if (log.length > MAX) {
                        for (const r of log.slice(0, log.length - MAX)) { logged.delete(r.id); for (const a of r.attachments) if (a.key) mediaDel(a.key); }
                        log = log.slice(log.length - MAX);
                    }
                    save();
                    api.log("logged " + n + " deleted message(s), total " + log.length);
                    changed();
                    schedule(80);
                    schedule(400);
                }
            } catch (e) { api.log("capture error: " + (e && e.message || e)); }
        }

        const hits = [];
        const attached = [];
        const DEL = t => t === "MESSAGE_DELETE" || t === "MESSAGE_DELETE_BULK";
        function attach(list) {
            for (const d of list) {
                if (!d || attached.includes(d)) continue;
                const i = attached.push(d) - 1;
                hits[i] = 0;
                const count = () => { hits[i]++; };
                const seen = () => { stats.msgEvents++; };
                const pairs = [["MESSAGE_CREATE", count], ["MESSAGE_CREATE", seen], ["MESSAGE_UPDATE", seen], ["MESSAGE_DELETE", seen], ["MESSAGE_DELETE_BULK", seen], ["LOAD_MESSAGES_SUCCESS", seen], ["MESSAGE_CREATE", onCreate], ["LOAD_MESSAGES_SUCCESS", onLoad], ["MESSAGE_UPDATE", onUpdate], ["MESSAGE_DELETE", onDelete], ["MESSAGE_DELETE_BULK", onDelete]];
                for (const [t, f] of pairs) { try { d.subscribe(t, f); } catch (e) { api.log("subscribe failed: " + (e && e.message || e)); } }
                api.cleanup(() => { for (const [t, f] of pairs) { try { d.unsubscribe(t, f); } catch { } } });
                // second, independent path: look at every action right before Discord handles it
                try {
                    api.patch(d, "dispatch", orig => function (action, ...rest) {
                        stats.actions++;
                        try {
                            const t = action && action.type;
                            if (t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE" || t === "LOAD_MESSAGES_SUCCESS" || DEL(t)) stats.msgEvents++;
                            if (t === "MESSAGE_CREATE") onCreate(action);
                            else if (t === "LOAD_MESSAGES_SUCCESS") onLoad(action);
                            else if (t === "MESSAGE_UPDATE") onUpdate(action);
                            else if (DEL(t)) onDelete(action);
                        } catch { }
                        return orig.call(this, action, ...rest);
                    });
                } catch (e) { api.log("cannot patch dispatch #" + i + ": " + (e && e.message || e)); }
            }
        }
        attach(dispatchers);

        // watchdog: if neither a dispatcher nor the gateway tap has delivered anything yet, search again (more of Discord's
        // modules are loaded a few seconds after startup). Each search is heavy, so only a few of them.
        const gatewayAlive = () => stats.msgEvents > 0;   // only real message events count (another busy dispatcher proves nothing)
        const watchdog = [8000, 30000, 90000].map(ms => setTimeout(() => {
            if (gatewayAlive()) return;
            try {
                const more = (findDispatcher() || []).filter(d => !attached.includes(d));
                api.log("watchdog: nothing received yet, found " + more.length + " new dispatcher candidate(s)");
                attach(more);
            } catch (e) { api.log("watchdog error: " + (e && e.message || e)); }
        }, ms));
        api.cleanup(() => watchdog.forEach(clearTimeout));

        // ---------- gateway tap (used when the dispatcher cannot be found) ----------
        let tapSeen = 0;

        const report = () => api.log("self-check: hooked dispatchers=" + attached.length + ", actions seen=" + stats.actions +
            ", MESSAGE_CREATE per dispatcher=[" + hits.join(", ") + "], gateway tap packets=" + tapSeen + ", real message events=" + stats.msgEvents +
            ", store watcher " + (stats.storeListener ? "listening" : "polling") + ", deletes found by it=" + stats.viaStore + ", " + cache.size + " cached, stats " + JSON.stringify(stats) +
            (gatewayAlive() ? "" : " | no live message event from Discord (normal on current builds): the message-store watcher is doing the work"));
        const t0 = setTimeout(report, 6000), t1 = setTimeout(report, 20000), t2 = setTimeout(report, 90000);
        api.cleanup(() => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2); });

        function tapHandle(r) {
            const t = r.t, d = r.d;
            if (!d || typeof d !== "object") return;
            tapSeen++;
            if (t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE" || t === "MESSAGE_DELETE" || t === "MESSAGE_DELETE_BULK") stats.msgEvents++;
            if (t === "MESSAGE_CREATE") onCreate({ message: d, guildId: d.guild_id, channelId: d.channel_id });
            else if (t === "MESSAGE_UPDATE") onUpdate({ message: d });
            else if (t === "MESSAGE_DELETE") onDelete({ type: "MESSAGE_DELETE", id: d.id, channelId: d.channel_id, guildId: d.guild_id });
            else if (t === "MESSAGE_DELETE_BULK") onDelete({ type: "MESSAGE_DELETE_BULK", ids: d.ids, channelId: d.channel_id, guildId: d.guild_id });
        }
        {
            api.patch(JSON, "parse", orig => function (...a) {
                const r = orig.apply(this, a);
                try { if (r && typeof r === "object" && r.op === 0 && typeof r.t === "string") tapHandle(r); } catch { }
                return r;
            });
        }

        // ---------- store watcher (v1.6.0): the source that does not depend on Discord's dispatcher or gateway ----------
        // On current Discord builds the gateway is not JSON (the tap sees nothing) and the Flux dispatcher is often not found,
        // so this watcher is now ALWAYS on. It listens to Discord's message store and compares every channel it knows with its
        // previous state. A message that disappears is a delete when:
        //   - it was in the MIDDLE of what is loaded, or
        //   - it was the NEWEST one and the store says nothing newer exists (hasMoreAfter === false), or
        //   - it was the OLDEST one and the store says nothing older exists (hasMoreBefore === false).
        // Scrolling far away only trims the ends AND sets hasMoreBefore/hasMoreAfter to true, so it is not mistaken for a delete.
        // (v1.5.0 ignored the newest/oldest message, which is exactly what you delete when you test it.)
        // If the same event also arrives through the dispatcher, the duplicate is ignored.
        const diffOn = () => stats.msgEvents === 0;   // status line only: no live events from Discord, this watcher does all the work
        const openCh = () => { const m = /\/channels\/[^/]+\/(\d+)/.exec(location.pathname); return m ? m[1] : ""; };
        const gidOf = ch => {
            try { const c = channels && channels.getChannel(ch); const g = c && (c.guild_id || c.guildId); if (g) return g; } catch { }
            const m = /\/channels\/([^/]+)\/(\d+)/.exec(location.pathname);   // no channel store on this build: the address bar knows
            return m && m[2] === String(ch) && /^\d+$/.test(m[1]) ? m[1] : "";
        };
        const fresh = id => Date.now() - snowflakeTime(id) < 120000;
        const sentOnly = x => !!x && !!x.id && (!x.state || x.state === "SENT") && String(x.id) !== String(x.nonce || "");

        function fiberOf(el) { for (const k of Object.keys(el)) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k]; return null; }
        function fiberMessage(el, id) {   // the message object Discord's own React component was given
            let f = fiberOf(el);
            for (let i = 0; f && i < 40; i++, f = f.return) {
                const p = f.memoizedProps;
                const m = p && typeof p === "object" ? p.message : null;
                if (m && typeof m === "object" && String(m.id) === id) return m;
            }
            return null;
        }
        function domRaw(el, ch, id) {   // no React data: read what is on screen
            const txt = el.querySelector('[id^="message-content-"]');
            const nm = el.querySelector('[class*="username"]');
            const atts = [...el.querySelectorAll('[id^="message-accessories-"] img[src], [id^="message-accessories-"] video[src]')]
                .map(n => ({ url: n.currentSrc || n.src, filename: "file", content_type: n.tagName === "IMG" ? "image/*" : "video/*" }));
            return { id, channel_id: ch, content: txt ? (txt.innerText || "") : "", author: { id: "0", username: nm ? nm.textContent : "Unknown" }, attachments: atts, embeds: [] };
        }
        // mode: 0 = remember only, 1 = brand new message (download media now), 2 = loaded from history (small files only)
        function ingest(raw, gid, ch, mode) {
            const r = toRecord(raw, gid, ch);
            if (!r) return;
            cache.set(r.id, r);
            touchCh(r.ch);
            if (mode && r.attachments.length) saveMedia(r, false, mode === 2);
        }

        // ----- a) Discord's message store -----
        const chState = new Map();   // channel -> { cm, len, ids:Set, ready }
        function checkChannel(ch) {
            let cm;
            try { cm = messages.getMessages(ch); } catch { return; }
            if (!cm) return;
            const raw = Array.isArray(cm._array) ? cm._array : null;
            const prev = chState.get(ch);
            if (prev && raw && prev.cm === cm && prev.len === raw.length) return;   // nothing changed in this channel
            let list;
            try { list = typeof cm.toArray === "function" ? cm.toArray() : (raw || []); } catch { return; }
            const arr = list.filter(sentOnly);
            const ready = cm.ready !== false && !cm.loadingMore;
            const gid = gidOf(ch);
            const ids = new Set();
            let overlap = 0;
            arr.forEach((x, i) => {
                const id = String(x.id);
                ids.add(id);
                if (prev && prev.ids.has(id)) overlap++;
                if (cache.has(id) || logged.has(id)) return;
                ingest(x, gid, ch, fresh(id) ? 1 : (i >= arr.length - 25 ? 2 : 0));
            });
            if (arr.length) touchCh(ch);
            if (prev && prev.ready && ready && prev.ids.size) {
                let lo = "", hi = "";
                if (arr.length) { const s = [...ids].sort(cmp); lo = s[0]; hi = s[s.length - 1]; }
                const gone = [];
                for (const id of prev.ids) {
                    if (ids.has(id) || logged.has(id)) continue;
                    if (!arr.length) { if (cm.hasMoreBefore === false && cm.hasMoreAfter === false) gone.push(id); continue; }
                    const inside = cmp(id, lo) > 0 && cmp(id, hi) < 0;
                    const newer = cmp(id, hi) > 0 && cm.hasMoreAfter === false;
                    const older = cmp(id, lo) < 0 && cm.hasMoreBefore === false;
                    if (inside || newer || older) gone.push(id);
                }
                // a completely different set of messages (jump to another place, reload) is not a delete
                if (gone.length && gone.length <= (arr.length ? 100 : 5) && (!arr.length || overlap > 0)) {
                    for (const id of gone) { stats.viaStore++; onDelete({ type: "MESSAGE_DELETE", id, channelId: ch, guildId: gid }); }
                }
            }
            chState.set(ch, { cm, len: raw ? raw.length : -1, ids, ready });
            if (chState.size > 300) chState.delete(chState.keys().next().value);
        }
        function checkAll() {
            const set = new Set(chSeen.keys());
            const oc = openCh();
            if (oc) set.add(oc);
            try {   // every channel Discord's store holds (if its internal map is reachable)
                const cmap = messages._channelMessages;
                if (cmap && typeof cmap === "object") for (const k of Object.keys(cmap)) if (/^\d{15,}$/.test(k) && set.size < 300) set.add(k);
            } catch { }
            for (const ch of set) { try { checkChannel(ch); } catch (e) { if (stats.watchErr++ < 3) api.log("store watch error: " + (e && e.message || e)); } }
        }
        function storeHasOpen() {
            const oc = openCh();
            if (!messages || !oc) return false;
            try { const cm = messages.getMessages(oc); const a = cm && (typeof cm.toArray === "function" ? cm.toArray() : cm._array); return Array.isArray(a) && a.length > 0; } catch { return false; }
        }

        // ----- b) the chat on screen (only when the store has nothing for the open channel) -----
        function atBottom() {
            const ol = document.querySelector('[data-list-id="chat-messages"]');
            let sc = ol && ol.parentElement;
            for (let i = 0; sc && i < 6; i++, sc = sc.parentElement) {
                if (sc.scrollHeight > sc.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(sc).overflowY)) return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 400;
            }
            return false;
        }
        function readOpenDom() {   // -> Map(channel -> { ids: Set of message ids currently on screen, gid })
            const out = new Map();
            for (const ol of document.querySelectorAll('[data-list-id="chat-messages"]')) {
                for (const li of ol.children) {
                    const mm = NATIVE.exec(li.id || "") || NATIVE.exec(li.getAttribute("data-list-item-id") || "");
                    if (!mm) continue;
                    const ch = mm[1], id = mm[2];
                    let e = out.get(ch); if (!e) out.set(ch, e = { ids: new Set(), gid: gidOf(ch) });
                    if (cache.has(id) || logged.has(id)) { e.ids.add(id); continue; }
                    const raw = fiberMessage(li, id);
                    if (raw && ((raw.state && raw.state !== "SENT") || String(raw.nonce || "") === id)) continue;   // still being sent
                    e.ids.add(id);
                    ingest(raw || domRaw(li, ch, id), e.gid, ch, 2);
                }
            }
            return out;
        }
        let snaps = new Map();   // channel -> Map(message id -> when it was first seen)
        function domTick() {
            const now = Date.now();
            const cur = readOpenDom();
            const bottom = atBottom();
            for (const [ch, e] of cur) {
                const prev = snaps.get(ch);
                if (!prev || !e.ids.size) continue;
                const sorted = [...e.ids].sort(cmp), lo = sorted[0], hi = sorted[sorted.length - 1];
                const gone = [...prev].filter(([id, t]) => !e.ids.has(id) && !logged.has(id) && now - t >= 700 &&
                    ((cmp(id, lo) > 0 && cmp(id, hi) < 0) || (cmp(id, hi) > 0 && bottom))).map(x => x[0]);   // newest one only counts while you are at the bottom
                if (gone.length && gone.length <= 5) for (const id of gone) { stats.viaStore++; onDelete({ type: "MESSAGE_DELETE", id, channelId: ch, guildId: e.gid }); }
            }
            const next = new Map();
            for (const [ch, e] of cur) {
                const prev = snaps.get(ch), mp = new Map();
                for (const id of e.ids) mp.set(id, (prev && prev.get(id)) || now);
                next.set(ch, mp);
            }
            snaps = next;
        }

        function watchTick() {
            trimCache();
            const oc = openCh();
            if (oc) touchCh(oc);
            if (messages) checkAll();
            if (messages && storeHasOpen()) snaps = new Map(); else domTick();
        }
        let wtimer = 0;
        const scheduleWatch = ms => {
            if (wtimer) return;
            wtimer = setTimeout(() => { wtimer = 0; try { watchTick(); } catch (e) { api.log("watch error: " + (e && e.message || e)); } }, ms || 250);
        };
        const kick = () => scheduleWatch(40);
        if (messages) {
            try {
                messages.addChangeListener(kick);
                api.cleanup(() => { try { messages.removeChangeListener(kick); } catch { } });
                stats.storeListener = 1;
            } catch (e) { api.log("message store change listener failed: " + (e && e.message || e)); }
        }
        const swTimer = setInterval(() => { try { watchTick(); } catch (e) { api.log("watch error: " + (e && e.message || e)); } }, 1000);
        api.cleanup(() => { clearInterval(swTimer); clearTimeout(wtimer); });
        setTimeout(() => { try { watchTick(); } catch { } }, 300);

        // ---------- ghost entries in the chat ----------
        api.addStyle(`
        li.blx-del{position:relative;display:flex;gap:16px;list-style:none;margin:17px 0 0;padding:4px 48px 4px 16px;
            background:color-mix(in srgb,#da373c 9%,transparent);box-shadow:inset 2px 0 0 #da373c;user-select:text}
        li.blx-del:hover{background:color-mix(in srgb,#da373c 14%,transparent)}
        li.blx-del img.blx-av{width:40px;height:40px;border-radius:50%;flex:none;margin-top:2px;opacity:.75}
        li.blx-del .blx-body{min-width:0;flex:1}
        li.blx-del .blx-head{display:flex;align-items:center;gap:8px;line-height:1.375rem}
        li.blx-del .blx-name{font-weight:500;font-size:1rem;color:var(--header-primary,#f2f3f5)}
        li.blx-del .blx-time{font-size:.75rem;color:var(--text-muted,#949ba4)}
        li.blx-del .blx-tag{font-size:10px;font-weight:700;letter-spacing:.04em;padding:0 5px;border-radius:4px;line-height:15px;color:#fff;background:#da373c}
        li.blx-del .blx-bot{font-size:10px;font-weight:700;padding:0 5px;border-radius:4px;line-height:15px;color:#fff;background:#5865f2}
        li.blx-del .blx-text{white-space:pre-wrap;word-break:break-word;font-size:1rem;line-height:1.375rem;
            color:color-mix(in srgb,var(--text-default,var(--text-normal,#dbdee1)) 72%,#da373c)}
        li.blx-del .blx-text.none{font-style:italic;opacity:.7}
        li.blx-del .blx-att{margin-top:4px;display:flex;flex-wrap:wrap;gap:6px}
        li.blx-del .blx-att img,li.blx-del .blx-att video{max-width:300px;max-height:240px;border-radius:6px;opacity:.9}
        li.blx-del .blx-att audio{max-width:300px}
        li.blx-del .blx-att a,li.blx-del .blx-link{font-size:.875rem;color:var(--text-link,#00a8fc)}
        li.blx-del .blx-x{position:absolute;top:2px;right:12px;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;
            cursor:pointer;font-size:16px;line-height:1;color:var(--interactive-normal,#b5bac1);background:var(--background-surface-high,rgba(0,0,0,.35));opacity:0;transition:opacity .15s,color .15s}
        li.blx-del:hover .blx-x{opacity:1}
        li.blx-del .blx-x:hover{color:#fff;background:#da373c}
        @media (prefers-reduced-motion:no-preference){li.blx-del{animation:blx-in .25s ease-out}}
        @keyframes blx-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
        `);

        function mediaEl(a) {
            const url = a.url || "";
            const isImg = /^image\//.test(a.type || "") || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url);
            const isVid = /^video\//.test(a.type || "") || /\.(mp4|webm|mov)(\?|$)/i.test(url);
            const isAud = /^audio\//.test(a.type || "") || /\.(mp3|ogg|wav|m4a|flac)(\?|$)/i.test(url);
            let el;
            if (isImg) el = h("img", { alt: a.name, loading: "lazy" });
            else if (isVid) el = h("video", { controls: "", preload: "metadata" });
            else if (isAud) el = h("audio", { controls: "", preload: "metadata" });
            else el = h("a", { target: "_blank", rel: "noreferrer noopener", download: a.name }, a.name + (a.key ? " (saved)" : ""));
            const setSrc = u => { if (el.tagName === "A") el.href = u; else el.src = u; };
            let local = false;
            if (a.key) {
                const have = objUrls.get(a.key);
                if (have) { local = true; setSrc(have); }
                else loadObjUrl(a).then(u => { if (u) { local = true; setSrc(u); } else setSrc(url); });
            } else setSrc(url);
            el.addEventListener("error", () => {
                if (local) { local = false; setSrc(url); }
                else if (el.tagName !== "A") el.replaceWith(h("span", { class: "blx-link" }, "[media no longer available: " + a.name + "]"));
            });
            return el;
        }

        function dismissFromChat(id) {
            id = String(id);
            dismissedInChat.add(id);
            saveDismissed();
            const el = document.querySelector(`li.blx-del[data-id="${id}"]`);
            if (el) {
                el.style.transition = "all 0.22s cubic-bezier(0.4, 0, 0.2, 1)";
                el.style.opacity = "0";
                el.style.transform = "translateX(25px) scale(0.96)";
                setTimeout(() => el.remove(), 220);
            }
        }

        function buildGhost(r) {
            const li = h("li", { class: "blx-del", "data-id": r.id, "data-ch": r.ch, "data-guild": r.guild || "" });
            const head = h("div", { class: "blx-head" },
                h("span", { class: "blx-name" }, r.name),
                r.bot ? h("span", { class: "blx-bot" }, "BOT") : null,
                h("span", { class: "blx-time", title: "Sent " + new Date(r.ts).toLocaleString() + " | deleted " + new Date(r.deleted || r.ts).toLocaleString() }, new Date(r.ts).toLocaleString()),
                h("span", { class: "blx-tag" }, "DELETED"));
            const body = h("div", { class: "blx-body" }, head);
            if (r.content) body.append(h("div", { class: "blx-text" }, r.content));
            else if (!r.attachments.length && !r.links.length) body.append(h("div", { class: "blx-text none" }, r.stickers ? "[sticker]" : "[no text]"));
            if (r.attachments.length) {
                const att = h("div", { class: "blx-att" });
                for (const a of r.attachments) att.append(mediaEl(a));
                body.append(att);
            }
            for (const l of r.links) body.append(h("div", null, h("a", { class: "blx-link", href: l, target: "_blank", rel: "noreferrer noopener" }, l)));
            const x = h("div", { class: "blx-x", title: "Dismiss from chat (remains in logs & on PC)", role: "button" }, "\u00d7");
            x.addEventListener("click", e => { e.stopPropagation(); dismissFromChat(r.id); });
            li.append(h("img", { class: "blx-av", src: avatarUrl(r), alt: "" }), body, x);
            return li;
        }

        const NATIVE = /chat-messages-(\d+)-(\d+)$/;
        const listEl = () => document.querySelector('[data-list-id="chat-messages"]');
        const itemsOf = (ol, skip) => {
            const out = [];
            for (const el of ol.children) {
                if (el === skip) continue;
                if (el.classList.contains("blx-del")) { out.push({ el, id: el.getAttribute("data-id"), ghost: true }); continue; }
                const m = NATIVE.exec(el.id || "");
                if (m) out.push({ el, id: m[2], ghost: false });
            }
            return out;
        };
        function place(ol, g, id) {
            const items = itemsOf(ol, g);
            if (!items.length) { ol.append(g); return; }
            const ref = items.find(i => cmp(i.id, id) > 0);
            if (ref) ref.el.before(g); else items[items.length - 1].el.after(g);
        }
        let syncLogged = 0;
        function sync() {
            const ol = listEl();
            if (!ol) return;
            const chm = /\/channels\/[^/]+\/(\d+)/.exec(location.pathname);
            const ch = chm ? chm[1] : null;

            const natives = itemsOf(ol).filter(i => !i.ghost);
            const nativeIds = new Set(natives.map(i => i.id));
            const wanted = new Map();
            if (ch) {
                const oldest = natives.length ? natives[0].id : null;
                for (const r of log) {
                    if (dismissedInChat.has(r.id)) continue;
                    if (r.ch === ch && !nativeIds.has(r.id) && (oldest === null || cmp(r.id, oldest) > 0)) wanted.set(r.id, r);
                }
            }
            for (const el of ol.querySelectorAll("li.blx-del")) {
                if (!wanted.has(el.getAttribute("data-id"))) el.remove();
            }
            if (!wanted.size) return;
            if (syncLogged < 5) { syncLogged++; api.log("showing " + wanted.size + " deleted message(s) in the open channel"); }

            for (const r of [...wanted.values()].sort((a, b) => cmp(a.id, b.id))) {
                let g = ol.querySelector('li.blx-del[data-id="' + r.id + '"]');
                if (!g) { g = buildGhost(r); place(ol, g, r.id); continue; }
                const items = itemsOf(ol);
                const i = items.findIndex(x => x.el === g);
                const prev = items[i - 1], next = items[i + 1];
                if (!((!prev || cmp(prev.id, r.id) < 0) && (!next || cmp(next.id, r.id) > 0))) place(ol, g, r.id);
            }
        }

        let timer = 0;
        function schedule(ms) {
            if (timer) return;
            timer = setTimeout(() => {
                timer = 0;
                try { sync(); } catch (e) { api.log("sync error: " + (e && e.message || e)); }
            }, ms || 150);
        }
        const own = n => n.nodeType === 1 && n.classList && n.classList.contains("blx-del");
        const mo = new MutationObserver(muts => {
            if (muts.every(m => { const nodes = [...m.addedNodes, ...m.removedNodes]; return nodes.length && nodes.every(own); })) return;
            scheduleWatch();
            if (!log.length) return;
            schedule(150);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        api.on(window, "popstate", () => schedule(200));
        const poll = setInterval(() => { if (log.length) schedule(0); }, 2000);

        // ---------- log management ----------
        function removeOne(id) {
            id = String(id);
            const rec = log.find(q => q.id === id);
            if (rec) {
                const cat = rec.guild ? "servers" : "dms";
                for (const a of rec.attachments || []) if (a.key) { mediaDel(a.key); const u = objUrls.get(a.key); if (u) { URL.revokeObjectURL(u); objUrls.delete(a.key); } }
                try { console.log("[beecord] cmd:log-remove:" + JSON.stringify({ category: cat, id })); } catch { }
            }
            log = log.filter(q => q.id !== id);
            logged.delete(id);
            dismissedInChat.delete(id);
            save();
            saveDismissed();
            document.querySelectorAll('li.blx-del[data-id="' + id + '"]').forEach(el => el.remove());
            changed();
        }
        function dropAllMedia(list) {
            for (const r of list) for (const a of r.attachments || []) if (a.key) { mediaDel(a.key); const u = objUrls.get(a.key); if (u) { URL.revokeObjectURL(u); objUrls.delete(a.key); } }
        }
        function clearCategory(cat) {
            if (!cat || cat === "all") {
                clearAll();
                return;
            }
            if (cat === "servers") {
                const toDrop = log.filter(r => r.guild);
                dropAllMedia(toDrop);
                toDrop.forEach(r => { logged.delete(r.id); dismissedInChat.delete(r.id); });
                log = log.filter(r => !r.guild);
                save();
                saveDismissed();
                try { console.log("[beecord] cmd:log-clear:servers"); } catch { }
                document.querySelectorAll("li.blx-del").forEach(el => {
                    if (el.getAttribute("data-guild")) el.remove();
                });
                changed();
            } else if (cat === "dms") {
                const toDrop = log.filter(r => !r.guild);
                dropAllMedia(toDrop);
                toDrop.forEach(r => { logged.delete(r.id); dismissedInChat.delete(r.id); });
                log = log.filter(r => r.guild);
                save();
                saveDismissed();
                try { console.log("[beecord] cmd:log-clear:dms"); } catch { }
                document.querySelectorAll("li.blx-del").forEach(el => {
                    if (!el.getAttribute("data-guild")) el.remove();
                });
                changed();
            }
        }
        function clearAll() {
            dropAllMedia(log);
            log = []; logged.clear(); dismissedInChat.clear();
            save();
            saveDismissed();
            try { console.log("[beecord] cmd:log-clear:all"); } catch { }
            document.querySelectorAll("li.blx-del").forEach(el => el.remove());
            changed();
        }
        function clearHere() {
            const m = /\/channels\/[^/]+\/(\d+)/.exec(location.pathname);
            if (!m) return;
            // Dismiss current channel from chat view (keeps safely in logs & PC)
            for (const r of log) if (r.ch === m[1]) dismissedInChat.add(r.id);
            saveDismissed();
            document.querySelectorAll("li.blx-del").forEach(el => {
                if (el.getAttribute("data-ch") === m[1]) el.remove();
            });
            changed();
        }

        // the "Logs" tab in Discord Settings > beecord reads from here
        if (api.logs) api.logs.register({
            title: "Deleted messages",
            list: () => log.map(r => ({
                id: r.id,
                category: r.guild ? "servers" : "dms",
                guild: r.guild,
                avatar: avatarUrl(r),
                name: r.name,
                where: r.where || (r.guild ? "server" : "DM"),
                content: r.content,
                attachments: (r.attachments || []).map(a => ({ url: (a.key && objUrls.get(a.key)) || a.url, name: a.name, type: a.type })),
                links: r.links || [],
                stickers: r.stickers || 0,
                ts: r.ts,
                deleted: r.deleted || r.ts
            })),
            remove: removeOne,
            clear: clearCategory
        });

        api.cleanup(() => {
            mo.disconnect();
            clearInterval(poll);
            clearTimeout(timer);
            timer = 0;
            queue.length = 0;
            document.querySelectorAll("li.blx-del").forEach(el => el.remove());
            for (const u of objUrls.values()) { try { URL.revokeObjectURL(u); } catch { } }
            objUrls.clear();
            blxMsgLog = null; blxMsgLogNote = "";
        });

        blxMsgLog = {
            count: () => log.length,
            countHere: () => { const m = /\/channels\/[^/]+\/(\d+)/.exec(location.pathname); return m ? log.filter(r => r.ch === m[1]).length : 0; },
            cached: () => cache.size,
            stats: () => stats,
            mediaMB: () => Math.round(mediaBytes / 1048576),
            tap: () => useTap, tapSeen: () => tapSeen, hooked: () => attached.length, actions: () => stats.actions, msgEvents: () => stats.msgEvents, storeWatch: diffOn,
            clearAll, clearHere
        };

        schedule(500);
        api.log("Message Logger started: " + log.length + " in the log, listening for new messages");
    },

    options(api) {
        const { h, row, toggle, note } = api.ui;
        const info = h("span", null, "");
        const refresh = () => {
            if (!blxMsgLog) { info.textContent = blxMsgLogWhy ? "not running (details below)" : "plugin is off"; return; }
            const s = blxMsgLog.stats();
            info.textContent = blxMsgLog.count() + " logged, " + blxMsgLog.countHere() + " in the open channel, " + blxMsgLog.cached() + " messages watched | events seen: " +
                s.creates + " new, " + s.deletes + " deleted | media saved: " + s.media + " (" + blxMsgLog.mediaMB() + " MB" + (s.mediaFail ? ", " + s.mediaFail + " failed" : "") + ")" +
                " | message events from Discord: " + blxMsgLog.msgEvents() + " (" + blxMsgLog.hooked() + " dispatcher(s), tap " + blxMsgLog.tapSeen() + " packets)" + (blxMsgLog.storeWatch() ? " | via message store: " + s.viaStore + " delete(s) found" : "");
        };
        refresh();
        const chip = (label, fn) => {
            const b = h("div", { class: "fc-chip on", role: "button", tabindex: "0" }, label);
            b.addEventListener("click", () => { if (blxMsgLog) fn(); refresh(); });
            return b;
        };
        return [
            row("Status", info),
            !blxMsgLog && blxMsgLogWhy ? note("Why it is not running: " + blxMsgLogWhy) : null,
            blxMsgLog && blxMsgLogNote ? note(blxMsgLogNote) : null,
            row("Log direct messages", toggle(api.settings.get("logDMs", true), v => api.settings.set("logDMs", v))),
            row("Log servers", toggle(api.settings.get("logServers", true), v => api.settings.set("logServers", v))),
            row("Save images / videos / files", toggle(api.settings.get("saveMedia", true), v => api.settings.set("saveMedia", v))),
            row("Also log DM deletes that were never seen", toggle(api.settings.get("logUnknown", true), v => api.settings.set("logUnknown", v))),
            row("Do not log my own deleted messages", toggle(api.settings.get("ignoreSelf", false), v => api.settings.set("ignoreSelf", v))),
            row("Clear the log of the open channel", chip("clear channel", () => blxMsgLog.clearHere())),
            row("Clear the whole log", chip("clear everything", () => blxMsgLog.clearAll())),
            note("Deleted messages stay in the chat in red with a DELETED tag, and all of them are listed in the Logs tab (Settings > beecord > Logs). Only messages that arrived or were loaded while Discord was running can be kept; media is downloaded when the message arrives (max 25 MB per file, 400 MB total). The log holds the last 1000. Close and reopen this panel to refresh the status line.")
        ];
    }
});
