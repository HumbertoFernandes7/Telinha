/*
 * Telinha add-on - FALLBACK preload. Only used when the main-process renderer hook did not fire (main.js swaps it
 * in for Vencord's preload, e.g. if a future Vencord renamed its IPC channels). Runs Vencord's preload unchanged
 * (VencordNative, Vencord's renderer, Discord's own preload via DISCORD_PRELOAD), then queues our renderer.
 * webFrame.executeJavaScript calls run in order, so ours runs after Vencord's and before Discord's scripts.
 *
 * Natives: the plugin calls VencordNative.pluginHelpers.Telinha.*. When the main-process IPC-map hook did not fire
 * either, we add our methods to the VencordNative object right before Vencord's preload exposes it. They are also
 * exposed as window.TelinhaNative.
 */
"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron/renderer");

let info = null;
if (location.protocol !== "data:") {
    try {
        info = ipcRenderer.sendSync("TelinhaAddonPreloadInfo");
    } catch (err) {
        console.error("[Telinha] addon: fallback preload could not reach main", err);
    }
}

const api = {};
for (const [method, channel] of Object.entries(info?.methods ?? {}))
    api[method] = (...args) => ipcRenderer.invoke(channel, ...args);

if (info && !info.ipcMapHooked && Object.keys(api).length) {
    const expose = contextBridge.exposeInMainWorld;
    contextBridge.exposeInMainWorld = function (key, value) {
        if (key === "VencordNative" && value?.pluginHelpers && !value.pluginHelpers[info.pluginName])
            value.pluginHelpers[info.pluginName] = api;
        return expose.call(this, key, value);
    };
}

const vencordPreload = process.env.TELINHA_VENCORD_PRELOAD;
if (vencordPreload) require(vencordPreload);

if (info) {
    try {
        contextBridge.exposeInMainWorld("TelinhaNative", api);
        if (info.rendererJs) webFrame.executeJavaScript(info.rendererJs);
    } catch (err) {
        console.error("[Telinha] addon: fallback preload failed", err);
    }
}
