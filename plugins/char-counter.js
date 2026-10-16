// Character Counter: live counter while you type a message.
blxstncord.definePlugin({
    id: "char-counter",
    name: "Character Counter",
    description: "Shows a live character counter while you type a message (turns red above the limit).",
    author: "blxstncord",
    version: "1.0.0",
    webpack: false,

    start(api) {
        const el = document.createElement("div");
        el.style.cssText = "position:fixed;right:16px;bottom:76px;z-index:1000;padding:2px 10px;border-radius:10px;" +
            "font:600 12px sans-serif;color:#fff;background:rgba(0,0,0,.65);pointer-events:none;display:none";
        document.body.append(el);
        api.cleanup(() => el.remove());

        const update = () => {
            const box = document.querySelector('[role="textbox"][data-slate-editor="true"]');
            const text = box ? (box.innerText || "").replace(/[\uFEFF\u200B]/g, "").replace(/\n$/, "") : "";
            const n = text.length;
            const limit = api.settings.get("limit", 2000);
            if (!n) { el.style.display = "none"; return; }
            el.style.display = "block";
            el.textContent = n + " / " + limit;
            el.style.background = n > limit ? "#da373c" : "rgba(0,0,0,.65)";
        };
        api.on(document, "input", update, true);
        api.on(document, "keyup", update, true);
        const t = setInterval(update, 500);
        api.cleanup(() => clearInterval(t));
    },

    options(api) {
        return [
            api.ui.row("Nitro limit (4000 characters)",
                api.ui.toggle(api.settings.get("limit", 2000) === 4000, v => api.settings.set("limit", v ? 4000 : 2000)))
        ];
    }
});
