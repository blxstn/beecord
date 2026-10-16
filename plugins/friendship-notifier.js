// Friendship Notifier v1.2.0
// Logs and pop-up notifications for friend activity:
//   - someone removed you as a friend (or blocked you; Discord reports both the same way)
//   - someone sent you a friend request
//   - someone withdrew the friend request they sent you
//
// Needs the updated renderer.js (Logs tab with the "Message logs" / "Friend activity" switch).
//
// HOW IT WORKS: it reads the RELATIONSHIP_ADD / RELATIONSHIP_REMOVE events straight from Discord's gateway (the same
// "gateway tap" Message Logger uses), and the READY packet for your current friend list. It does NOT need Discord's
// internal Flux dispatcher (v1.0.0 did, and on builds where it cannot be found the plugin never started, which is why
// the Logs tab said "off or not installed"). The dispatcher is now only a backup if the tap sees nothing.
// Things you do yourself (unfriend, ignore a request, ...) are recognised and skipped.
// It also keeps a snapshot of your friends, so changes that happened while Discord was closed are found on the next start.
//
// v1.2.0: added a third, independent source: every minute it reads your friend list from Discord's own REST API
// (GET /api/v9/users/@me/relationships, the same request the Discord client makes) and compares it with the previous
// answer. This works even when the gateway tap sees nothing (Discord does not use JSON for the gateway) and when
// Discord's webpack modules cannot be found. The login token is taken from Discord's own requests, is kept only in
// memory (never saved, never logged) and is only ever sent back to discord.com/api.
//
// HARD LIMIT: Discord sends exactly the same event when someone unfriends you and when someone blocks you.
// There is no way for any client mod to tell them apart, so both are logged as "REMOVED / BLOCKED".
(window.beecord || window.blxstncord).definePlugin({
    id: "friendship-notifier",
    name: "Friendship Notifier",
    description: "Logs + pop-up when someone removes/blocks you, sends you a friend request or withdraws it. Own tab in the Logs page.",
    author: "blxstncord",
    version: "1.2.0",
    enabledByDefault: true,
    webpack: false,   // start immediately, so the READY packet (your friend list) is not missed; stores are searched later

    start(api) {
        const T = { FRIEND: 1, BLOCKED: 2, INCOMING: 3, OUTGOING: 4 };
        const SNOW = /^\d{17,20}$/;
        const MAX_LOG = 300;
        const MAX_TOASTS = 4;
        const SELF_WINDOW = 10000;   // ms: events right after your own action on that user are yours, not theirs
        const getS = (k, d) => api.settings.get(k, d);

        const KINDS = {
            lost: {
                tag: "REMOVED / BLOCKED", color: "#f23f42", setting: "on_lost",
                text: "Removed you as a friend, or blocked you.",
                hint: "Discord sends the same event for both, so it is impossible to tell which one it was."
            },
            request: {
                tag: "FRIEND REQUEST", color: "#23a559", setting: "on_request",
                text: "Sent you a friend request.", hint: ""
            },
            cancel: {
                tag: "REQUEST WITHDRAWN", color: "#f0b232", setting: "on_cancel",
                text: "Withdrew the friend request they sent you.", hint: ""
            }
        };

        // ================================ Discord's Flux dispatcher (backup only) ================================
        const isDisp = o => !!o && (typeof o === "object" || typeof o === "function") &&
            typeof o.subscribe === "function" && typeof o.unsubscribe === "function" && typeof o.dispatch === "function";
        let stopped = false;

        // ================================ stores (names + current relationships) ================================
        const stores = { user: null, rel: null, auth: null };
        const tap = { seen: 0, ready: false, me: null, rel: new Map() };   // what the gateway told us (id -> relationship type)
        const auth = { token: null };                                      // taken from Discord's own API requests, memory only
        const poll = { cur: null, me: null, t: 0, next: 0, n: 0, last: "not run yet", backoff: 0, busy: false };
        const POLL_MS = 60000;
        const IS_API = /^(?:https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com)?\/api\//i;
        function findStores() {
            try {
                if (!stores.user) {
                    stores.user = api.webpack.findBy("friend-user-store", ["findByTag", "getCurrentUser"],
                        o => typeof o.getUser === "function" && typeof o.getCurrentUser === "function") ||
                        api.webpack.find(o => typeof o.getUser === "function" && typeof o.getCurrentUser === "function" && typeof o.getUsers === "function", 1) || null;
                }
                if (!stores.rel) {
                    stores.rel = api.webpack.findBy("friend-rel-store", ["getRelationshipType", "getFriendIDs"],
                        o => typeof o.getRelationshipType === "function" && typeof o.getFriendIDs === "function") ||
                        api.webpack.find(o => typeof o.getRelationshipType === "function" && typeof o.getFriendIDs === "function", 1) || null;
                }
                if (!stores.auth) {
                    stores.auth = api.webpack.findBy("friend-auth-store", ["getToken"], o => typeof o.getToken === "function" && typeof o.getId === "function") || null;
                }
            } catch (e) { api.log("store search error: " + (e && e.message || e)); }
        }
        const meId = () => {
            try { const u = stores.user && stores.user.getCurrentUser(); if (u && SNOW.test(String(u.id))) return String(u.id); } catch { }
            return tap.me || poll.me;
        };

        // ================================ names + avatars ================================
        let snap = getS("snap", null);
        const known = Object.assign({}, snap && snap.names);   // id -> { n: display name, u: username, a: avatar hash }

        function touch(id, hint) {
            let u = hint && typeof hint === "object" ? hint : null;
            if (!u && stores.user) { try { u = stores.user.getUser(id); } catch { } }
            if (u && (u.username || u.globalName || u.global_name)) {
                known[id] = { n: u.globalName || u.global_name || u.username || "", u: u.username || "", a: u.avatar || null };
            }
            return known[id] || null;
        }
        function avatarUrl(id, hash) {
            if (hash) return "https://cdn.discordapp.com/avatars/" + id + "/" + hash + ".png?size=128";
            let idx = 0;
            try { idx = Number((BigInt(id) >> 22n) % 6n); } catch { }
            return "https://cdn.discordapp.com/embed/avatars/" + idx + ".png";
        }
        function who(id, hint) {
            const k = touch(id, hint);
            return {
                name: (k && (k.n || k.u)) || "Unknown user",
                where: k && k.u ? "@" + k.u : "ID " + id,
                avatar: avatarUrl(id, k && k.a)
            };
        }

        // ================================ the log (shown in Logs > Friend activity) ================================
        let entries = Array.isArray(getS("log", [])) ? getS("log", []) : [];
        let seq = 0;
        const saveLog = () => api.settings.set("log", entries);
        const changed = () => { try { api.logs && api.logs.refresh(); } catch { } };

        if (api.logs) api.logs.register({
            kind: "friends",
            title: "Friend activity",
            list: () => entries.map(r => ({
                id: r.id, avatar: r.avatar, name: r.name, where: r.where, content: r.text,
                tag: r.tag, color: r.color, hint: r.hint, note: r.note, ts: r.ts, deleted: r.ts
            })),
            remove: id => { entries = entries.filter(r => r.id !== id); saveLog(); changed(); },
            clear: () => { entries = []; saveLog(); changed(); }
        });

        // ================================ pop-up (bottom right) ================================
        let host = null;
        api.addStyle(`
#blxfn-host{position:fixed;right:20px;bottom:20px;z-index:100001;display:flex;flex-direction:column;gap:10px;width:350px;max-width:calc(100vw - 40px);pointer-events:none;
    font-family:var(--font-primary,"gg sans","Noto Sans",sans-serif)}
.blxfn-toast{--c:#5865f2;position:relative;display:flex;align-items:flex-start;gap:12px;padding:14px 40px 17px 18px;border-radius:12px;overflow:hidden;cursor:pointer;
    pointer-events:auto;box-sizing:border-box;background:var(--background-base-lowest,#1e1f22);color:var(--text-default,var(--text-normal,#dbdee1));
    border:1px solid rgba(128,128,128,.22);box-shadow:0 10px 30px rgba(0,0,0,.42);animation:blxfn-in .4s cubic-bezier(.2,.9,.25,1) both}
.blxfn-toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c)}
.blxfn-toast.out{animation:blxfn-out .32s cubic-bezier(.4,0,.8,.4) forwards;pointer-events:none}
.blxfn-av{width:42px;height:42px;border-radius:50%;flex:none;object-fit:cover;background:rgba(128,128,128,.25)}
.blxfn-body{min-width:0;flex:1}
.blxfn-name{font-weight:700;font-size:15px;line-height:1.25;color:var(--header-primary,#f2f3f5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blxfn-txt{margin-top:2px;font-size:13.5px;line-height:1.35;word-break:break-word}
.blxfn-meta{margin-top:8px;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text-muted,#949ba4)}
.blxfn-tag{font-size:10px;font-weight:700;letter-spacing:.04em;line-height:16px;padding:0 7px;border-radius:4px;color:#fff;background:var(--c)}
.blxfn-x{position:absolute;top:8px;right:8px;width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;
    color:var(--text-muted,#949ba4);transition:background .15s,color .15s}
.blxfn-x:hover{background:rgba(128,128,128,.25);color:var(--header-primary,#fff)}
.blxfn-x svg{width:16px;height:16px;fill:currentColor}
.blxfn-prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--c);opacity:.9;transform-origin:left center;animation:blxfn-prog var(--d,8s) linear forwards}
.blxfn-toast:hover .blxfn-prog{animation-play-state:paused}
@keyframes blxfn-in{from{opacity:0;transform:translateX(36px)}to{opacity:1;transform:none}}
@keyframes blxfn-out{0%{opacity:1;transform:none;max-height:var(--h,120px);margin-bottom:0}
    55%{opacity:0;transform:translateX(42px);max-height:var(--h,120px);margin-bottom:0}
    100%{opacity:0;transform:translateX(42px);max-height:0;margin-bottom:-10px;padding-top:0;padding-bottom:0;border-width:0}}
@keyframes blxfn-prog{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){.blxfn-toast,.blxfn-toast.out{animation-duration:.01s!important}.blxfn-prog{animation:none!important;display:none}}
`);
        function ensureHost() {
            if (host && host.isConnected) return host;
            host = document.getElementById("blxfn-host") || document.createElement("div");
            host.id = "blxfn-host";
            if (!host.isConnected) (document.body || document.documentElement).append(host);
            return host;
        }
        const XICON = "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z";
        const toastTimers = new Set();

        function dismiss(el) {
            if (!el || el.classList.contains("out")) return;
            el.style.setProperty("--h", el.offsetHeight + "px");
            el.classList.add("out");
            const t = setTimeout(() => { toastTimers.delete(t); el.remove(); }, 360);
            toastTimers.add(t);
        }
        function showToast(e) {
            const root = ensureHost();
            const live = [...root.children].filter(c => !c.classList.contains("out"));
            for (const old of live.slice(0, Math.max(0, live.length - (MAX_TOASTS - 1)))) dismiss(old);

            const ms = Number(getS("duration", 8)) * 1000;   // 0 = stays until closed
            const img = document.createElement("img");
            img.className = "blxfn-av"; img.alt = ""; img.src = e.avatar || "";
            const name = document.createElement("div"); name.className = "blxfn-name"; name.textContent = e.name;
            const txt = document.createElement("div"); txt.className = "blxfn-txt"; txt.textContent = e.text;
            const tag = document.createElement("span"); tag.className = "blxfn-tag"; tag.textContent = e.tag;
            const time = document.createElement("span"); time.textContent = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const meta = document.createElement("div"); meta.className = "blxfn-meta"; meta.append(tag, time);
            const body = document.createElement("div"); body.className = "blxfn-body"; body.append(name, txt, meta);
            const x = document.createElement("div"); x.className = "blxfn-x"; x.setAttribute("role", "button"); x.title = "Close"; x.setAttribute("aria-label", "Close");
            x.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + XICON + '"/></svg>';

            const el = document.createElement("div");
            el.className = "blxfn-toast";
            el.style.setProperty("--c", e.color);
            el.append(img, body, x);
            if (ms > 0) {
                el.style.setProperty("--d", ms + "ms");
                const prog = document.createElement("div"); prog.className = "blxfn-prog"; el.append(prog);
            }
            root.append(el);

            let timer = null, left = ms, began = 0;
            const arm = () => { if (ms <= 0) return; began = Date.now(); timer = setTimeout(() => dismiss(el), Math.max(300, left)); toastTimers.add(timer); };
            el.addEventListener("mouseenter", () => { if (timer) { clearTimeout(timer); toastTimers.delete(timer); timer = null; left -= Date.now() - began; } });
            el.addEventListener("mouseleave", () => { if (!timer && !el.classList.contains("out")) arm(); });
            x.addEventListener("click", ev => { ev.stopPropagation(); dismiss(el); });
            el.addEventListener("click", () => {
                dismiss(el);
                try { blxstncord.openLogs("friends"); } catch { }
            });
            arm();
        }

        // ================================ recording events ================================
        const emittedAt = {};        // "kind:userId" -> when it was last logged (stops the API poll from repeating a gateway event)
        const handled = new Set();   // "kind:userId" already logged in this session (so the start-up check never repeats them)
        function emit(kind, id, hintUser, note, silent) {
            const def = KINDS[kind];
            if (!def || !getS(def.setting, true)) return;
            const w = who(id, hintUser);
            const entry = {
                id: Date.now().toString(36) + "-" + (seq++), kind, uid: id,
                name: w.name, where: w.where, avatar: w.avatar,
                text: def.text, tag: def.tag, color: def.color, hint: def.hint,
                ts: Date.now(), note: note || ""
            };
            entries.unshift(entry);
            if (entries.length > MAX_LOG) entries.length = MAX_LOG;
            saveLog();
            handled.add(kind + ":" + id);
            emittedAt[kind + ":" + id] = Date.now();
            changed();
            if (!silent && getS("popup", true)) showToast(entry);
            api.log(def.tag + ": " + w.name + " (" + id + ")" + (note ? " [" + note + "]" : ""));
        }

        // your own actions on a user (unfriend, ignore a request, block, ...) are not "theirs"
        const selfActs = {};
        const REL_URL = /\/users\/@me\/relationships\/(\d{17,20})(?:[?#]|$)/;
        const markSelf = (method, url) => {
            try {
                if (String(method).toUpperCase() === "GET") return;
                const m = REL_URL.exec(String(url));
                if (m) selfActs[m[1]] = Date.now();
            } catch { }
        };
        const byMe = id => Date.now() - (selfActs[id] || 0) < SELF_WINDOW;

        const authFrom = h => {
            try {
                if (!h) return null;
                if (typeof h.get === "function") return h.get("authorization");
                if (Array.isArray(h)) { const p = h.find(x => x && String(x[0]).toLowerCase() === "authorization"); return p && p[1]; }
                for (const k of Object.keys(h)) if (k.toLowerCase() === "authorization") return h[k];
            } catch { }
            return null;
        };
        const grab = v => { if (typeof v === "string" && v.length > 30 && !/^(bot|bearer)\s/i.test(v)) auth.token = v; };

        api.patch(window, "fetch", orig => function (input, init) {
            try {
                const url = typeof input === "string" ? input : (input && input.url) || String(input);
                markSelf((init && init.method) || (input && input.method) || "GET", url);
                if (IS_API.test(url)) grab(authFrom(init && init.headers) || authFrom(input && typeof input === "object" && input.headers));
            } catch { }
            return orig.call(this, input, init);
        });
        api.patch(XMLHttpRequest.prototype, "open", orig => function (method, url, ...rest) {
            try { this.__blxRel = String(method).toUpperCase() !== "GET" && REL_URL.exec(String(url)); this.__blxApi = IS_API.test(String(url)); } catch { }
            return orig.call(this, method, url, ...rest);
        });
        api.patch(XMLHttpRequest.prototype, "setRequestHeader", orig => function (k, v) {
            try { if (this.__blxApi && String(k).toLowerCase() === "authorization") grab(v); } catch { }
            return orig.call(this, k, v);
        });
        api.patch(XMLHttpRequest.prototype, "send", orig => function (...a) {
            try { if (this.__blxRel) selfActs[this.__blxRel[1]] = Date.now(); } catch { }
            return orig.apply(this, a);
        });

        // the same event can reach more than one dispatcher object
        const recent = {};
        const dup = key => { const n = Date.now(); if (recent[key] && n - recent[key] < 1500) return true; recent[key] = n; return false; };
        const relOf = ev => (ev && typeof ev.relationship === "object" && ev.relationship) || ev || null;
        const typeOf = r => (r && typeof r.type === "number" ? r.type : NaN);
        // some payloads carry only the id: fall back to what the last snapshot knew about that user
        const typeFromSnap = id => !snap ? NaN : (snap.friends || []).includes(id) ? T.FRIEND : (snap.incoming || []).includes(id) ? T.INCOMING : NaN;

        function onAdd(ev) {
            try {
                const r = relOf(ev); if (!r) return;
                const id = String(r.id || (r.user && r.user.id) || "");
                if (!SNOW.test(id)) return;
                touch(id, r.user);
                if (typeOf(r) === T.INCOMING && !dup("add:" + id) && !byMe(id)) emit("request", id, r.user);
                scheduleSnapshot();
            } catch (e) { api.log("add handler error: " + (e && e.message || e)); }
        }
        function onRemove(ev) {
            try {
                const r = relOf(ev); if (!r) return;
                const id = String(r.id || "");
                if (!SNOW.test(id)) return;
                let t = typeOf(r);
                if (!Number.isFinite(t)) t = typeFromSnap(id);
                if (!dup("rem:" + id + ":" + t)) {
                    if (byMe(id)) {
                        handled.add("lost:" + id); handled.add("cancel:" + id);   // you did it yourself
                    } else if (t === T.FRIEND) emit("lost", id, null);
                    else if (t === T.INCOMING) emit("cancel", id, null);
                }
                scheduleSnapshot();
            } catch (e) { api.log("remove handler error: " + (e && e.message || e)); }
        }

        // ================================ snapshot + "while Discord was closed" check ================================
        function allRels() {
            try {
                const r = stores.rel && stores.rel.getRelationships && stores.rel.getRelationships();
                if (r instanceof Map) return [...r.entries()];
                if (r && typeof r === "object") return Object.entries(r);
            } catch { }
            return [];
        }
        function currentState() {
            if (!stores.rel && !tap.ready && !poll.cur) return null;
            const friends = [], incoming = [], blocked = [];
            let list = allRels();
            if (!list.length && stores.rel) { try { for (const id of stores.rel.getFriendIDs() || []) friends.push(String(id)); } catch { } }
            if (!list.length && !friends.length && tap.ready) list = [...tap.rel.entries()];   // store missing or still empty: use the READY packet
            if (!list.length && !friends.length && poll.cur) return poll.cur;   // last resort: the REST answer
            for (const [id, t] of list) {
                const sid = String(id), ty = Number(t);
                if (!SNOW.test(sid)) continue;
                if (ty === T.FRIEND) friends.push(sid);
                else if (ty === T.INCOMING) incoming.push(sid);
                else if (ty === T.BLOCKED) blocked.push(sid);
            }
            return { friends, incoming, blocked, total: friends.length + incoming.length + blocked.length };
        }
        const hadData = s => !!(s && ((s.friends && s.friends.length) || (s.incoming && s.incoming.length)));

        function saveSnapshot(cur, me) {
            cur = cur || currentState(); me = me || meId();
            if (!cur || !me) return;
            if (!cur.total && hadData(snap)) return;   // looks like the store is not loaded yet: keep the old baseline
            const names = {};
            for (const id of cur.friends.concat(cur.incoming)) { touch(id); if (known[id]) names[id] = known[id]; }
            snap = { me, t: Date.now(), friends: cur.friends, incoming: cur.incoming, names };
            api.settings.set("snap", snap);
        }
        let snapTimer = null;
        function scheduleSnapshot() {
            if (snapTimer || stopped) return;
            snapTimer = setTimeout(() => { snapTimer = null; if (checked) saveSnapshot(); }, 3000);
        }

        let checked = false;
        function checkChanges(final) {
            if (stopped) return;
            findStores();
            const cur = currentState(), me = meId();
            if (!cur || !me) { if (final) api.log("start-up check skipped: relationship list not available"); return; }
            const prev = snap && snap.me === me ? snap : null;
            if (!cur.total && hadData(prev)) {   // empty list right after start usually means "not loaded yet"
                if (final) { checked = true; api.log("start-up check skipped: relationship list stayed empty"); }
                return;
            }
            checked = true;
            if (prev && getS("offline", true)) {
                const pf = new Set(prev.friends || []), pi = new Set(prev.incoming || []);
                const cf = new Set(cur.friends), ci = new Set(cur.incoming), cb = new Set(cur.blocked);
                const lost = (prev.friends || []).filter(id => !cf.has(id) && !cb.has(id) && !handled.has("lost:" + id));
                const asked = cur.incoming.filter(id => !pi.has(id) && !pf.has(id) && !handled.has("request:" + id));
                const canc = (prev.incoming || []).filter(id => !ci.has(id) && !cf.has(id) && !cb.has(id) && !handled.has("cancel:" + id));
                if (lost.length > 8 || canc.length > 20) {
                    api.log("start-up check skipped: " + lost.length + " friends / " + canc.length + " requests changed at once (looks like a glitch, not real activity)");
                } else {
                    let popups = 0;
                    const note = "while Discord was closed";
                    for (const id of lost) emit("lost", id, null, note, popups++ >= 3);
                    for (const id of asked) emit("request", id, null, note, popups++ >= 3);
                    for (const id of canc) emit("cancel", id, null, note, popups++ >= 3);
                }
            }
            saveSnapshot(cur, me);
        }

        // ================================ gateway tap ================================
        // Every gateway packet is JSON.parse'd by Discord; we look at the dispatch packets (op 0) we care about.
        function tapHandle(r) {
            const t = r.t, d = r.d;
            if (!d || typeof d !== "object") return;
            tap.seen++;
            if (t === "READY") {
                const me = d.user && d.user.id;
                if (me && SNOW.test(String(me))) tap.me = String(me);
                for (const u of Array.isArray(d.users) ? d.users : []) { const id = u && String(u.id); if (id && SNOW.test(id)) touch(id, u); }
                const rels = Array.isArray(d.relationships) ? d.relationships : Array.isArray(d.user_relationships) ? d.user_relationships : null;
                if (rels) {
                    tap.rel = new Map();
                    for (const x of rels) {
                        if (!x || typeof x !== "object") continue;
                        const id = String(x.id || x.user_id || (x.user && x.user.id) || "");
                        if (!SNOW.test(id)) continue;
                        if (x.user) touch(id, x.user);
                        if (Number.isFinite(x.type)) tap.rel.set(id, x.type);
                    }
                    tap.ready = true;
                    setTimeout(() => checkChanges(false), 2500);
                }
            } else if (t === "RELATIONSHIP_ADD") {
                const id = String(d.id || (d.user && d.user.id) || "");
                if (SNOW.test(id) && Number.isFinite(d.type)) tap.rel.set(id, d.type);
                onAdd(d);
            } else if (t === "RELATIONSHIP_REMOVE") {
                const id = String(d.id || "");
                // some payloads carry only the id: use the type we knew before this event
                onRemove(!Number.isFinite(d.type) && tap.rel.has(id) ? Object.assign({}, d, { type: tap.rel.get(id) }) : d);
                tap.rel.delete(id);
            }
        }
        api.patch(JSON, "parse", orig => function (...a) {
            const r = orig.apply(this, a);
            try { if (r && typeof r === "object" && r.op === 0 && typeof r.t === "string") tapHandle(r); } catch { }
            return r;
        });

        // backup: Discord's own dispatcher, only searched for when the tap has seen nothing yet
        let attached = 0;
        const subs = [["RELATIONSHIP_ADD", onAdd], ["RELATIONSHIP_REMOVE", onRemove], ["CONNECTION_OPEN", () => setTimeout(() => checkChanges(false), 4000)]];
        function attachDispatchers() {
            if (attached || stopped || tap.seen > 0) return;
            let found = [];
            try { found = api.webpack.findAll(isDisp, 6, 1) || []; } catch { }
            const strong = found.filter(o => o._subscriptions || o._actionHandlers || o.isDispatching !== undefined);
            const list = strong.length ? strong : found;
            for (const d of list) {
                for (const [ev, fn] of subs) { try { d.subscribe(ev, fn); } catch { } }
                api.cleanup(() => { for (const [ev, fn] of subs) { try { d.unsubscribe(ev, fn); } catch { } } });
                attached++;
            }
            if (attached) api.log("tap saw nothing, using " + attached + " Flux dispatcher(s) as a backup");
        }

        // ================================ REST poll ================================
        const tokenNow = () => {
            if (auth.token) return auth.token;
            try {
                const raw = window.localStorage && window.localStorage.getItem("token");
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed === "string" && parsed.length > 30) return (auth.token = parsed);
                }
            } catch { }
            try { const t = stores.auth && stores.auth.getToken(); if (typeof t === "string" && t.length > 30) return (auth.token = t); } catch { }
            try {
                const st = (api.webpack.find && api.webpack.find(o => o && typeof o.getToken === "function", 2)) ||
                    (api.webpack.findByProps && api.webpack.findByProps(["getToken"], "getToken", "getId"));
                const t = st && st.getToken();
                if (typeof t === "string" && t.length > 30) return (auth.token = t);
            } catch { }
            return null;
        };
        async function apiGet(path) {
            const res = await fetch("/api/v9" + path, { headers: { Authorization: tokenNow() } });
            if (res.status === 429) {
                const ra = Number(res.headers.get("retry-after")) || 60;
                poll.backoff = Date.now() + ra * 1000;
                throw new Error("rate limited, waiting " + ra + "s");
            }
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        }
        // live comparison of two REST answers
        function livePollDiff(prev, cur, since) {
            const pf = new Set(prev.friends), pi = new Set(prev.incoming);
            const cf = new Set(cur.friends), ci = new Set(cur.incoming), cb = new Set(cur.blocked);
            const own = id => (selfActs[id] || 0) >= since - 2000;   // you did it yourself since the last poll
            const fresh = (k, id) => !emittedAt[k + ":" + id] || Date.now() - emittedAt[k + ":" + id] > 300000;
            const lost = prev.friends.filter(id => !cf.has(id) && !cb.has(id) && !own(id) && fresh("lost", id));
            const asked = cur.incoming.filter(id => !pi.has(id) && !pf.has(id) && !own(id) && fresh("request", id));
            const canc = prev.incoming.filter(id => !ci.has(id) && !cf.has(id) && !cb.has(id) && !own(id) && fresh("cancel", id));
            if (lost.length > 8 || canc.length > 20) { api.log("poll: " + lost.length + " friends / " + canc.length + " requests changed at once, ignored (looks like a glitch)"); return; }
            let popups = 0;
            for (const id of lost) emit("lost", id, null, "", popups++ >= 3);
            for (const id of asked) emit("request", id, null, "", popups++ >= 3);
            for (const id of canc) emit("cancel", id, null, "", popups++ >= 3);
        }
        async function pollOnce() {
            if (poll.busy || stopped || !getS("poll", true) || !tokenNow() || Date.now() < poll.backoff) return;
            poll.busy = true;
            poll.next = Date.now() + POLL_MS;
            try {
                if (!poll.me) { const u = await apiGet("/users/@me"); if (u && SNOW.test(String(u.id))) poll.me = String(u.id); }
                const list = await apiGet("/users/@me/relationships");
                if (!Array.isArray(list)) throw new Error("unexpected answer");
                const friends = [], incoming = [], blocked = [];
                for (const x of list) {
                    const id = String(x && (x.id || (x.user && x.user.id)) || "");
                    if (!SNOW.test(id)) continue;
                    if (x.user) touch(id, x.user);
                    if (x.type === T.FRIEND) friends.push(id);
                    else if (x.type === T.INCOMING) incoming.push(id);
                    else if (x.type === T.BLOCKED) blocked.push(id);
                }
                const cur = { friends, incoming, blocked, total: friends.length + incoming.length + blocked.length };
                poll.n++;
                poll.last = "ok (" + friends.length + " friends, " + incoming.length + " incoming, " + blocked.length + " blocked)";
                const prev = poll.cur, since = poll.t;
                if (!cur.total && prev && prev.total) { poll.last = "empty answer ignored"; return; }
                poll.cur = cur; poll.t = Date.now();
                if (!prev) { if (!checked) checkChanges(false); else saveSnapshot(); return; }
                livePollDiff(prev, cur, since);
                scheduleSnapshot();
            } catch (e) { poll.last = "error: " + (e && e.message || e); }
            finally { poll.busy = false; }
        }
        const pollTimer = setInterval(() => { if (Date.now() >= poll.next) pollOnce(); }, 2500);

        findStores();
        const tries = [4000, 12000, 30000, 60000].map((ms, i, arr) => setTimeout(() => { if (!checked) checkChanges(i === arr.length - 1); }, ms));
        const dtries = [20000, 60000].map(ms => setTimeout(attachDispatchers, ms));
        const every = setInterval(() => { if (checked) saveSnapshot(); }, 60000);
        const report = () => api.log("self-check: gateway tap saw " + tap.seen + " packets, READY " +
            (tap.ready ? "seen (" + tap.rel.size + " relationships)" : "not seen (plugin started after it; the relationship store is used instead)") +
            ", stores " + (stores.rel ? "found" : "not found") + ", dispatchers " + attached + ", REST poll: " + poll.n + " ok, last " + poll.last +
            ", token " + (tokenNow() ? "captured" : "NOT captured") + ", " + entries.length + " log entries");
        const rt = [8000, 15000, 60000, 180000].map(ms => setTimeout(report, ms));

        api.cleanup(() => {
            stopped = true;
            tries.forEach(clearTimeout); dtries.forEach(clearTimeout); rt.forEach(clearTimeout);
            clearInterval(every); clearInterval(pollTimer); clearTimeout(snapTimer);
            toastTimers.forEach(clearTimeout); toastTimers.clear();
            const h = document.getElementById("blxfn-host"); if (h) h.remove();
        });

        // used by the "Send test" button in the settings
        api.__test = () => {
            const order = ["request", "cancel", "lost"];
            const kind = order[(api.__n = ((api.__n || 0) + 1)) % 3];
            const def = KINDS[kind];
            showToast({ name: "Example User", where: "@example", avatar: avatarUrl("1", null), text: def.text, tag: def.tag, color: def.color, ts: Date.now() });
        };

        api.log("Friendship Notifier v1.2.0 started (gateway tap + API poll, " + entries.length + " log entries)");
    },

    options(api) {
        const { h, row, toggle, note } = api.ui;
        const duration = api.settings.get("duration", 8);

        const chipRow = h("div", { class: "fc-chips" });
        for (const [label, val] of [["5 s", 5], ["8 s", 8], ["15 s", 15], ["Until closed", 0]]) {
            const chip = h("div", { class: "fc-chip" + (val === duration ? " on" : "") }, label);
            chip.addEventListener("click", () => {
                api.settings.set("duration", val);
                chipRow.querySelectorAll(".fc-chip").forEach(c => c.classList.toggle("on", c === chip));
            });
            chipRow.append(chip);
        }
        const testBtn = h("div", { class: "fc-chip on" }, "Send test pop-up");
        testBtn.addEventListener("click", () => { try { api.__test && api.__test(); } catch { } });

        return [
            row("Pop-up notification (bottom right)", toggle(api.settings.get("popup", true), v => api.settings.set("popup", v))),
            row("Pop-up stays for", chipRow),
            row("Someone removed / blocked you", toggle(api.settings.get("on_lost", true), v => api.settings.set("on_lost", v))),
            row("Someone sent you a friend request", toggle(api.settings.get("on_request", true), v => api.settings.set("on_request", v))),
            row("Someone withdrew their friend request", toggle(api.settings.get("on_cancel", true), v => api.settings.set("on_cancel", v))),
            row("Backup: check your friend list every minute (works even if Discord's events can't be read)", toggle(api.settings.get("poll", true), v => api.settings.set("poll", v))),
            row("Also check changes made while Discord was closed", toggle(api.settings.get("offline", true), v => api.settings.set("offline", v))),
            row("Preview", testBtn),
            note("Discord sends exactly the same event when someone unfriends you and when someone blocks you, so no client mod " +
                "(this one, Vencord, ...) can tell them apart. Both show up as REMOVED / BLOCKED. If you remove a friend yourself on " +
                "another device (phone), it can look like they removed you, because Discord does not say who did it. " +
                "Click a pop-up to open the Friend activity log.")
        ];
    }
});
