/*
 * Fake `electron/renderer` used to run the REAL Vencord preload.js (and our fallback preload) inside the same
 * Node process as the fake main process: sendSync/invoke go straight to the fake ipcMain listeners/handlers.
 */
"use strict";

const main = require("electron"); // resolves to the fake main module

const sender = main.webContents.fromId(1);
const exposed = {};
const executed = [];

module.exports = {
    exposed,
    executed,
    contextBridge: {
        exposeInMainWorld(key, api) {
            exposed[key] = api;
        }
    },
    ipcRenderer: {
        sendSync: (channel, ...args) => main.ipcMain.sendSync(channel, sender, ...args),
        invoke: (channel, ...args) => main.ipcMain.invoke(channel, sender, "https://discord.com/app", ...args),
        on() { },
        once() { },
        send() { },
        removeListener() { }
    },
    webFrame: {
        executeJavaScript(code) {
            executed.push(String(code));
            return Promise.resolve();
        }
    }
};
