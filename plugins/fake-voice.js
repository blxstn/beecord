// Fake Mute / Deafen: ONE button to the LEFT of the real mic button.
// Everyone in the voice channel sees you as muted / deafened, but your real mic and sound keep working.
// No keyboard shortcuts: the button toggles it, and the settings (Discord Settings > blxstncord) choose what it fakes.
//
// How: Discord's desktop client talks to its gateway over a WebSocket using binary ETF
// (wss://gateway.discord.gg/?encoding=etf). The voice state is opcode 4:
//     { op: 4, d: { guild_id, channel_id, self_mute, self_deaf, self_video, flags } }
// We hook WebSocket.send, read that ETF packet at byte level, and flip the self_mute / self_deaf atoms to `true`.
// ETF has no length fields around a value, so the replacement is safe. No Discord internals are needed.
// After each toggle we re-send the last voice state packet so the change shows up for others at once.
let ctl = null; // lets the settings tab talk to the running plugin

blxstncord.definePlugin({
    id: "voice",
    name: "Fake Mute / Deafen",
    description: "Adds one button (incognito icon) to the left of the real mic button. When it is red, everyone in the voice channel sees you muted and/or deafened while your mic and sound still work. Choose what it fakes below.",
    author: "blxstncord",
    version: "9.0.0",
    enabledByDefault: true,
    webpack: false,

    start(api) {
        const ALL = ["mute", "deafen"];
        const targets = () => { const t = api.settings.get("targets", ALL); return Array.isArray(t) && t.length ? t : ALL; };
        const fakeOn = () => !!api.settings.get("fakeOn", false);
        const isOn = kind => fakeOn() && targets().includes(kind === "mute" ? "mute" : "deafen");
        const enc = new TextEncoder();
        const dec = new TextDecoder("utf-8", { fatal: false });

        let stopped = false;
        let lastWs = null;               // the gateway socket
        let lastRaw = null;              // last op-4 packet exactly as Discord sent it (Uint8Array)
        let lastInChannel = false;       // false when the last op-4 was "leave voice" (channel_id = nil)
        const real = { mute: false, deaf: false };
        let seenOp4 = 0, logged = 0;

        // ---------- minimal ETF reader (only what is needed to find offsets) ----------
        const u16 = (b, i) => (b[i] << 8) | b[i + 1];
        const u32 = (b, i) => ((b[i] * 16777216) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]);

        // returns the index right after the term that starts at i
        function skip(b, i) {
            const t = b[i++];
            switch (t) {
                case 97: return i + 1;                                   // SMALL_INTEGER
                case 98: return i + 4;                                   // INTEGER
                case 70: return i + 8;                                   // NEW_FLOAT
                case 99: return i + 31;                                  // FLOAT
                case 100: case 118: return i + 2 + u16(b, i);            // ATOM / ATOM_UTF8
                case 115: case 119: return i + 1 + b[i];                 // SMALL_ATOM / SMALL_ATOM_UTF8
                case 104: { let n = b[i++]; while (n--) i = skip(b, i); return i; }              // SMALL_TUPLE
                case 105: { let n = u32(b, i); i += 4; while (n--) i = skip(b, i); return i; }   // LARGE_TUPLE
                case 106: return i;                                      // NIL
                case 107: return i + 2 + u16(b, i);                      // STRING
                case 108: { let n = u32(b, i); i += 4; while (n--) i = skip(b, i); return skip(b, i); } // LIST (+tail)
                case 109: return i + 4 + u32(b, i);                      // BINARY
                case 110: return i + 2 + b[i];                           // SMALL_BIG
                case 111: return i + 5 + u32(b, i);                      // LARGE_BIG
                case 116: { let n = u32(b, i); i += 4; while (n--) { i = skip(b, i); i = skip(b, i); } return i; } // MAP
                default: throw new Error("unsupported ETF tag " + t);
            }
        }

        // text of a binary / atom term at i, or null
        function textAt(b, i) {
            const t = b[i];
            if (t === 109) { const n = u32(b, i + 1); return dec.decode(b.subarray(i + 5, i + 5 + n)); }
            if (t === 100 || t === 118) { const n = u16(b, i + 1); return dec.decode(b.subarray(i + 3, i + 3 + n)); }
            if (t === 115 || t === 119) { const n = b[i + 1]; return dec.decode(b.subarray(i + 2, i + 2 + n)); }
            return null;
        }

        // entries of the map at i: [{ key, vs, ve }] (value start / end offsets)
        function mapEntries(b, i) {
            if (b[i] !== 116) return null;
            let n = u32(b, i + 1);
            let p = i + 5;
            const out = [];
            while (n--) {
                const kEnd = skip(b, p);
                const key = textAt(b, p);
                const vs = kEnd;
                const ve = skip(b, vs);
                out.push({ key, vs, ve });
                p = ve;
            }
            return out;
        }

        // looks at a binary frame; returns info if it is the voice state (op 4), otherwise null
        function parseOp4(b) {
            if (b.length < 20 || b.length > 2048 || b[0] !== 131) return null;
            const top = mapEntries(b, 1);
            if (!top) return null;
            const op = top.find(e => e.key === "op");
            if (!op) return null;
            const opVal = b[op.vs] === 97 ? b[op.vs + 1] : (b[op.vs] === 98 ? u32(b, op.vs + 1) : -1);
            if (opVal !== 4) return null;
            const dE = top.find(e => e.key === "d");
            if (!dE) return null;
            const d = mapEntries(b, dE.vs);
            if (!d) return null;
            const mute = d.find(e => e.key === "self_mute");
            if (!mute) return null;
            const deaf = d.find(e => e.key === "self_deaf") || null;
            const chan = d.find(e => e.key === "channel_id");
            const atomTrue = e => !!e && textAt(b, e.vs) === "true";
            return {
                mute, deaf,
                muteVal: atomTrue(mute),
                deafVal: atomTrue(deaf),
                inChannel: !!chan && textAt(b, chan.vs) !== "nil" && b[chan.vs] !== 106
            };
        }

        // copy of the packet with self_mute / self_deaf set (pass null to leave one of them alone)
        function withValues(b, info, muteVal, deafVal) {
            const edits = [];
            if (muteVal !== null && muteVal !== undefined) edits.push({ e: info.mute, val: muteVal });
            if (deafVal !== null && deafVal !== undefined && info.deaf) edits.push({ e: info.deaf, val: deafVal });
            edits.sort((x, y) => y.e.vs - x.e.vs); // from the end, so earlier offsets stay valid
            let out = b;
            for (const { e, val } of edits) {
                const text = enc.encode(val ? "true" : "false");
                const t = out[e.vs];
                const atom = (t === 119 || t === 115) ? [t, text.length, ...text] : [t, 0, text.length, ...text];
                const n = new Uint8Array(e.vs + atom.length + (out.length - e.ve));
                n.set(out.subarray(0, e.vs), 0);
                n.set(atom, e.vs);
                n.set(out.subarray(e.ve), e.vs + atom.length);
                out = n;
            }
            return out === b ? b.slice() : out;
        }

        const toBytes = d => {
            if (d instanceof ArrayBuffer) return new Uint8Array(d);
            if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
            return null;
        };

        // ---------- the hook ----------
        api.patch(WebSocket.prototype, "send", orig => function (data, ...rest) {
            try {
                const b = toBytes(data);
                if (b) {
                    const info = parseOp4(b);
                    if (info) {
                        lastWs = this;
                        lastRaw = b.slice();
                        lastInChannel = info.inChannel;
                        real.mute = info.muteVal;
                        real.deaf = info.deafVal;
                        seenOp4++;
                        const fm = !stopped && isOn("mute") && !info.muteVal;
                        const fd = !stopped && isOn("deaf") && !info.deafVal && !!info.deaf;
                        if (logged < 8) { logged++; api.log("voice state packet #" + seenOp4 + ": self_mute=" + info.muteVal + " self_deaf=" + info.deafVal + " inChannel=" + info.inChannel + (fm ? " -> faking mute" : "") + (fd ? " -> faking deafen" : "")); }
                        if (fm || fd) data = withValues(b, info, fm ? true : null, fd ? true : null).buffer;
                    }
                } else if (typeof data === "string" && data.includes('"op":4') && data.includes("self_mute")) {
                    // JSON gateway (web client): same idea
                    const p = JSON.parse(data);
                    if (p && p.op === 4 && p.d && "self_mute" in p.d) {
                        lastWs = this;
                        real.mute = !!p.d.self_mute; real.deaf = !!p.d.self_deaf;
                        if (!stopped) {
                            if (isOn("mute")) p.d.self_mute = true;
                            if (isOn("deaf")) p.d.self_deaf = true;
                            data = JSON.stringify(p);
                        }
                    }
                }
            } catch (e) { if (logged < 12) { logged++; api.log("hook error: " + (e && e.message || e)); } }
            return orig.call(this, data, ...rest);
        });

        // Send the last voice state again (with the REAL values; the hook turns them into the fake ones when on).
        function pushState() {
            try {
                if (!lastWs || lastWs.readyState !== 1 || !lastRaw || !lastInChannel) return false;
                const info = parseOp4(lastRaw);
                if (!info) return false;
                lastWs.send(withValues(lastRaw, info, real.mute, real.deaf).buffer);
                return true;
            } catch (e) { api.log("push failed: " + (e && e.message || e)); return false; }
        }

        // switching the plugin off gives your real state back (runs before the hook is removed)
        api.cleanup(() => { stopped = true; pushState(); });


        let btn = null;
        function setFake(v) {
            api.settings.set("fakeOn", !!v);
            paint();
            const ok = pushState();
            api.log("fake " + targets().join(" + ") + " " + (v ? "ON" : "off") + (ok ? ", voice state re-sent" :
                (lastInChannel ? "" : " (not in a voice channel; it will apply when you join one)") +
                (seenOp4 === 0 ? " (no voice state seen yet: click the real mute once, or rejoin the channel)" : "")));
        }
        const toggleFake = () => setFake(!fakeOn());
        ctl = { set: setFake, refresh: () => { paint(); pushState(); } };
        api.cleanup(() => { ctl = null; });


        // ---------- the buttons ----------
        api.addStyle(`
            .bc-fakebtn{all:unset;box-sizing:border-box;width:32px;height:32px;border-radius:6px;display:inline-flex;align-items:center;
                justify-content:center;cursor:pointer;flex:none;margin-right:2px;color:var(--interactive-normal,#b5bac1);position:relative}
            .bc-fakebtn:hover{background:var(--background-modifier-hover,rgba(255,255,255,.08));color:var(--interactive-hover,#dbdee1)}
            .bc-fakebtn.on{color:#f23f42}
            .bc-fakebtn svg{width:22px;height:22px;display:block}`);

        const NS = "http://www.w3.org/2000/svg";

        // incognito: fedora (crown + brim) over a pair of glasses
        function icon(on) {
            const svg = document.createElementNS(NS, "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            const add = (tag, attrs) => {
                const el = document.createElementNS(NS, tag);
                for (const k in attrs) el.setAttribute(k, attrs[k]);
                el.setAttribute("fill", "currentColor");
                svg.append(el);
            };
            add("path", { d: "M6.4 10.6 7.8 5.1C8.2 3.9 9.8 3.4 12 3.4s3.8.5 4.2 1.7l1.4 5.5z" });                       // crown
            add("path", { d: "M1.8 12c0-1.3 4.5-2.3 10.2-2.3s10.2 1 10.2 2.3-4.5 2.3-10.2 2.3S1.8 13.3 1.8 12z" });        // brim
            add("circle", { cx: "7.2", cy: "18", r: "3.2" });                                                              // left lens
            add("circle", { cx: "16.8", cy: "18", r: "3.2" });                                                             // right lens
            add("path", { d: "M10 17.2c1.3-.8 2.7-.8 4 0v1.3c-1.3-.8-2.7-.8-4 0z" });                                      // bridge
            if (on) {
                const s = document.createElementNS(NS, "path");
                s.setAttribute("d", "M3.5 3 21 21");
                s.setAttribute("stroke", "currentColor");
                s.setAttribute("stroke-width", "2.4");
                s.setAttribute("stroke-linecap", "round");
                s.setAttribute("fill", "none");
                svg.append(s);
            }
            return svg;
        }

        function paint() {
            if (!btn) return;
            const on = fakeOn();
            btn.classList.toggle("on", on);
            btn.replaceChildren(icon(on));
            const label = "Fake " + targets().join(" + ") + ": " +
                (on ? "ON (others see you " + targets().map(t => t === "mute" ? "muted" : "deafened").join(" + ") + ")" : "off");
            btn.title = label;
            btn.setAttribute("aria-label", label);
        }

        function makeBtn() {
            const el = document.createElement("button");
            el.type = "button";
            el.className = "bc-fakebtn";
            el.setAttribute("data-bc-btn", "fake");
            el.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); toggleFake(); });
            return el;
        }

        // ---------- finding the real buttons ----------
        const MUTE_RE = /^(mute|unmute|wycisz|wyłącz wyciszenie|włącz wyciszenie)$/i;
        const DEAF_RE = /^(deafen|undeafen|wyłącz dźwięk|włącz dźwięk|ogłusz|wyłącz ogłuszenie)$/i;
        const usable = el => !el.hasAttribute("data-bc-btn") && !el.closest("#blxstncord-panel") && !el.closest('[role="dialog"],[aria-modal="true"]');

        function findReal() {
            const labelled = [...document.querySelectorAll("[aria-label]")].filter(usable);
            let mute = labelled.find(e => MUTE_RE.test((e.getAttribute("aria-label") || "").trim()));
            let deaf = labelled.find(e => DEAF_RE.test((e.getAttribute("aria-label") || "").trim()));
            if (!mute || !deaf) { // other languages: the first two switches in the user panel are mic and headphones
                const sw = [...document.querySelectorAll('[role="switch"]')].filter(usable);
                if (!mute && sw.length) mute = sw[0];
                if (!deaf && sw.length > 1) deaf = sw[1];
            }
            return mute ? { mute, deaf } : null;
        }

        // The real button may be wrapped together with its dropdown arrow. We sit in front of the WHOLE unit,
        // i.e. the child of the buttons row that contains the real button.
        function unitIn(row, el) {
            let unit = el;
            while (unit.parentElement && unit.parentElement !== row) unit = unit.parentElement;
            return unit.parentElement === row ? unit : null;
        }
        function place(el, real) {
            let row = real.mute;
            if (real.deaf) { while (row && !row.contains(real.deaf)) row = row.parentElement; }
            else row = null;
            return row && row !== real.mute ? row : null;
        }

        let placed = false;
        function ensureButtons() {
            if (btn && btn.isConnected) return;
            const r = findReal();
            if (!r) return;
            if (btn) btn.remove();
            const row = place(null, r);
            btn = makeBtn();
            const mUnit = row ? unitIn(row, r.mute) : null;
            if (mUnit) row.insertBefore(btn, mUnit); else r.mute.parentElement.insertBefore(btn, r.mute);
            paint();
            if (!placed) { placed = true; api.log("button added left of the real mic button"); }
        }

        let timer = null;
        const mo = new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => { timer = null; try { ensureButtons(); } catch (e) { api.log("button error: " + (e && e.message || e)); } }, 300);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        try { ensureButtons(); } catch { }

        const diag = setTimeout(() => {
            if (!placed) {
                try {
                    const sw = [...document.querySelectorAll('[role="switch"]')].map(e => (e.getAttribute("aria-label") || "?").slice(0, 30));
                    api.log("diag: real mic/headphones buttons not found. switches=" + JSON.stringify(sw));
                } catch { }
            }
        }, 20000);

        api.cleanup(() => {
            mo.disconnect();
            clearTimeout(timer);
            clearTimeout(diag);
            if (btn) btn.remove();
            btn = null;
        });

        api.__test = { parseOp4, withValues, skip }; // used by the offline test
    },

    options(api) {
        const { row, toggle, chips, note } = api.ui;
        const saved = api.settings.get("targets", ["mute", "deafen"]);
        const sel = (Array.isArray(saved) ? saved : ["mute", "deafen"]).slice();
        return [
            row("Fake voice state (same as the button)", toggle(api.settings.get("fakeOn", false), v => {
                if (ctl) ctl.set(v); else api.settings.set("fakeOn", v);
            })),
            row("The button fakes", chips(["mute", "deafen"], sel, v => {
                api.settings.set("targets", v);
                if (ctl) ctl.refresh();
            })),
            note("One incognito button sits to the left of the real mic button. Red = on: everyone in the channel sees you muted/deafened (whatever is selected above, nothing selected = both) while your real mic and sound keep working. If nothing changes when you switch it on in the middle of a call, click the real mute once or rejoin the channel.")
        ];
    }
});
