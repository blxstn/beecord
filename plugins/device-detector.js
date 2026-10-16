// Device Detector (Device Viewer) v2.5.0
// Platform indicator inspired by Vencord's PlatformIndicators with offline & invisible user detection.
//
// Shows which device each user is on - PC (desktop app), Phone (mobile), Browser (web) or
// Console (Xbox / PlayStation) - as a clean badge on their avatar (member list, DM list, chat, profile).
//
// OFFLINE & INVISIBLE DETECTION (like Vencord's PlatformIndicators):
// 1. Reads Discord's PresenceStore (including stale clientStatuses that Discord keeps when users go offline)
// 2. Traverses per-guild presences (presencesForGuilds) which often retain device info after global offline switch
// 3. Subscribes to Gateway presence events (PRESENCE_UPDATE, READY_SUPPLEMENTAL, GUILD_MEMBER_LIST_UPDATE)
// 4. Activity detection (voice states, typing, messages) to reveal users appearing offline/invisible who are actually active
// 5. Persistent device memory (localStorage + IndexedDB) that remembers every device ever seen for a user,
//    so their device remains visible even after they go offline or restart Discord!
// 6. Native SVG badge rendering on avatars WITH status dots AND avatars WITHOUT dots (offline members in member list/DMs).

let blxDevScan = null;

