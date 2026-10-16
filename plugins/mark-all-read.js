// Mark All Read v1.1.0: a button above the server list that clears every unread server channel, thread and DM.
// The button is only visible while something is unread (it appears with the first unread message and disappears
// as soon as everything is cleared).
//
// How it works (no network access of its own, no token handling):
//  1. On click it finds Discord's own stores (read states, guilds, channels) through webpack and lists every
//     channel that has unread messages (plus channels with mentions).
//  2. It hands that list to Discord's Flux dispatcher as one BULK_ACK action, which is the same thing Discord
//     itself does when you mark things as read. Discord then updates the badges and tells its server.
// Everything is looked up on click, so the plugin always starts; if a store cannot be found the button turns red
// and the reason is written to log.txt (run show-log.bat).
let blxMarkAll = null;   // lets the settings tab talk to the running plugin

(window.beecord || window.blxstncord).definePlugin({
    id: "mark-all-read",
    name: "Mark All Read",
    description: "Adds a button above the server list that marks every unread server channel and DM as read in one click.",
    author: "blxstncord",
    version: "1.1.1",
    enabledByDefault: true,
    webpack: true,

    start(api) {
        const { h } = api.ui;
        const NS = "http://www.w3.org/2000/svg";
        let lastInfo = "no click yet";

        // ---------- Discord modules (looked up lazily, cached once found) ----------
        const isDisp = (o, strict) => !!o && (typeof o === "object" || typeof o === "function") && typeof o.dispatch === "function" && typeof o.subscribe === "function" && (!strict || typeof o.unsubscribe === "function");
        function probe(c) {
            const t = "BLXSTNCORD_PROBE_" + Math.random().toString(36).slice(2);
            let hit = false;
            const f = () => { hit = true; };
            try { c.subscribe(t, f); c.dispatch({ type: t }); } catch { }
            try { c.unsubscribe && c.unsubscribe(t, f); } catch { }
            return hit;
        }
        const cache = {};
        const store = (name, needles, pred) => {
            if (cache[name]) return cache[name];
            let r = null;
            try { r = api.webpack.find(pred, 1) || api.webpack.find(pred, 2); } catch { }
            if (!r) { try { r = api.webpack.findBy("mar-" + name, needles, pred); } catch { } }
            if (r) cache[name] = r;
            return r || null;
        };
        const readState = () => store("readstate", ["hasUnread", "lastMessageId"], o => typeof o.hasUnread === "function" && typeof o.lastMessageId === "function") ||
            (api.webpack.findByProps && api.webpack.findByProps(["hasUnread", "lastMessageId"], "hasUnread", "lastMessageId")) ||
            (api.webpack.find && api.webpack.find(o => o && typeof o.hasUnread === "function", 2));
        const guildStore = () => store("guilds", ["getGuild", "getGuilds"], o => typeof o.getGuild === "function" && typeof o.getGuilds === "function");
        const channelStore = () => store("channels", ["getChannel", "getDMFromUserId"], o => typeof o.getChannel === "function" && typeof o.getDMFromUserId === "function");
        const guildChannelStore = () => store("guildchannels", ["getDefaultChannel", "getChannels"], o => typeof o.getChannels === "function" && typeof o.getDefaultChannel === "function");
        const threadStore = () => store("threads", ["getActiveJoinedThreadsForGuild"], o => typeof o.getActiveJoinedThreadsForGuild === "function");

        function getDispatcher() {
            if (cache.disp) return cache.disp;
            let good = null;
            try { good = (api.webpack.findAll(o => isDisp(o, true), 8, 1) || []).find(probe); } catch { }
            if (!good) {
                for (const n of [["called without an action type"], ["isDispatching"], ["_subscriptions"], ["_actionHandlers"], ["flushWaitQueue"]]) {
                    let c = null;
                    try { c = api.webpack.findBy("mar-flux-" + n[0], n, o => isDisp(o, false)); } catch { }
                    if (c && probe(c)) { good = c; break; }
                }
            }
            if (!good) { try { good = (api.webpack.findAll(o => isDisp(o, false), 20, 3) || []).find(probe); } catch { } }
            if (good) cache.disp = good;
            return good;
        }

        // ---------- collect every unread channel ----------
        function guildChannels(gid) {
            const out = [];
            const gcs = guildChannelStore();
            try {
                const c = gcs && gcs.getChannels(gid);
                for (const k of Object.keys(c || {})) if (Array.isArray(c[k])) for (const x of c[k]) out.push(x && x.channel ? x.channel : x);
            } catch { }
            if (!out.length) {
                try { const cs = channelStore(); if (cs && cs.getMutableGuildChannelsForGuild) out.push(...Object.values(cs.getMutableGuildChannelsForGuild(gid) || {})); } catch { }
            }
            try {
                const ts = threadStore();
                const t = ts && ts.getActiveJoinedThreadsForGuild(gid);
                for (const parent of Object.values(t || {})) for (const x of Object.values(parent || {})) out.push(x && x.channel ? x.channel : x);
            } catch { }
            return out;
        }

        function collect() {
            const rs = readState();
            if (!rs) throw new Error("Discord's read-state store was not found");
            const found = new Map();   // channel id -> last message id
            let skipped = 0;
            const consider = (id, force) => {
                id = id && typeof id === "object" ? id.id : id;
                if (!id || found.has(String(id))) return;
                id = String(id);
                let unread = !!force;
                if (!unread) { try { unread = !!rs.hasUnread(id); } catch { } }
                if (!unread) return;
                let m = null;
                try { m = rs.lastMessageId(id); } catch { }
                if (m) found.set(id, String(m)); else skipped++;
            };
            const dms = api.settings.get("dms", true);
            const servers = api.settings.get("servers", true);
            const cs = channelStore();
            if (servers) {
                const gs = guildStore();
                if (!gs) throw new Error("Discord's guild store was not found");
                for (const gid of Object.keys(gs.getGuilds() || {})) for (const ch of guildChannels(gid)) consider(ch);
            }
            if (dms && cs) {
                let list = [];
                try { list = cs.getSortedPrivateChannels ? cs.getSortedPrivateChannels() : Object.values(cs.getMutablePrivateChannels ? cs.getMutablePrivateChannels() : {}); } catch { }
                for (const ch of list || []) consider(ch);
            }
            try {
                for (const id of (rs.getMentionChannelIds ? rs.getMentionChannelIds() : []) || []) {
                    let isDm = false;
                    try { const c = cs && cs.getChannel(id); isDm = !!c && !(c.guild_id || c.guildId); } catch { }
                    if (isDm ? dms : servers) consider(id, false);
                }
            } catch { }
            return { found, skipped, rs };
        }

        // ---------- the button ----------
        const svg = d => {
            const s = document.createElementNS(NS, "svg");
            s.setAttribute("viewBox", "0 0 24 24");
            const p = document.createElementNS(NS, "path");
            p.setAttribute("d", d);
            s.append(p);
            return s;
        };
        const ICON = "M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z";

        api.addStyle(`
        .bmr-btn{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;flex:none;
            width:48px;height:28px;margin:8px auto 8px;border-radius:14px;animation:bmr-in .2s ease-out;font:700 12px var(--font-primary,"gg sans","Noto Sans",sans-serif);
            background:var(--background-base-lower,#1e1f22);color:var(--interactive-normal,#b5bac1);
            transition:background .15s,color .15s,border-radius .15s,transform .1s}
        @keyframes bmr-in{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:none}}
        .bmr-btn.bmr-hide{display:none}
        .bmr-btn:hover{background:#23a559;color:#fff;border-radius:9px}
        .bmr-btn:active{transform:scale(.94)}
        .bmr-btn:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
        .bmr-btn svg{width:18px;height:18px;fill:currentColor;flex:none}
        .bmr-btn.bmr-ok{background:#23a559;color:#fff;border-radius:9px}
        .bmr-btn.bmr-err{background:#da373c;color:#fff;border-radius:9px}
        .bmr-btn.bmr-float{position:fixed;top:10px;left:12px;margin:0;z-index:120;box-shadow:0 2px 8px rgba(0,0,0,.4)}
        `);

        const label = h("span", null, "");
        const btn = h("button", { class: "bmr-btn bmr-hide", type: "button", title: "Mark all as read", "aria-label": "Mark all as read", "data-blxstncord-mark-all": "1" }, svg(ICON), label);
        let resetTimer = 0, holdUntil = 0;   // holdUntil: keep the button visible while an error is shown
        function flash(cls, text, title) {
            btn.classList.remove("bmr-ok", "bmr-err");
            btn.classList.add(cls);
            btn.classList.remove("bmr-hide");
            holdUntil = Date.now() + 2500;
            label.textContent = text;
            btn.title = title;
            clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
                btn.classList.remove("bmr-ok", "bmr-err");
                label.textContent = "";
                btn.title = "Mark all as read";
                holdUntil = 0;
                refresh();
            }, 2500);
        }

        let busy = false;
        function run() {
            if (busy) return;
            busy = true;
            try {
                const { found, skipped, rs } = collect();
                if (!found.size) {
                    lastInfo = "nothing unread" + (skipped ? " (" + skipped + " channel(s) had no last message id)" : "");
                    api.log("click: " + lastInfo);
                    setVisible(false);
                    return;
                }
                const d = getDispatcher();
                if (!d) throw new Error("Discord's event dispatcher was not found");
                const channels = [...found].map(([channelId, messageId]) => ({ channelId, messageId, readStateType: 0 }));
                d.dispatch({ type: "BULK_ACK", context: "APP", channels });
                api.log("click: sent BULK_ACK for " + channels.length + " channel(s)" + (skipped ? ", " + skipped + " skipped (no last message id)" : ""));
                setVisible(false);   // gone right away; if something is still unread afterwards it comes back by itself
                setTimeout(() => {
                    let left = 0;
                    for (const id of found.keys()) { try { if (rs.hasUnread(id)) left++; } catch { } }
                    lastInfo = "last click: " + channels.length + " sent, " + left + " still unread afterwards";
                    api.log("check: " + lastInfo);
                    refresh();
                }, 900);
            } catch (e) {
                const msg = String(e && e.message || e);
                lastInfo = "FAILED: " + msg;
                api.log("click failed: " + msg);
                flash("bmr-err", "!", "Mark all as read failed: " + msg);
            } finally { busy = false; }
        }
        btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); run(); });
        // keep Discord's own handlers (drag, keyboard list navigation) away from our button
        for (const ev of ["mousedown", "pointerdown", "keydown"]) btn.addEventListener(ev, e => e.stopPropagation());

        // ---------- show only while something is unread ----------
        function setVisible(v) { btn.classList.toggle("bmr-hide", !v); }
        let warned = false;
        function refresh() {
            if (Date.now() < holdUntil) return;
            try {
                const n = collect().found.size;
                lastInfo = n + " unread channel(s)";
                setVisible(n > 0);
                warned = false;
            } catch (e) {
                setVisible(false);
                if (!warned) { warned = true; api.log("unread check failed: " + (e && e.message || e)); }
            }
        }
        let checkTimer = 0;
        const soon = ms => { if (checkTimer) return; checkTimer = setTimeout(() => { checkTimer = 0; refresh(); }, ms || 250); };
        // Discord events make it instant; a slow poll is the safety net
        const EVENTS = ["MESSAGE_CREATE", "MESSAGE_ACK", "CHANNEL_ACK", "BULK_ACK", "LOAD_MESSAGES_SUCCESS", "GUILD_CREATE", "CONNECTION_OPEN"];
        let subscribed = null, subTries = 0;
        function trySubscribe() {
            if (subscribed || subTries++ > 40) return;
            let d = null;
            try { d = (api.webpack.findAll(o => isDisp(o, true), 8, 1) || []).find(probe); } catch { }
            if (!d) return;
            subscribed = d;
            for (const t of EVENTS) { try { d.subscribe(t, soon); } catch { } }
            api.log("watching " + EVENTS.length + " Discord events for unread changes");
        }
        const firstCheck = setTimeout(() => { trySubscribe(); refresh(); }, 3000);
        const unreadPoll = setInterval(() => { trySubscribe(); refresh(); }, 2000);

        // ---------- placement: top of the server bar, or a floating button as fallback ----------
        let mode = "";
        const serverNav = () => {
            const list = document.querySelector('[data-list-id="guildsnav"]');
            return (list && list.closest("nav")) || document.querySelector('nav[aria-label*="erver" i]');
        };
        function place() {
            const nav = api.settings.get("floating", false) ? null : serverNav();
            if (nav) {
                if (btn.parentElement !== nav || nav.firstChild !== btn) nav.insertBefore(btn, nav.firstChild);
                btn.classList.remove("bmr-float");
                if (mode !== "nav") { mode = "nav"; api.log("button placed above the server list"); }
            } else {
                const forced = api.settings.get("floating", false);
                if (!forced && !floatOk) { if (btn.isConnected) btn.remove(); return; }   // give Discord a moment to draw the server bar first
                if (btn.parentElement !== document.body) document.body.append(btn);
                btn.classList.add("bmr-float");
                if (mode !== "float") { mode = "float"; api.log(forced ? "button placed as a floating button (setting)" : "server list not found, using a floating button"); }
            }
        }
        let floatOk = false;
        const ft = setTimeout(() => { floatOk = true; try { place(); } catch { } }, 15000);
        let obsTimer = 0;
        const mo = new MutationObserver(() => {
            if (obsTimer) return;
            obsTimer = setTimeout(() => { obsTimer = 0; try { place(); } catch { } }, 200);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        const poll = setInterval(() => { try { place(); } catch { } }, 3000);
        place();

        api.cleanup(() => {
            mo.disconnect();
            clearInterval(poll);
            clearTimeout(ft);
            clearTimeout(obsTimer);
            clearTimeout(resetTimer);
            clearTimeout(firstCheck);
            clearTimeout(checkTimer);
            clearInterval(unreadPoll);
            if (subscribed) for (const t of EVENTS) { try { subscribed.unsubscribe(t, soon); } catch { } }
            btn.remove();
            blxMarkAll = null;
        });

        blxMarkAll = { run, relayout: () => { mode = ""; place(); }, info: () => lastInfo };
        api.log("Mark All Read v1.1.0 loaded");
    },

    options(api) {
        const { h, row, toggle, note } = api.ui;
        const info = h("span", null, blxMarkAll ? blxMarkAll.info() : "plugin is off");
        return [
            row("Status", info),
            row("Include servers", toggle(api.settings.get("servers", true), v => api.settings.set("servers", v))),
            row("Include direct messages", toggle(api.settings.get("dms", true), v => api.settings.set("dms", v))),
            row("Floating button instead of above the server list", toggle(api.settings.get("floating", false), v => { api.settings.set("floating", v); if (blxMarkAll) blxMarkAll.relayout(); })),
            note("The double-check button at the top of the server bar only shows while something is unread, and disappears as soon as you clear it. Every click is also written to log.txt (show-log.bat).")
        ];
    }
});
