/*
 * Drives one boot of the fake Discord after the stub was required (see register.js). Everything observed goes
 * into the JSON report; assertions live in run-main-test.mjs.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const tick = () => new Promise(r => setImmediate(r));

function ctorChain(obj) {
    const names = [];
    for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        const file = p.constructor?.toString().includes("PEERLIVE_VENCORD_PRELOAD") ? "peerlive" :
            p.constructor?.toString().includes("DISCORD_PRELOAD") ? "vencord" : "electron/other";
        names.push(`${p.constructor?.name}(${file})`);
    }
    return names;
}

async function run(entry) {
    const electron = require("electron"); // the fake, as the cache holds it now (possibly replaced exports)
    const fakeCore = require(path.join(__dirname, "electron-main.js")); // same module object
    const renderer = require("electron/renderer");
    const { buildStubAsar, readAsarFile } = require("../../installer/asar");

    const report = { entry, steps: [] };
    const addon = () => globalThis.__PeerLiveAddon ? JSON.parse(JSON.stringify(globalThis.__PeerLiveAddon)) : null;

    try {
        const { app, ipcMain } = fakeCore;
        report.afterLoad = {
            discordLoaded: !!globalThis.__fakeDiscord?.loaded,
            discordSawBrowserWindowName: globalThis.__fakeDiscord?.bwName ?? null,
            appPath: app.appPath,
            requireMainFilename: require.main.filename,
            ipcOnRestored: !Object.hasOwn(ipcMain, "on"),
            electronExportsReplaced: electron.BrowserWindow !== fakeCore.BrowserWindow || require.cache[require.resolve("electron")].exports !== fakeCore,
            addon: addon()
        };

        app.becomeReady();
        await tick();
        await tick();

        const win = globalThis.__fakeDiscord?.win;
        report.window = win ? {
            preload: win.options.webPreferences.preload,
            sandbox: win.options.webPreferences.sandbox,
            ctorChain: ctorChain(win),
            listedByGetAllWindows: fakeCore.BrowserWindow.getAllWindows().includes(win),
            env: { DISCORD_PRELOAD: process.env.DISCORD_PRELOAD ?? null, PEERLIVE_VENCORD_PRELOAD: process.env.PEERLIVE_VENCORD_PRELOAD ?? null }
        } : null;

        // Optional: simulate a Vencord update of renderer.js between boot and window load
        if (process.env.FAKE_UPDATE_RENDERER) fs.appendFileSync(process.env.FAKE_UPDATE_RENDERER, "\n// FAKE_VENCORD_UPDATE_MARKER\n");

        // --- renderer process: run the preload the window ended up with
        if (win) {
            globalThis.location = { protocol: "https:", href: "https://discord.com/app" };
            require(win.options.webPreferences.preload);
            const all = renderer.executed.join("\n;\n");
            const helpers = renderer.exposed.VencordNative?.pluginHelpers ?? {};
            report.preload = {
                exposed: Object.keys(renderer.exposed),
                executedScripts: renderer.executed.length,
                discordPreloadRan: !!globalThis.__fakeDiscordPreloadRan,
                pluginHelpers: Object.keys(helpers),
                addonHelpers: Object.keys(helpers.PeerLiveAddonHello ?? {}),
                peerLiveNative: Object.keys(renderer.exposed.PeerLiveNative ?? {}),
                hasVencordRenderer: all.includes("var Vencord="),
                hasAddonRenderer: all.includes("__PeerLiveAddonBoot"),
                addonAfterVencord: all.indexOf("__PeerLiveAddonBoot") > all.indexOf("var Vencord="),
                pluginMetaEntry: all.includes('"PeerLiveAddonHello":{"folderName":"peerlive-addon","userPlugin":true}'),
                sawVencordUpdate: all.includes("FAKE_VENCORD_UPDATE_MARKER")
            };
            if (process.env.FAKE_SERVED_OUT) fs.writeFileSync(process.env.FAKE_SERVED_OUT, all);

            // --- natives through whatever the page would use
            const api = helpers.PeerLiveAddonHello ?? renderer.exposed.PeerLiveNative;
            if (api) {
                report.natives = { ping: await api.ping("from-test") };
                report.natives.arm = await api.armDisplayMedia("window:123:0");
                const ses = fakeCore.session.defaultSession;
                let answer;
                ses.displayMediaHandler({ audioRequested: false }, v => (answer = v));
                report.natives.displayMediaAnswer = answer;
                report.natives.handlerRemovedAfterUse = ses.displayMediaHandler === null;
                try {
                    await ipcMain.invoke("PeerLiveAddon_PeerLiveAddonHello_ping", {}, "https://evil.example/", "x");
                    report.natives.untrustedFrame = "accepted";
                } catch {
                    report.natives.untrustedFrame = "rejected";
                }
            }
        }

        // --- CSP: Discord-like main frame response through the single installed listener
        const webRequest = fakeCore.session.defaultSession.webRequest;
        report.csp = { installs: webRequest.installs, mode: addon()?.cspMode ?? null, methodIsVencordNoopNow: String(webRequest.onHeadersReceived).replace(/\s/g, "") === "()=>{}" };
        if (webRequest.listener) {
            const headers = { "Content-Security-Policy": ["default-src 'self'; script-src 'self' 'unsafe-inline' https://discord.com; connect-src 'self' https://discord.com wss://gateway.discord.gg; style-src 'self'"] };
            const main = await new Promise(r => webRequest.listener({ resourceType: "mainFrame", url: "https://discord.com/app", responseHeaders: headers }, r));
            report.csp.header = main.responseHeaders["Content-Security-Policy"][0];
            const css = await new Promise(r => webRequest.listener({ resourceType: "stylesheet", url: "https://raw.githubusercontent.com/x.css", responseHeaders: { "Content-Type": ["text/plain"] } }, r));
            report.csp.stylesheetContentType = css.responseHeaders["Content-Type"][0];
        }

        // --- Discord update: app-NEXT appears; Vencord's persistAfterDiscordUpdates runs on before-quit
        if (process.env.FAKE_NEXT_APP && fs.existsSync(path.join(path.dirname(entry), "index.js"))) {
            const oldRes = path.dirname(path.dirname(entry)); // .../app-X/resources
            const newRes = path.join(path.dirname(path.dirname(oldRes)), process.env.FAKE_NEXT_APP, "resources");
            fs.mkdirSync(newRes, { recursive: true });
            fs.writeFileSync(path.join(newRes, "app.asar"), "NEW DISCORD ORIGINAL ASAR");
            // what is really on disk on Windows: the stub as an asar FILE (the test booted an exploded copy)
            const stubIndex = fs.readFileSync(path.join(oldRes, "app.asar", "index.js"), "utf8");
            const stubBytes = buildStubAsar(stubIndex);
            fs.rmSync(path.join(oldRes, "app.asar"), { recursive: true, force: true });
            fs.writeFileSync(path.join(oldRes, "app.asar"), stubBytes);

            app.emit("before-quit");

            const newAsar = path.join(newRes, "app.asar");
            report.persist = {
                newAppAsarIsOurStub: fs.existsSync(newAsar) && Buffer.compare(fs.readFileSync(newAsar), stubBytes) === 0,
                newIndexIsPeerLiveStub: (readAsarFile(newAsar, "index.js") ?? "").startsWith("// PeerLive stub"),
                newOriginalMovedTo_app: fs.existsSync(path.join(newRes, "_app.asar")) && fs.readFileSync(path.join(newRes, "_app.asar"), "utf8") === "NEW DISCORD ORIGINAL ASAR"
            };
        }

        report.addon = addon();
    } catch (err) {
        report.error = String(err?.stack ?? err);
    }

    fs.writeFileSync(process.env.FAKE_REPORT, JSON.stringify(report, null, 2));
    process.exit(0);
}

module.exports = { run };
