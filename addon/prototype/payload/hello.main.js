/*
 * PeerLive addon prototype - main-process natives of the PeerLiveAddonHello plugin.
 * Same contract as a Vencord plugin's native.ts: every exported function is an IPC handler whose first
 * argument is the IpcMainInvokeEvent. The loader registers each as ipcMain.handle("PeerLiveAddon_<plugin>_<name>")
 * and the renderer calls it as VencordNative.pluginHelpers.PeerLiveAddonHello.<name>(...args).
 */
"use strict";

exports.ping = (_event, message) => {
    const s = globalThis.__PeerLiveAddon ?? {};
    return {
        pong: String(message),
        mainPid: process.pid,
        vencordLoaded: !!s.vencordLoaded,
        rendererHooked: !!s.rendererHooked,
        metaPatched: s.metaPatched ?? null,
        cspMode: s.cspMode ?? null,
        cspApplied: s.cspApplied ?? 0,
        preloadFallback: !!s.preloadFallback,
        errors: s.errors?.length ?? 0
    };
};

/**
 * Shows the main side can own the display-media flow like PeerLive's native.ts does: installs a one-shot
 * handler on the caller's session that answers the next getDisplayMedia() with `sourceId`, then removes itself.
 */
exports.armDisplayMedia = (event, sourceId) => {
    if (typeof sourceId !== "string" || !/^(screen|window):-?\d{1,20}:-?\d{1,10}$/.test(sourceId))
        throw new Error(`invalid source id: ${String(sourceId)}`);

    const targetSession = event.sender.session;
    targetSession.setDisplayMediaRequestHandler((_request, callback) => {
        try {
            targetSession.setDisplayMediaRequestHandler(null);
        } catch { }
        try {
            callback({ video: { id: sourceId, name: "PeerLive addon test" } });
        } catch { }
    });
    return true;
};
