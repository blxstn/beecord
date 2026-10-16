// Plugin template. Files starting with "_" are ignored, so copy this to a new file
// (for example my-plugin.js), change the id/name, then press "Rescan plugins" in the blxstncord tab.
//
// api.settings.get(key, default) / api.settings.set(key, value)   saved per plugin
// api.webpack.findByProps(needles, ...props) / findByPrototype(needles, name)   find Discord modules
// api.patch(obj, "method", orig => function (...args) { return orig.apply(this, args); })   undone on stop
// api.addStyle(css)   adds CSS, removed on stop
// api.on(target, event, fn, opts)   event listener, removed on stop
// api.cleanup(fn)   your own cleanup, runs on stop
// api.ui: h, toggle, row, note, chips, textarea   build the options UI
blxstncord.definePlugin({
    id: "my-plugin",            // unique, never change it later (settings are stored under it)
    name: "My Plugin",
    description: "What it does.",
    author: "me",
    version: "1.0.0",
    enabledByDefault: false,
    webpack: true,              // set to false if you don't need Discord's internal modules

    start(api) {
        // return false when a Discord module was not found (it will be retried automatically)
        api.log("started");
    },

    stop(api) {
        // optional: patches/styles/listeners added through api.* are removed automatically
    },

    options(api) {
        return [
            api.ui.row("Example option", api.ui.toggle(api.settings.get("example", false), v => api.settings.set("example", v)))
        ];
    }
});
