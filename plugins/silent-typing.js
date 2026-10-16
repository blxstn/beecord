// Silent Typing: other people never see "is typing...".
// Drops the "POST /channels/<id>/typing" request, so it does not depend on Discord's internal modules.
(window.beecord || window.blxstncord).definePlugin({
    id: "typing",
    name: "Silent Typing",
    description: "Hides the \"is typing...\" indicator from other people while you type.",
    author: "beecord",
    version: "3.0.0",
    enabledByDefault: true,
    webpack: false,

    start(api) {
        const TYPING = /\/channels\/\d+\/typing(?:[?#]|$)/;
        const urlOf = i => typeof i === "string" ? i : (i && i.url) || String(i);

        api.patch(window, "fetch", orig => function (input, init) {
            try {
                const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
                if (method === "POST" && TYPING.test(urlOf(input))) return Promise.resolve(new Response(null, { status: 204 }));
            } catch { }
            return orig.call(this, input, init);
        });

        api.patch(XMLHttpRequest.prototype, "open", orig => function (method, url, ...rest) {
            try { this.__fcTyping = String(method).toUpperCase() === "POST" && TYPING.test(String(url)); } catch { }
            return orig.call(this, method, url, ...rest);
        });
        api.patch(XMLHttpRequest.prototype, "send", orig => function (...a) {
            if (this.__fcTyping) return;
            return orig.apply(this, a);
        });
    }
});
