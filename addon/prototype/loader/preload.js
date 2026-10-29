/*
 * PeerLive addon prototype - FALLBACK preload. Only used when the main-process renderer hook did not fire
 * (main.js swaps it in for Vencord's preload). Runs Vencord's preload unchanged (VencordNative, Vencord's
 * renderer, Discord's own preload via DISCORD_PRELOAD), then exposes our natives and queues our renderer.
 * webFrame.executeJavaScript calls run in order, so ours runs after Vencord's and before Discord's scripts.
 */
"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron/renderer");

const vencordPreload = process.env.PEERLIVE_VENCORD_PRELOAD;
if (vencordPreload) require(vencordPreload);

if (location.protocol !== "data:") {
    try {
        const info = ipcRenderer.sendSync("PeerLiveAddonPreloadInfo");
        const api = {};
        for (const [method, channel] of Object.entries(info.methods ?? {}))
            api[method] = (...args) => ipcRenderer.invoke(channel, ...args);
        contextBridge.exposeInMainWorld("PeerLiveNative", api);
        if (info.rendererJs) webFrame.executeJavaScript(info.rendererJs);
    } catch (err) {
        console.error("[PeerLiveAddon] fallback preload failed", err);
    }
}
