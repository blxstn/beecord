// Device Detector v2.0.0  -  device / platform indicator, built the way Vencord's PlatformIndicators works.
//
// Shows which device each user is online on - PC (desktop app), Phone (mobile), Browser (web) or
// Console (Xbox / PlayStation) - as a small icon on their avatar, in the member list and the DM list.
//
// DATA SOURCE: Discord's own PresenceStore, the exact store Vencord reads. It is kept live through the
// store's own change listener and, as a backup, a subscription to the Flux dispatcher's PRESENCE updates.
//
// LIMIT: it can only show what Discord sends to your client. Since v2.1.0 there is no filter on the user's
// overall status (Vencord has none either): if the store lists a platform for a user who appears offline,
// a grey icon is drawn for them (option "Also show the device of users who appear offline"). If Discord lists
// no platform, nothing is drawn. Nothing is inferred from typing, voice or messages.

let refresh = null;   // lets the settings tab ask the running plugin to redraw

(window.beecord || window.blxstncord).definePlugin({
    id: "device-detector",
    name: "Device Detector",
    description: "Shows each user's device (PC / phone / browser / console) on their avatar, like Vencord's platform indicators. Reads Discord's PresenceStore, including users who appear offline when Discord reports a platform for them.",
    author: "blxstncord",
    version: "2.2.0",
    enabledByDefault: true,
    webpack: true,

    start(api) {
        const NS = "http://www.w3.org/2000/svg";
        const SNOW = /^\d{17,20}$/;
        const STATUS_SEL = 'rect[mask*="status"], rect[mask*="Status"]';
        const ORDER = ["embedded", "mobile", "desktop", "web"];        // which icon wins when on several devices
        const LABEL = { desktop: "PC", mobile: "Phone", web: "Browser", embedded: "Console" };
        const STATUS_COLOR = { online: "#23a559", idle: "#f0b232", dnd: "#f23f42", streaming: "#593695", offline: "#80848e" };
        const STATUS_NAME = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", streaming: "Streaming", offline: "Shows offline, but a session is reported" };
        const ICONS = {   // Material icons, 24x24
            desktop: "M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z",
            mobile: "M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z",
            web: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z",
            embedded: "M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
        };
        const getS = (k, d) => api.settings.get(k, d);
        let stopped = false;

        // ============================ data: Discord's PresenceStore ============================
        let presence = null;

        const safe = (fn, d) => { try { return fn(); } catch { return d; } };
        const isPresence = o => !!o && (typeof o === "object" || typeof o === "function") &&
            typeof o.getStatus === "function" && typeof o.addChangeListener === "function" &&
            (typeof o.isMobileOnline === "function" || safe(() => o.getName() === "PresenceStore", false) ||
             safe(() => o.constructor.displayName === "PresenceStore", false));

        // ---- react fallback begin ----
        // Discord components read the store through hooks, so the store instance sits in the React tree (hook
        // dependencies / props). This finds it there when searching Discord's webpack modules finds nothing.
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
            const inspect = v => {   // a store, or an array of stores (hook deps), possibly nested once
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
        // ---- react fallback end ----

        let viaReact = false, diagDone = 0;
        // when nothing is found: say what IS visible, so the log shows why
        function diagStores() {
            try {
                const st = api.webpack.stats();
                const names = (api.webpack.findAll(o => safe(() => typeof o.getName === "function" && /Store$/.test(String(o.getName())), false), 400, 2) || [])
                    .map(o => safe(() => String(o.getName()), "?"));
                const withStatus = (api.webpack.findAll(o => safe(() => typeof o.getStatus === "function", false), 4, 2) || [])
                    .map(o => safe(() => (o.constructor && o.constructor.name || "?") + "{" + Object.getOwnPropertyNames(Object.getPrototypeOf(o)).slice(0, 14).join(",") + "}", "?"));
                api.log("diag: modules " + st.defined + " defined / " + st.loaded + " loaded; flux stores visible in modules: " + names.length +
                    (names.length ? " (" + [...new Set(names)].slice(0, 25).join(", ") + ")" : "") +
                    "; objects with getStatus(): " + JSON.stringify(withStatus) +
                    "; react root " + (reactRoot() ? "found" : "NOT found"));
            } catch (e) { api.log("diag error: " + (e && e.message || e)); }
        }

        function findStore() {
            if (presence || stopped) return;
            try {
                presence = api.webpack.find(o => o && typeof o.getStatus === "function" && typeof o.isMobileOnline === "function", 1) ||
                    api.webpack.find(o => o && typeof o.getState === "function" && typeof o.getStatus === "function", 1) ||
                    (api.webpack.findByProps && api.webpack.findByProps(["isMobileOnline"], "getStatus", "isMobileOnline")) ||
                    api.webpack.findBy("presence-store", ["isMobileOnline"], o => typeof o.getStatus === "function") ||
                    api.webpack.find(isPresence, 2) || null;
            } catch (e) { api.log("PresenceStore search error: " + (e && e.message || e)); }
            if (!presence) {
                try {
                    presence = findInReact(isPresence, 1500) || null;
                    if (presence) viaReact = true;
                } catch (e) { api.log("PresenceStore react search error: " + (e && e.message || e)); }
            }
            if (!presence && diagDone < 2) { diagDone++; diagStores(); }
            if (presence) {
                api.log("PresenceStore: found" + (viaReact ? " (via the React tree)" : ""));
                try {
                    presence.addChangeListener(schedule);
                    api.cleanup(() => { try { presence.removeChangeListener(schedule); } catch { } });
                } catch { }
                schedule();
            }
        }

        // The device(s) + status Discord is reporting for this user. null = show nothing (leave Discord's dot).
        // Like Vencord's PlatformIndicators (v2.1.0): the status filter is gone. What counts is whether Discord put
        // a client status (platform list) for this user into the store. If it did, we show it, even when the user's
        // overall status reads "offline". If it did not, nothing is drawn: no guessing, no side channels.
        const offlineHits = new Set();
        function deviceInfo(id) {
            if (!presence) return null;
            let status;
            try { status = presence.getStatus(id); } catch { }
            const appearsOffline = !status || status === "offline" || status === "invisible";
            if (appearsOffline && !getS("showOffline", true)) return null;
            let cs;
            try { cs = presence.getClientStatus ? presence.getClientStatus(id) : null; } catch { }
            if (!cs) { try { const s = presence.getState && presence.getState(); cs = s && s.clientStatuses && s.clientStatuses[id]; } catch { } }
            const devices = ORDER.filter(d => cs && cs[d]);
            if (!devices.length) return null;   // no platform reported -> leave Discord's own dot alone
            if (appearsOffline) { offlineHits.add(id); return { status: "offline", devices, reported: cs[devices[0]] }; }
            return { status, devices };
        }

        // ============================ live updates: Flux dispatcher (backup) ============================
        const isDisp = o => !!o && (typeof o === "object" || typeof o === "function") &&
            typeof o.subscribe === "function" && typeof o.unsubscribe === "function" && typeof o.dispatch === "function";
        let dispatchers = [];
        try {
            const one = api.webpack.find(o => isDisp(o), 1);
            dispatchers = one ? [one] : (api.webpack.findAll(o => isDisp(o), 6, 3) || []);
        } catch { }
        const onPres = () => schedule();
        const PRES_EVENTS = ["PRESENCE_UPDATES", "PRESENCE_UPDATE"];
        dispatchers.forEach(d => {
            for (const t of PRES_EVENTS) { try { d.subscribe(t, onPres); } catch { } }
            api.cleanup(() => { for (const t of PRES_EVENTS) { try { d.unsubscribe(t, onPres); } catch { } } });
        });

        // ============================ find which user a status dot belongs to ============================
        function fiberOf(el) {
            for (const k of Object.keys(el)) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
            return null;
        }
        function recipientId(ch) {   // a 1:1 DM channel -> its one recipient (group DMs, type 3, are skipped)
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
                                 p.user_id, p.recipientId, recipientId(p.channel), recipientId(p)])
                    if (typeof x === "string" && SNOW.test(x)) return x;
            }
            return null;
        }
        function idFromImg(svg) {
            const img = svg.querySelector("img[src]");
            const m = img && /\/(?:users|avatars)\/(\d{17,20})\//.exec(img.src);
            return m ? m[1] : null;
        }

        // ============================ draw the icon over the status dot ============================
        api.addStyle('rect[data-blx-hide]{display:none!important}');
        const num = (el, a) => parseFloat(el.getAttribute(a));
        const badgeOf = rect => { const n = rect.parentNode; return n ? [...n.children].find(c => c.hasAttribute && c.hasAttribute("data-blx-dev")) : null; };
        function restore(rect) { rect.removeAttribute("data-blx-hide"); const g = badgeOf(rect); if (g) g.remove(); }

        function paint(rect, inf) {
            let x = num(rect, "x"), y = num(rect, "y"), w = num(rect, "width"), h = num(rect, "height");
            if (![x, y, w, h].every(Number.isFinite)) { try { const b = rect.getBBox(); x = b.x; y = b.y; w = b.width; h = b.height; } catch { return; } }
            const dev = inf.devices[0];
            const color = getS("color", true) ? (STATUS_COLOR[inf.status] || STATUS_COLOR.online) : STATUS_COLOR.online;
            const cx = x + w / 2, cy = y + h / 2, base = Math.max(w, h);
            const sig = [dev, inf.devices.join("+"), inf.status, inf.reported || "", color, cx, cy, base].join("|");

            let g = badgeOf(rect);
            if (g && g.getAttribute("data-sig") === sig) { rect.setAttribute("data-blx-hide", "1"); return; }
            if (!g) { g = document.createElementNS(NS, "g"); g.setAttribute("data-blx-dev", "1"); rect.after(g); }
            g.setAttribute("data-sig", sig);
            g.replaceChildren();

            const title = document.createElementNS(NS, "title");
            title.textContent = inf.devices.map(d => LABEL[d]).join(" + ") + " \u00b7 " + (STATUS_NAME[inf.status] || inf.status) +
                (inf.status === "offline" && inf.reported ? " (" + inf.reported + ")" : "");

            const r = base * 0.82, s = r * 1.35;
            const bg = document.createElementNS(NS, "circle");
            bg.setAttribute("cx", cx); bg.setAttribute("cy", cy); bg.setAttribute("r", r);
            bg.setAttribute("style", "fill:var(--background-base-lowest,#1e1f22)");
            const ico = document.createElementNS(NS, "path");
            ico.setAttribute("d", ICONS[dev]); ico.setAttribute("fill", color);
            ico.setAttribute("transform", "translate(" + (cx - s / 2) + " " + (cy - s / 2) + ") scale(" + (s / 24) + ")");

            g.append(title, bg, ico);
            rect.setAttribute("data-blx-hide", "1");
        }

        function scan() {
            if (stopped) return;
            for (const rect of document.querySelectorAll(STATUS_SEL)) {
                const svg = rect.ownerSVGElement;
                if (!svg || !svg.querySelector("foreignObject")) continue;   // avatar dots only, not status-menu icons
                const id = idFromImg(svg) || idFromFiber(rect) || idFromFiber(svg) || (svg.parentElement && idFromFiber(svg.parentElement));
                if (!id) continue;
                const inf = deviceInfo(id);
                if (inf) paint(rect, inf); else restore(rect);
            }
            for (const g of document.querySelectorAll("g[data-blx-dev]")) {   // drop badges whose dot is gone
                const p = g.parentNode;
                if (!p || ![...p.children].some(c => c.matches && c.matches(STATUS_SEL))) g.remove();
            }
        }

        let timer = null;
        function schedule() {
            if (timer || stopped) return;
            timer = setTimeout(() => { timer = null; try { scan(); } catch (e) { api.log("scan error: " + (e && e.message || e)); } }, 120);
        }

        refresh = schedule;
        api.cleanup(() => { refresh = null; });

        const mo = new MutationObserver(schedule);
        mo.observe(document.documentElement, { childList: true, subtree: true });

        const tries = [0, 2000, 6000, 15000, 40000, 90000].map(ms => setTimeout(() => { findStore(); schedule(); }, ms));
        const report = () => api.log("self-check: PresenceStore " + (presence ? "found" + (viaReact ? " (React)" : "") : "NOT found") +
            ", dispatcher subscriptions " + dispatchers.length + ", users showing offline but with a reported device: " + offlineHits.size + " | " +
            (presence ? "" : "without the store nothing can be shown; "));
        const r1 = setTimeout(report, 8000), r2 = setTimeout(report, 30000);

        api.cleanup(() => {
            stopped = true;
            mo.disconnect();
            tries.forEach(clearTimeout); clearTimeout(timer); clearTimeout(r1); clearTimeout(r2);
            document.querySelectorAll("g[data-blx-dev]").forEach(g => g.remove());
            document.querySelectorAll("rect[data-blx-hide]").forEach(r => r.removeAttribute("data-blx-hide"));
        });

        findStore();
        schedule();
        api.log("Device Detector v2.2.0 started");
    },

    options(api) {
        return [
            api.ui.row("Colour the icon by status (online / idle / DnD)",
                api.ui.toggle(api.settings.get("color", true), v => api.settings.set("color", v))),
            api.ui.row("Also show the device of users who appear offline (grey icon)",
                api.ui.toggle(api.settings.get("showOffline", true), v => { api.settings.set("showOffline", v); if (refresh) refresh(); })),
            api.ui.note("Shows the device each user is on - PC, phone, browser or console - read from Discord's " +
                "PresenceStore, the same source Vencord's platform indicators use. It can only show what Discord sends to " +
                "your client: when a user who appears offline still has a platform listed there, a grey icon is drawn; " +
                "when Discord lists no platform, nothing is drawn.")
        ];
    }
});
