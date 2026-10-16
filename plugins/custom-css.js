// Custom CSS: write your own CSS in the settings tab, it applies instantly.
let styleEl = null;

blxstncord.definePlugin({
    id: "custom-css",
    name: "Custom CSS",
    description: "Write your own CSS to restyle Discord. Applies live while you type.",
    author: "blxstncord",
    version: "1.0.0",
    webpack: false, // does not need Discord's internal modules

    start(api) {
        styleEl = api.addStyle(api.settings.get("css", ""));
        api.cleanup(() => { styleEl = null; });
    },

    options(api) {
        return [
            api.ui.textarea(api.settings.get("css", ""), v => {
                api.settings.set("css", v);
                if (styleEl) styleEl.textContent = v;
            }, "/* example: :root { --brand-500: #ff5500; } */"),
            api.ui.note("Tip: use Ctrl+Shift+I (inspect element) to find what to restyle.")
        ];
    }
});