(window.beecord || window.blxstncord).definePlugin({
    id: "device-detector",
    name: "Device Detector",
    description: "Shows each user's device (PC, phone, browser, console) on their avatar. Detects devices even when users set their status to offline / invisible.",
    author: "beecord",
    version: "2.5.0",
    enabledByDefault: true,
    webpack: true,

    start(api) {
        const NS = "http://www.w3.org/2000/svg";
        const GREEN = "#23a559", GREY = "#80848e";
        const STATUS_COLOR = { online: GREEN, idle: "#f0b232", dnd: "#f23f42", streaming: "#593695", offline: GREY };
        const STATUS_NAME = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", streaming: "Streaming", offline: "Offline" };
        const ORDER = ["embedded", "mobile", "desktop", "web"];        // which icon wins when on several devices
        const LABEL = { desktop: "PC", mobile: "Phone", web: "Browser", embedded: "Console", unknown: "Unknown device" };
        const ICONS = {   // Material icons, 24x24
            desktop: "M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z",
            mobile: "M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z",
            web: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
            embedded: "M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
            unknown: "M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"
        };
        const REVEAL_MS = 15 * 60 * 1000;
        const SNOW = /^\d{17,20}$/;
        const STATUS_SEL = 'rect[mask*="status" i], rect[mask*="Status" i], rect[mask*="offline" i]';
        const LIST_CTX = '[class*="member_"],[class*="members_"],[data-list-id^="members"],[data-list-id^="private-channels"],[class*="privateChannels"],[class*="userProfile"],[class*="userPopout"]';
        const NOT_CTX = '[class*="message_"],[id^="chat-messages"],[class*="reply_"]';
        const LS_KEY = "beecord_devdet_v2";
        const getS = (k, d) => api.settings.get(k, d);

        const presence = new Map();   // user id -> { status, cs }
        const activity = new Map();   // user id -> timestamp of last seen active (message, typing, reaction, voice)
        const inVoice = new Set();    // users currently in a voice channel
        const popped = new Map();     // user id -> timestamp when badge animated
        const stats = { events: 0, presence: 0, activity: 0, rects: 0, noId: 0, online: 0, hidden: 0, offline: 0, noDot: 0 };
        let store = null;
        let sessionsStore = null;
        let authStore = null;
        let stopped = false;

        // ============================ Safe Storage & Persistent Cache ============================
        let ls = null, lsFrame = null;
        try { ls = window.localStorage || null; } catch { }
        if (!ls) {
            try {
                lsFrame = document.createElement("iframe");
                lsFrame.style.display = "none";
                (document.body || document.documentElement).append(lsFrame);
                ls = lsFrame.contentWindow.localStorage || null;
            } catch { ls = null; }
        }
        api.cleanup(() => { if (lsFrame) lsFrame.remove(); });

        const idb = fn => new Promise((res, rej) => {
            try {
                const r = indexedDB.open("beecord_devdet", 1);
                r.onupgradeneeded = () => r.result.createObjectStore("kv");
                r.onerror = () => rej(r.error);
                r.onsuccess = () => {
                    try {
                        const db = r.result, tx = db.transaction("kv", "readwrite"), q = fn(tx.objectStore("kv"));
                        tx.oncomplete = () => { db.close(); res(q && q.result); };
                        tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
                    } catch (e) { rej(e); }
                };
            } catch (e) { rej(e); }
        });

        let last = {};   // id -> { d: device, t: time, s: status }
        let storageNote = ls ? "localStorage ok" : "localStorage fallback";
        const mergeLast = v => {
            let n = 0;
            if (v && typeof v === "object") for (const id in v) {
                const o = v[id];
                if (SNOW.test(id) && o && ORDER.includes(o.d) && (!last[id] || last[id].t < o.t)) {
                    last[id] = { d: o.d, t: +o.t || 0, s: o.s || "offline" };
                    n++;
                }
            }
            return n;
        };

        try { if (ls) mergeLast(JSON.parse(ls.getItem(LS_KEY) || "{}")); } catch { }
        idb(st => st.get("last")).then(v => { if (mergeLast(v)) schedule(); storageNote += ", IndexedDB ok"; }).catch(() => { });

        let dirty = false;
        function remember(id, device, status) {
            if (!id || !device || !ORDER.includes(device)) return;
            const o = last[id];
            if (o && o.d === device && Date.now() - o.t < 45000 && o.s === status) return;
            last[id] = { d: device, t: Date.now(), s: status || "offline" };
            dirty = true;
        }

        function flush() {
            if (!dirty) return;
            dirty = false;
            try {
                const keys = Object.keys(last);
                if (keys.length > 5000) {
                    keys.sort((a, b) => last[a].t - last[b].t).slice(0, keys.length - 4000).forEach(k => delete last[k]);
                }
                if (ls) ls.setItem(LS_KEY, JSON.stringify(last));
            } catch { }
            idb(st => st.put(last, "last")).catch(() => { });
        }

        // ============================ Presence updates & Gateway tap ============================
        function setPres(id, status, cs) {
            id = id == null ? "" : String(id);
            if (!SNOW.test(id)) return;
            cs = cs && typeof cs === "object" ? cs : {};
            const prev = presence.get(id);
            // merge non-empty client_status so we don't discard known platforms on partial events
            const mergedCs = Object.assign({}, prev && prev.cs, cs);
            presence.set(id, { status: status || (prev && prev.status) || "offline", cs: mergedCs });
            stats.presence++;

            const dev = ORDER.find(k => mergedCs[k]);
            if (dev) remember(id, dev, status);
        }

        function seen(id) {
            id = id == null ? "" : String(id);
            if (!SNOW.test(id)) return;
            activity.set(id, Date.now());
            stats.activity++;
        }

        function handleGateway(t, d) {
            stats.events++;
            switch (t) {
                case "PRESENCE_UPDATE":
                    if (d.user) setPres(d.user.id, d.status, d.client_status);
                    break;
                case "PRESENCE_UPDATES":
                    for (const p of d.updates || d || []) {
                        if (p && p.user) setPres(p.user.id, p.status, p.client_status);
                    }
                    break;
                case "READY":
                case "READY_SUPPLEMENTAL": {
                    const mp = d.merged_presences;
                    if (mp) {
                        for (const p of mp.friends || []) setPres(p.user_id, p.status, p.client_status);
                        for (const g of mp.guilds || []) for (const p of g || []) setPres(p.user_id, p.status, p.client_status);
                    }
                    break;
                }
                case "GUILD_CREATE":
                    for (const p of d.presences || []) setPres((p.user && p.user.id) || p.user_id, p.status, p.client_status);
                    for (const v of d.voice_states || []) if (v && v.user_id && v.channel_id !== null) inVoice.add(String(v.user_id));
                    break;
                case "GUILD_MEMBER_LIST_UPDATE":
                    for (const op of d.ops || []) {
                        const items = op.items || (op.item ? [op.item] : []);
                        for (const it of items) {
                            const m = it && it.member;
                            if (m && m.user && m.presence) setPres(m.user.id, m.presence.status, m.presence.client_status);
                        }
                    }
                    break;
                case "MESSAGE_CREATE":
                case "MESSAGE_UPDATE": seen(d.author && d.author.id); break;
                case "TYPING_START":
                case "MESSAGE_REACTION_ADD":
                case "MESSAGE_REACTION_REMOVE": seen(d.user_id); break;
                case "VOICE_STATE_UPDATE":
                    if (d.user_id) {
                        if (d.channel_id) { inVoice.add(String(d.user_id)); seen(d.user_id); }
                        else inVoice.delete(String(d.user_id));
                    }
                    break;
                default: return;
            }
            schedule();
        }

        api.patch(JSON, "parse", orig => function (...a) {
            const r = orig.apply(this, a);
            try {
                if (r && typeof r === "object" && r.op === 0 && typeof r.t === "string" && r.d && typeof r.d === "object") {
                    handleGateway(r.t, r.d);
                }
            } catch { }
            return r;
        });

        // ============================ Discord PresenceStore via React & Webpack ============================
        const safe = (fn, d) => { try { return fn(); } catch { return d; } };
        const isPresence = o => !!o && (typeof o === "object" || typeof o === "function") &&
            typeof o.getStatus === "function" && typeof o.addChangeListener === "function" &&
            (typeof o.isMobileOnline === "function" || safe(() => o.getName() === "PresenceStore", false) ||
             safe(() => o.constructor.displayName === "PresenceStore", false));

        function reactRoot() {
            for (const el of [document.getElementById("app-mount"), document.body, document.documentElement]) {
                if (!el) continue;
                for (const k of Object.keys(el)) if (k.startsWith("__reactContainer$")) return el[k];
            }
            const el = document.querySelector("img[src*='/avatars/'], [class*='avatar'], [class*='member']");
            let f = el ? fiberOf(el) : null;
            while (f && f.return) f = f.return;
            return f;
        }

        function findInReact(pred, maxMs) {
            const root = reactRoot();
            if (!root) return null;
            const t0 = Date.now();
            const seen = new WeakSet();
            const test = v => {
                if (!v || (typeof v !== "object" && typeof v !== "function") || seen.has(v)) return false;
                seen.add(v);
                return safe(() => pred(v), false);
            };
            const inspect = v => {
                if (test(v)) return v;
                if (Array.isArray(v)) for (const x of v) {
                    if (test(x)) return x;
                    if (Array.isArray(x)) for (const y of x) if (test(y)) return y;
                }
                return null;
            };
            const stack = [root];
            let n = 0, r = null;
            while (stack.length) {
                const f = stack.pop();
                if ((++n & 255) === 0 && Date.now() - t0 > maxMs) break;
                const p = f.memoizedProps;
                if (p && typeof p === "object") { for (const k in p) { if ((r = inspect(p[k]))) return r; } }
                let h = f.memoizedState, hops = 0;
                while (h && typeof h === "object" && hops++ < 80) {
                    const s = h.memoizedState;
                    if ((r = inspect(s))) return r;
                    if (s && typeof s === "object") {
                        if (s.deps && (r = inspect(s.deps))) return r;
                        if (s.current && (r = inspect(s.current))) return r;
                    }
                    h = h.next;
                }
                const sn = f.stateNode;
                if (sn && typeof sn === "object" && !sn.nodeType && (r = inspect(sn))) return r;
                if (f.sibling) stack.push(f.sibling);
                if (f.child) stack.push(f.child);
            }
            return null;
        }

        let viaReact = false;
        function findStore() {
            if (store || stopped) return;
            try {
                store = api.webpack.find(o => o && typeof o.getStatus === "function" && typeof o.isMobileOnline === "function", 1) ||
                    api.webpack.find(o => o && typeof o.getState === "function" && typeof o.getStatus === "function", 1) ||
                    (api.webpack.findByProps && api.webpack.findByProps(["isMobileOnline"], "getStatus", "isMobileOnline")) ||
                    api.webpack.findBy("presence-store", ["isMobileOnline"], o => typeof o.getStatus === "function") ||
                    api.webpack.find(isPresence, 2) || null;
            } catch (e) { api.log("PresenceStore search error: " + (e && e.message || e)); }

            if (!store) {
                try {
                    store = findInReact(isPresence, 1500) || null;
                    if (store) viaReact = true;
                } catch (e) { }
            }

            try {
                if (!sessionsStore) sessionsStore = api.webpack.find(o => o && typeof o.getSessions === "function", 1) || null;
                if (!authStore) authStore = api.webpack.find(o => o && typeof o.getId === "function" && typeof o.getSessionId === "function", 1) || null;
            } catch { }

            if (store) {
                api.log("PresenceStore found" + (viaReact ? " (via React tree)" : ""));
                try {
                    store.addChangeListener(schedule);
                    api.cleanup(() => { try { store.removeChangeListener(schedule); } catch { } });
                } catch { }
                sweep();
                schedule();
            }
        }

        // Flux dispatcher subscription (backup)
        try {
            const isDisp = o => !!o && typeof o.subscribe === "function" && typeof o.dispatch === "function";
            const disp = api.webpack.find(isDisp, 1);
            if (disp) {
                const onPres = data => {
                    if (data && data.type) handleGateway(data.type, data);
                    schedule();
                };
                for (const ev of ["PRESENCE_UPDATES", "PRESENCE_UPDATE", "VOICE_STATE_UPDATES"]) {
                    try { disp.subscribe(ev, onPres); } catch { }
                    api.cleanup(() => { try { disp.unsubscribe(ev, onPres); } catch { } });
                }
            }
        } catch { }

        // Sweep entire PresenceStore to learn devices of everyone online right now
        function sweep() {
            if (!store) return;
            try {
                const s = store.getState && store.getState();
                const m = s && s.clientStatuses;
                if (m && typeof m === "object") {
                    for (const id in m) {
                        const cs = m[id];
                        if (!cs || !SNOW.test(id)) continue;
                        const dev = ORDER.find(k => cs[k]);
                        if (dev) remember(id, dev, store.getStatus ? store.getStatus(id) : "online");
                    }
                }
                // Check per-guild presences snapshot (where Discord keeps clientStatus even for offline users)
                const pfg = s && s.presencesForGuilds;
                if (pfg && typeof pfg === "object") {
                    for (const id in pfg) {
                        if (!SNOW.test(id)) continue;
                        const guilds = pfg[id];
                        if (!guilds || typeof guilds !== "object") continue;
                        for (const gId in guilds) {
                            const p = guilds[gId];
                            const cs = p && (p.clientStatus || p.client_status);
                            if (cs) {
                                const dev = ORDER.find(k => cs[k]);
                                if (dev) remember(id, dev, p.status || "offline");
                            }
                        }
                    }
                }
            } catch { }
        }

        // ============================ Core: determine device and status for a user ============================
        function info(id) {
            let status = "offline";
            let cs = {};

            // 1. Check Discord's PresenceStore
            if (store) {
                try { status = store.getStatus(id) || "offline"; } catch { }
                try { cs = typeof store.getClientStatus === "function" ? store.getClientStatus(id) : null; } catch { }
                if (!cs) {
                    try {
                        const s = store.getState && store.getState();
                        cs = s && s.clientStatuses && s.clientStatuses[id];
                        if (!cs && s && s.presencesForGuilds && s.presencesForGuilds[id]) {
                            const guilds = s.presencesForGuilds[id];
                            for (const gId in guilds) {
                                const p = guilds[gId];
                                if (p && (p.clientStatus || p.client_status)) {
                                    cs = p.clientStatus || p.client_status;
                                    break;
                                }
                            }
                        }
                    } catch { }
                }
                if (!cs && store.isMobileOnline) {
                    try { if (store.isMobileOnline(id)) cs = { mobile: status || "online" }; } catch { }
                }
            }

            // 2. Check Gateway events map
            const p = presence.get(id);
            if (p) {
                if (status === "offline" && p.status && p.status !== "offline") status = p.status;
                if (!cs || !Object.keys(cs).length) cs = p.cs || {};
            }

            // 3. For own user (SessionsStore)
            if (sessionsStore && authStore && authStore.getId && authStore.getId() === id) {
                try {
                    const sess = sessionsStore.getSessions();
                    if (sess && typeof sess === "object") {
                        cs = cs || {};
                        for (const s of Object.values(sess)) {
                            const cl = s.clientInfo && s.clientInfo.client;
                            if (cl && cl !== "unknown") cs[cl] = s.status || cs[cl] || "online";
                        }
                    }
                } catch { }
            }

            // Remember device if reported
            const devices = ORDER.filter(k => cs && cs[k]);
            if (devices.length) remember(id, devices[0], status);

            const known = last[id];
            const appearsOffline = !status || status === "offline" || status === "invisible";

            // Online / Idle / DnD / Streaming user with known devices
            if (!appearsOffline) {
                const dev = devices[0] || (known && known.d) || null;
                return {
                    id,
                    mode: "online",
                    status,
                    devices: devices.length ? devices : (dev ? [dev] : []),
                    device: dev,
                    guess: !devices.length
                };
            }

            // Offline or Invisible user who was seen active recently (typing, voice, message)
            if (getS("reveal", true) && (inVoice.has(id) || Date.now() - (activity.get(id) || 0) < REVEAL_MS)) {
                const dev = devices[0] || (known && known.d) || null;
                return {
                    id,
                    mode: "hidden",
                    status: "online",
                    devices: dev ? [dev] : [],
                    device: dev,
                    since: known && known.t
                };
            }

            // Offline / Invisible user with a reported platform or remembered device
            if (getS("showOffline", true)) {
                // Case A: PresenceStore still has a reported platform (Vencord stale status or guild presence)
                if (devices.length) {
                    return {
                        id,
                        mode: "offline",
                        status: "offline",
                        devices,
                        device: devices[0],
                        reported: cs[devices[0]],
                        since: known && known.t
                    };
                }
                // Case B: Fallback to persistent device memory (survives restarts)
                if (known && known.d) {
                    return {
                        id,
                        mode: "offline",
                        status: "offline",
                        devices: [known.d],
                        device: known.d,
                        since: known.t
                    };
                }
                // Case C: User has no device history at all
                if (getS("greyAll", false)) {
                    return { id, mode: "offline", status: "offline", devices: [], device: null, since: null };
                }
            }

            return null;
        }

        // ============================ DOM: Fiber & Image lookup ============================
        function fiberOf(el) {
            for (const k of Object.keys(el)) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
            return null;
        }

        function recipientId(ch) {
            if (!ch || typeof ch !== "object" || ch.type === 3) return null;
            const list = ch.recipients || ch.rawRecipients;
            if (Array.isArray(list) && list.length === 1) {
                const r = list[0], id = typeof r === "string" ? r : (r && r.id);
                if (typeof id === "string" && SNOW.test(id)) return id;
            }
            if (typeof ch.recipientId === "string" && SNOW.test(ch.recipientId)) return ch.recipientId;
            return null;
        }

        function idFromFiber(el) {
            let f = fiberOf(el);
            for (let i = 0; f && i < 40; i++, f = f.return) {
                const p = f.memoizedProps;
                if (!p || typeof p !== "object") continue;
                for (const x of [p.user && p.user.id, p.userId, p.member && p.member.userId, p.author && p.author.id,
                                 p.user_id, p.recipientId, recipientId(p.channel), recipientId(p)]) {
                    if (typeof x === "string" && SNOW.test(x)) return x;
                }
            }
            return null;
        }

        function idFromImg(svg) {
            const img = svg.querySelector("img[src]");
            const m = img && /\/(?:users|avatars)\/(\d{17,20})\//.exec(img.src);
            return m ? m[1] : null;
        }

        const idOf = (svg, el) => idFromImg(svg) || idFromFiber(el) || (el !== svg ? idFromFiber(svg) : null);

        // ============================ Visual Badge Styles ============================
        api.addStyle(`
        rect[data-blx-hide]{display:none!important}
        svg[data-blx-svg]{overflow:visible}
        g[data-blx-dev]{--ox:0px;--oy:0px;--c:#23a559}
        g[data-blx-dev] .blx-a{transform-box:view-box;transform-origin:var(--ox) var(--oy)}
        g[data-blx-dev] .blx-in{transition:transform .2s cubic-bezier(.3,1.5,.5,1)}
        g[data-blx-dev]:hover .blx-in{transform:scale(1.15)}
        g.blx-new .blx-in,g.blx-changed .blx-in{animation:blxIn .35s cubic-bezier(.2,.9,.3,1.12) backwards}
        g.blx-static *,g.blx-static .blx-in{animation:none!important}
        @keyframes blxIn{0%{transform:scale(.5);opacity:0}60%{transform:scale(1.1);opacity:1}100%{transform:scale(1)}}
        @media (prefers-reduced-motion:reduce){g[data-blx-dev] *{animation:none!important}}`);

        const mk = (tag, attrs, cls) => {
            const e = document.createElementNS(NS, tag);
            for (const k in attrs) e.setAttribute(k, attrs[k]);
            if (cls) e.setAttribute("class", cls);
            return e;
        };

        const badgeOf = host => [...host.children].find(c => c.hasAttribute && c.hasAttribute("data-blx-dev"));

        function restore(rect) {
            rect.removeAttribute("data-blx-hide");
            const g = badgeOf(rect.parentNode);
            if (g) g.remove();
        }

        function ago(t) {
            const m = Math.max(1, Math.round((Date.now() - t) / 60000));
            if (m < 60) return m + "m ago";
            const h = Math.round(m / 60);
            if (h < 48) return h + "h ago";
            return Math.round(h / 24) + "d ago";
        }

        function tip(inf) {
            const dev = inf.device ? LABEL[inf.device] : "";
            if (inf.mode === "online") {
                return (dev ? dev + (inf.guess ? " (last known)" : "") : "Device unknown") + " \u00b7 " + (STATUS_NAME[inf.status] || inf.status);
            }
            if (inf.mode === "hidden") {
                return "Online (Invisible status, active recently)" + (dev ? " \u00b7 " + dev : "");
            }
            return (dev ? dev + " \u00b7 " : "") + "Offline" + (inf.reported ? " (session active)" : inf.since ? " (seen " + ago(inf.since) + ")" : "");
        }

        function paint(host, after, box, inf) {
            const { x, y, w, h } = box;
            const offline = inf.mode === "offline";
            const useIcon = getS("icons", true) && !!inf.device;
            const glyph = inf.device || "unknown";
            const color = offline ? GREY
                : (inf.mode === "hidden" || !getS("colors", true)) ? GREEN : (STATUS_COLOR[inf.status] || GREEN);
            const anim = getS("anim", true);
            const key = [inf.mode, inf.status, inf.device, color].join("|");
            const sig = [key, useIcon, anim, x, y, w, h].join("|");

            let g = badgeOf(host);
            if (g && g.getAttribute("data-sig") === sig) {
                const t = g.querySelector("title");
                if (t) { const s = tip(inf); if (t.textContent !== s) t.textContent = s; }
                return g;
            }

            const changed = !!g && g.getAttribute("data-key") !== key;
            if (!g) { g = mk("g", { "data-blx-dev": "1" }); if (after) after.after(g); else host.append(g); }
            const svg = g.ownerSVGElement;
            if (svg) svg.setAttribute("data-blx-svg", "1");
            g.setAttribute("data-sig", sig);
            g.setAttribute("data-key", key);

            const now = Date.now();
            const intro = changed || now - (popped.get(inf.id) || 0) > 30000;
            if (intro) popped.set(inf.id, now);
            g.setAttribute("class", "blx-" + inf.mode + (inf.mode === "online" ? " blx-s-" + inf.status : "") +
                (useIcon ? " blx-d-" + glyph : "") + (!anim ? " blx-static" : changed ? " blx-changed" : intro ? " blx-new" : ""));

            const cx = x + w / 2, cy = y + h / 2, base = Math.max(w, h);
            g.setAttribute("style", "--c:" + color + ";--ox:" + cx + "px;--oy:" + cy + "px");
            g.replaceChildren();

            const title = mk("title", {});
            title.textContent = tip(inf);
            g.append(title);

            const inner = mk("g", {}, "blx-in blx-a");
            const cutout = "fill:var(--background-base-lowest,#1e1f22)";
            if (useIcon) {
                const R = base * 0.92;
                inner.append(mk("circle", { cx, cy, r: R, style: cutout }));
                const s = R * 1.5;
                const pos = mk("g", { transform: "translate(" + (cx - s / 2) + " " + (cy - s / 2) + ") scale(" + (s / 24) + ")" });
                pos.append(mk("path", { d: ICONS[glyph], fill: color }));
                inner.append(pos);
            } else {
                const R = base * (box.own ? 0.56 : 0.5);
                inner.append(mk("circle", { cx, cy, r: R + Math.max(.8, base * 0.08), style: cutout }));
                inner.append(mk("circle", { cx, cy, r: R, fill: color }));
                if (offline) inner.append(mk("circle", { cx, cy, r: R * 0.45, style: cutout }));
            }
            g.append(inner);
            return g;
        }

        function boxOfRect(rect) {
            let x = parseFloat(rect.getAttribute("x")), y = parseFloat(rect.getAttribute("y"));
            let w = parseFloat(rect.getAttribute("width")), h = parseFloat(rect.getAttribute("height"));
            if (![x, y, w, h].every(Number.isFinite)) {
                try { const b = rect.getBBox(); x = b.x; y = b.y; w = b.width; h = b.height; } catch { return null; }
            }
            return { x, y, w, h };
        }

        function boxOfAvatar(fo) {
            const x0 = parseFloat(fo.getAttribute("x")) || 0, y0 = parseFloat(fo.getAttribute("y")) || 0;
            const sz = parseFloat(fo.getAttribute("width")) || parseFloat(fo.getAttribute("height"));
            if (!Number.isFinite(sz) || sz < 16) return null;
            const d = Math.max(8, Math.round(sz * 0.3125)), c = sz * 0.82;
            return { x: x0 + c - d / 2, y: y0 + c - d / 2, w: d, h: d, own: true };
        }

        // ============================ Scanner ============================
        function scan() {
            if (stopped) return;
            const alive = new Set();
            let total = 0, noId = 0, on = 0, hid = 0, off = 0, nodot = 0;

            // 1. Avatars WITH a native status rect (online, idle, dnd, or native offline dot)
            for (const rect of document.querySelectorAll(STATUS_SEL)) {
                const svg = rect.ownerSVGElement;
                if (!svg || !svg.querySelector("foreignObject")) continue;
                total++;
                const id = idOf(svg, rect);
                if (!id) { noId++; continue; }
                const inf = info(id);
                if (!inf) { restore(rect); continue; }
                const box = boxOfRect(rect);
                if (!box) continue;
                const g = paint(rect.parentNode, rect, box, inf);
                rect.setAttribute("data-blx-hide", "1");
                alive.add(g);
                if (inf.mode === "online") on++; else if (inf.mode === "hidden") hid++; else off++;
            }

            // 2. Avatars WITHOUT any status dot (offline members in member list, DM list)
            if (getS("noDot", true)) {
                for (const fo of document.querySelectorAll("foreignObject")) {
                    const svg = fo.ownerSVGElement;
                    if (!svg || svg.querySelector("foreignObject") !== fo || svg.querySelector(STATUS_SEL) || !svg.closest(LIST_CTX) || svg.closest(NOT_CTX)) continue;
                    const id = idOf(svg, svg);
                    if (!id) continue;
                    const inf = info(id);
                    if (!inf) continue;
                    const box = boxOfAvatar(fo);
                    if (!box) continue;
                    alive.add(paint(svg, null, box, inf));
                    nodot++;
                    if (inf.mode === "online") on++; else if (inf.mode === "hidden") hid++; else off++;
                }
            }

            Object.assign(stats, { rects: total, noId, online: on, hidden: hid, offline: off, noDot: nodot });
            for (const g of document.querySelectorAll("g[data-blx-dev]")) {
                if (!alive.has(g)) g.remove();
            }
        }

        let timer = null;
        function schedule() {
            if (timer || stopped) return;
            timer = setTimeout(() => {
                timer = null;
                try { scan(); } catch (e) { api.log("scan error: " + (e && e.message || e)); }
            }, 120);
        }
        blxDevScan = schedule;

        const mo = new MutationObserver(schedule);
        mo.observe(document.documentElement, { childList: true, subtree: true });

        const iv = setInterval(() => {
            const old = Date.now() - REVEAL_MS * 2;
            for (const [id, ts] of activity) if (ts < old) activity.delete(id);
            if (popped.size > 3000) popped.clear();
            sweep();
            flush();
            schedule();
        }, 4000);

        const tries = [0, 2000, 6000, 15000, 35000].map(ms => setTimeout(() => { findStore(); schedule(); }, ms));

        api.cleanup(() => {
            stopped = true;
            blxDevScan = null;
            mo.disconnect();
            clearInterval(iv); clearTimeout(timer); tries.forEach(clearTimeout);
            flush();
            document.querySelectorAll("g[data-blx-dev]").forEach(g => g.remove());
            document.querySelectorAll("rect[data-blx-hide]").forEach(r => r.removeAttribute("data-blx-hide"));
            document.querySelectorAll("svg[data-blx-svg]").forEach(v => v.removeAttribute("data-blx-svg"));
        });

        findStore();
        schedule();
        api.log("Device Detector v2.5.0 started (" + storageNote + ", " + Object.keys(last).length + " remembered devices)");
    },

    options(api) {
        const again = () => { if (blxDevScan) blxDevScan(); };
        const row = (label, key, def) => api.ui.row(label,
            api.ui.toggle(api.settings.get(key, def), v => { api.settings.set(key, v); again(); }));
        return [
            row("Device icon instead of status dot", "icons", true),
            row("Status colors (online green, idle yellow, DND red, streaming purple)", "colors", true),
            row("Show device for users who appear offline (grey icon)", "showOffline", true),
            row("Detect and reveal hidden / invisible users (active while offline)", "reveal", true),
            row("Badge on avatars without a dot (offline member list, DM list)", "noDot", true),
            row("Hollow grey dot for offline users with no known device", "greyAll", false),
            row("Smooth animations", "anim", true),
            api.ui.note("PC = desktop app, phone = mobile, globe = browser, gamepad = console. " +
                "Reads Discord's PresenceStore and Gateway traffic, keeping track of every device seen. " +
                "When someone sets their status to offline / invisible, their device remains visible (grey icon, or green if active recently). " +
                "Remembered devices survive client restarts.")
        ];
    }
});
