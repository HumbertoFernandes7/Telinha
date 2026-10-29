/*
 * PeerLive addon prototype - renderer-side plugin registration (prepended by the loader to the plugin bundle).
 *
 * Runs in Discord's main world right after the official Vencord renderer: window.Vencord exists, Vencord's
 * initPluginManager() and startAllPlugins(StartAt.Init) already ran, and NO Discord webpack chunk has loaded yet.
 * Patches queued now are applied lazily when Discord's module factories first run
 * (src/webpack/patchWebpack.ts:254-264), exactly like a bundled plugin's.
 *
 * Vencord internals used (window.Vencord exports, src/Vencord.ts:25-32):
 *   Plugins.plugins (the `~plugins` object), Plugins.addPatch / isPluginEnabled / startPlugin,
 *   Api.Settings.SettingsStore, Settings, Webpack.wreq.
 */
(() => {
    "use strict";

    if (globalThis.__PeerLiveAddonRegister) return;

    const TAG = "[PeerLiveAddon]";
    const V = globalThis.Vencord;
    const registrations = {};
    globalThis.PeerLiveAddon = { boot: globalThis.__PeerLiveAddonBoot ?? null, registrations };

    if (!V?.Plugins?.plugins || typeof V.Plugins.addPatch !== "function" || !V.Api?.Settings?.SettingsStore || !V.Settings) {
        console.error(TAG, "Vencord renderer not found or incompatible; addon plugins will not load");
        globalThis.__PeerLiveAddonRegister = () => ({ enabled: false, error: "Vencord not found" });
        return;
    }

    const PM = V.Plugins;
    const { SettingsStore } = V.Api.Settings;

    // initPluginManager() (src/api/PluginManager.ts:361-368): features that need an API plugin enabled
    const API_FOR = {
        commands: "CommandsAPI",
        onBeforeMessageEdit: "MessageEventsAPI",
        onBeforeMessageSend: "MessageEventsAPI",
        onMessageClick: "MessageEventsAPI",
        chatBarButton: "ChatInputButtonAPI",
        renderMemberListDecorator: "MemberListDecoratorsAPI",
        renderMessageAccessory: "MessageAccessoriesAPI",
        renderMessageDecoration: "MessageDecorationsAPI",
        messagePopoverButton: "MessagePopoverAPI",
        userProfileBadge: "BadgeAPI"
    };
    const KEYS_TO_BIND = ["onBeforeMessageEdit", "onBeforeMessageSend", "onMessageClick", "renderMemberListDecorator", "renderMessageAccessory", "renderMessageDecoration"];

    function enableLateDependency(name) {
        const dep = PM.plugins[name];
        if (!dep) {
            console.warn(TAG, "missing dependency", name);
            return;
        }
        dep.isDependency = true;
        if (V.Settings.plugins[name].enabled) return; // its patches were already queued by initPluginManager
        V.Settings.plugins[name].enabled = true;
        for (const patch of dep.patches ?? []) PM.addPatch(patch, name);
        if (dep.startAt === "Init") PM.startPlugin(dep);
    }

    /** Does for one late plugin what initPluginManager() (src/api/PluginManager.ts:327-398) did for the bundled ones. */
    function registerLatePlugin(p) {
        if (PM.plugins[p.name]) throw new Error(`a plugin named ${p.name} already exists`);
        const webpackAlreadyRunning = V.Webpack?.wreq != null;

        // The object the settings UI lists (tabs/plugins/index.tsx:151), startAllPlugins() iterates, and that
        // `$self` resolves to (canonicalizeReplacement -> Vencord.Plugins.plugins["<name>"]).
        PM.plugins[p.name] = p;

        if (p.settings) {
            p.settings.pluginName = p.name;
            for (const [key, def] of Object.entries(p.settings.def))
                if (def.onChange) SettingsStore.addChangeListener(`plugins.${p.name}.${key}`, def.onChange);
        }

        const enabled = PM.isPluginEnabled(p.name);
        if (enabled) {
            const needed = new Set(p.dependencies ?? []);
            for (const [key, api] of Object.entries(API_FOR)) if (p[key] && (key !== "commands" || p.commands.length)) needed.add(api);
            needed.forEach(enableLateDependency);
            for (const key of KEYS_TO_BIND) if (p[key]) p[key] = p[key].bind(p);
            for (const patch of p.patches ?? []) PM.addPatch(patch, p.name);
            if (p.startAt === "Init") PM.startPlugin(p);
            // StartAt.DOMContentLoaded / WebpackReady: Vencord's own startAllPlugins() calls (src/Vencord.ts:149,182)
            // run later and iterate Plugins.plugins, so they start this plugin like any bundled one.
        }

        if (webpackAlreadyRunning) console.warn(TAG, "webpack was already initialised; some patches may miss modules");
        const result = { enabled, webpackAlreadyRunning };
        registrations[p.name] = result;
        console.log(TAG, `registered ${p.name}`, result);
        return result;
    }

    globalThis.__PeerLiveAddonRegister = p => {
        try {
            return registerLatePlugin(p);
        } catch (err) {
            console.error(TAG, `registration of ${p?.name} failed`, err);
            return { enabled: false, error: String(err) };
        }
    };
})();
