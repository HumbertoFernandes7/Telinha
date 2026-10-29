/*
 * node --require register.js <fake>/Local/Discord/app-X/resources/app.asar/index.js
 *
 * Makes `electron`, `electron/renderer` and `original-fs` resolve to the fakes, points process.execPath at the
 * fake app-X/Discord.exe (Vencord's persistAfterDiscordUpdates reads it), and after the entry (our stub) has
 * finished loading, drives the boot: app ready -> Discord window -> run the window's preload -> natives,
 * CSP, Discord-update persistence. Writes a JSON report to FAKE_REPORT and exits.
 */
"use strict";

const Module = require("module");
const path = require("path");

const FAKES = {
    "electron": path.join(__dirname, "electron-main.js"),
    "electron/main": path.join(__dirname, "electron-main.js"),
    "electron/common": path.join(__dirname, "electron-main.js"),
    "electron/renderer": path.join(__dirname, "electron-renderer.js"),
    "original-fs": path.join(__dirname, "original-fs.js")
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (Object.hasOwn(FAKES, request)) return FAKES[request];
    return originalResolve.call(this, request, ...rest);
};

Object.defineProperty(process, "execPath", { value: process.env.FAKE_DISCORD_EXE, writable: true, configurable: true });

const entry = process.argv[1];
setImmediate(() => require("./driver").run(entry).catch(err => {
    console.error(err);
    process.exit(2);
}));
