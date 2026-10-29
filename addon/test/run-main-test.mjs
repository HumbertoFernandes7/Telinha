/*
 * Offline test of the main-process chain with the REAL Telinha payload (dist/addon/payload) and a REAL Vencord build
 * (patcher.js + preload.js + renderer.js), on fake Discord trees under %TEMP%\tl-addon. Never touches the real
 * Discord or %APPDATA%: the Vencord build and the payload are only READ (copied into the scratch trees).
 *
 *   node addon/test/run-main-test.mjs [--vencord-dist <dir>] [--payload <dir>] [--no-helper-probe]
 *
 * S1 spawns the real telinha-audio.exe once with --probe (what the plugin does when asked for whole-screen audio
 * status); --no-helper-probe skips that.
 */
import { execFileSync, spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

import { ADDON, HERE, makeChecker, pickPayload, pickVencordDist, REPO, SCRATCH } from "./common.mjs";

const require = createRequire(import.meta.url);
const { buildStubAsar, readAsarFile } = require("../installer/asar.js");
const installer = require("../installer/install.js");
const { check, finish } = makeChecker();

const vencordSrc = pickVencordDist();
const payload = pickPayload();
const stubTemplate = readFileSync(join(payload.dir, payload.version.stubTemplate), "utf8");
const NATIVES = ["finishDisplayMedia", "listSources", "prepareDisplayMedia", "readScreenAudio", "resetDisplayMedia", "screenAudioStatus", "startScreenAudio", "stopScreenAudio"];

function copyVencord(src, name) {
    const dir = join(SCRATCH, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of ["patcher.js", "preload.js", "renderer.js"]) cpSync(join(src, f), join(dir, f));
    return dir;
}

mkdirSync(SCRATCH, { recursive: true });
const vencordCopy = copyVencord(vencordSrc, "vencord-under-test");
const vencordHeader = readFileSync(join(vencordCopy, "patcher.js"), "utf8").split("\n").slice(0, 4).join(" | ");
console.log(`Vencord under test: ${vencordSrc}\n  ${vencordHeader}\nPayload: ${payload.dir} (${payload.version.version}, ${payload.version.commit})\nScratch: ${SCRATCH}\n`);

const FAKE_DISCORD_BOOTSTRAP = `"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path");
globalThis.__fakeDiscord = { loaded: true, bwName: BrowserWindow.name };
app.on("ready", () => {
    globalThis.__fakeDiscord.win = new BrowserWindow({ title: "Discord", width: 1280, height: 720,
        webPreferences: { preload: path.join(__dirname, "..", "mainScreenPreload.js"), contextIsolation: true } });
});
`;

/** Fake machine: Local/Discord/app-1.0.9002 (+exploded stub), Roaming/Vencord/dist, Roaming/Telinha/addon */
function makeTree(name, { vencord = vencordCopy, renameChannels = false, dropPatcher = false, dropAddon = false, tamper = {} } = {}) {
    const root = join(SCRATCH, name);
    rmSync(root, { recursive: true, force: true });
    const appDir = join(root, "Local", "Discord", "app-1.0.9002");
    const res = join(appDir, "resources");
    const dist = join(root, "Roaming", "Vencord", "dist");
    const home = join(root, "Roaming", "Telinha");
    const addonDir = join(home, "addon");

    mkdirSync(join(res, "_app.asar", "app_bootstrap"), { recursive: true });
    writeFileSync(join(appDir, "Discord.exe"), "");
    writeFileSync(join(res, "_app.asar", "package.json"), JSON.stringify({ name: "discord", main: "app_bootstrap/index.js" }));
    writeFileSync(join(res, "_app.asar", "app_bootstrap", "index.js"), FAKE_DISCORD_BOOTSTRAP);
    writeFileSync(join(res, "_app.asar", "mainScreenPreload.js"), "globalThis.__fakeDiscordPreloadRan = true;\n");

    mkdirSync(dist, { recursive: true });
    for (const f of ["patcher.js", "preload.js", "renderer.js"]) {
        let code = readFileSync(join(vencord, f), "utf8");
        if (renameChannels) code = code.replaceAll("VencordPreloadGetRendererJs", "VencordPreloadGetRendererJsV2").replaceAll("VencordGetPluginIpcMethodMap", "VencordGetPluginIpcMethodMapV2");
        writeFileSync(join(dist, f), code);
    }
    if (dropPatcher) rmSync(join(dist, "patcher.js"));

    mkdirSync(addonDir, { recursive: true });
    for (const f of payload.files) cpSync(join(payload.dir, f), join(addonDir, f));
    for (const [f, content] of Object.entries(tamper)) writeFileSync(join(addonDir, f), content);
    if (dropAddon) rmSync(addonDir, { recursive: true, force: true });

    // exploded stub (Node can't require from inside an asar FILE; the driver swaps in the real asar file later)
    mkdirSync(join(res, "app.asar"), { recursive: true });
    writeFileSync(join(res, "app.asar", "index.js"), installer.renderStub(stubTemplate, join(addonDir, "main.js"), join(dist, "patcher.js")));
    writeFileSync(join(res, "app.asar", "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));

    return { root, appDir, res, dist, home, addonDir, logFile: join(home, "logs", "main.log") };
}

function boot(name, tree, extraEnv = {}) {
    const reportPath = join(tree.root, "report.json");
    const env = { ...process.env, FAKE_ROOT: tree.root, FAKE_REPORT: reportPath, FAKE_DISCORD_EXE: join(tree.appDir, "Discord.exe"), ...extraEnv };
    for (const k of ["VENCORD_USER_DATA_DIR", "DISCORD_USER_DATA_DIR", "DISABLE_UPDATER_AUTO_PATCHING", "TELINHA_HELPER_DIR", "TELINHA_VENCORD_PRELOAD"]) delete env[k];
    const r = spawnSync(process.execPath, ["--require", join(HERE, "fake", "register.js"), join(tree.res, "app.asar", "index.js")], { env, encoding: "utf8", timeout: 60_000 });
    const log = (r.stdout + r.stderr).trim();
    writeFileSync(join(tree.root, "boot.log"), log);
    if (!existsSync(reportPath)) {
        console.log(log);
        throw new Error(`${name}: no report (exit ${r.status})`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.log = log;
    report.mainLog = existsSync(tree.logFile) ? readFileSync(tree.logFile, "utf8") : "";
    if (report.error) console.log(`  [${name}] driver error:\n${report.error}`);
    return report;
}

const connectSrc = header => (header ?? "").split(";").map(s => s.trim()).find(s => s.startsWith("connect-src "))?.split(" ") ?? [];

// ---------------------------------------------------------------------------------------------- S1
console.log("S1 official Vencord + Telinha stub + real payload (primary path: IPC hooks)");
let relays = [];
{
    const t = makeTree("s1");
    const probe = !process.argv.includes("--no-helper-probe") && process.platform === "win32";
    const r = boot("s1", t, {
        FAKE_NEXT_APP: "app-1.0.9003", FAKE_SERVED_OUT: join(SCRATCH, "served-renderer-s1.js"), FAKE_UPDATE_RENDERER: join(t.dist, "renderer.js"),
        FAKE_EXERCISE_NATIVES: "1", ...(probe ? { FAKE_HELPER_PROBE: "1" } : {})
    });
    const a = r.addon ?? {};
    relays = r.cspSources ?? [];
    check("stub -> loader -> Vencord -> Discord loaded", r.afterLoad.discordLoaded && a.vencordLoaded);
    check("payload identity read (version.json)", a.version === payload.version.version && a.commit === payload.version.commit, { version: a.version, commit: a.commit });
    check("Vencord re-pointed app path to _app.asar", r.afterLoad.appPath === join(t.res, "_app.asar"), r.afterLoad.appPath);
    check("both IPC hooks fired and ipcMain.on restored", a.rendererHooked && a.ipcMapHooked && r.afterLoad.ipcOnRestored, a);
    check("Discord sees a class named BrowserWindow", r.afterLoad.discordSawBrowserWindowName === "BrowserWindow");
    check("window chain Vencord -> Telinha(dormant) -> Electron", JSON.stringify(r.window?.ctorChain).startsWith('["BrowserWindow(vencord)","BrowserWindow(telinha)"'), r.window?.ctorChain);
    check("window still listed by getAllWindows()", r.window?.listedByGetAllWindows);
    check("window preload = Vencord's (fallback dormant)", r.window?.preload === join(t.dist, "preload.js") && !a.preloadFallback, r.window?.preload);
    check("DISCORD_PRELOAD = Discord's original preload", r.window?.env.DISCORD_PRELOAD === join(t.res, "_app.asar", "mainScreenPreload.js"));
    check("real Vencord preload ran Discord's preload", r.preload?.discordPreloadRan);
    check("ONE executeJavaScript: Vencord renderer then Telinha", r.preload?.executedScripts === 1 && r.preload?.hasVencordRenderer && r.preload?.hasAddonRenderer && r.preload?.addonAfterVencord, r.preload);
    check("PluginMeta entry injected", r.preload?.pluginMetaEntry && a.metaPatched === true, a.metaReason);
    check("Vencord renderer read fresh (update picked up)", r.preload?.sawVencordUpdate);
    check(`VencordNative.pluginHelpers.Telinha = the ${NATIVES.length} natives of native.ts`, JSON.stringify([...(r.preload?.telinhaHelpers ?? [])].sort()) === JSON.stringify(NATIVES), r.preload?.telinhaHelpers);
    check("TELINHA_HELPER_DIR = our addon folder (where telinha-audio.exe is)", r.helperDir === t.addonDir && a.helperDir === t.addonDir, r.helperDir);
    check("listSources round-trip through our IPC handler", JSON.stringify(r.natives?.listSources) === '{"sources":[]}', r.natives?.listSources);
    check("display media: prepare -> Electron handler answers our source -> finish removes it",
        r.natives?.prepare === true && r.natives?.displayMediaAnswer?.video?.id === "window:123:0" && r.natives?.finish?.handlerCalled === true && r.natives?.handlerRemovedAfterUse, r.natives);
    check("natives refuse non-Discord frames", r.natives?.untrustedFrame === "rejected");
    if (probe) {
        const st = r.natives?.screenAudio;
        console.log(`        (telinha-audio.exe --probe from the addon folder: ${JSON.stringify(st)})`);
        check("whole-screen audio helper found and run from OUR folder", st && !/não foi instalado|não foi encontrado/.test(st.reason ?? ""), st);
    }
    check("CSP: one listener (Vencord's) wrapped by ours", r.csp.installs === 1 && r.csp.mode === "chained" && r.csp.methodIsVencordNoopNow, r.csp);
    const connect = connectSrc(r.csp.header);
    check(`CSP: the ${relays.length} relays from native.ts in connect-src`, relays.length === 8 && relays.every(u => connect.includes(u)), connect);
    check("CSP: Vencord's own rewrite still there", /script-src [^;]*'unsafe-eval'/.test(r.csp.header) && connect.includes("vencord:") && connect.includes("api.github.com"), r.csp.header);
    check("CSP: Vencord stylesheet content-type fix intact", r.csp.stylesheetContentType === "text/css");
    check("Discord update: Vencord copied OUR stub into app-1.0.9003", r.persist?.newAppAsarIsOurStub && r.persist.newIndexIsTelinhaStub && r.persist.newOriginalMovedTo_app, r.persist);
    check("no add-on errors", (a.errors ?? []).length === 0, a.errors);
    check("main.log: boot + loaded with 8 natives + CSP chained", /\] boot /.test(r.mainLog) && /loaded .*"natives":8/.test(r.mainLog) && /CSP: added 8 sources \(chained\)/.test(r.mainLog), r.mainLog.slice(-600));
}

// ---------------------------------------------------------------------------------------------- S2
console.log("\nS2 future Vencord with renamed IPC channels (fallback: preload wrapper)");
{
    const t = makeTree("s2", { renameChannels: true });
    const r = boot("s2", t);
    const a = r.addon ?? {};
    check("hooks did not fire (channels renamed)", !a.rendererHooked && !a.ipcMapHooked);
    check("Discord + Vencord still loaded", r.afterLoad.discordLoaded && a.vencordLoaded);
    check("fallback swapped in our preload", a.preloadFallback && r.window?.preload === join(t.addonDir, "preload.js"), r.window?.preload);
    check("our preload chained Vencord's preload", r.window?.env.TELINHA_VENCORD_PRELOAD === join(t.dist, "preload.js") && r.preload?.discordPreloadRan);
    check("two scripts: Vencord renderer, then Telinha", r.preload?.executedScripts === 2 && r.preload?.addonAfterVencord, r.preload);
    check("VencordNative.pluginHelpers.Telinha still provided (what the plugin calls)", JSON.stringify([...(r.preload?.telinhaHelpers ?? [])].sort()) === JSON.stringify(NATIVES) && JSON.stringify(r.natives?.listSources) === '{"sources":[]}', r.preload);
    check("window.TelinhaNative exposed too", r.preload?.telinhaNative?.includes("listSources"));
    check("CSP still chained", r.csp.mode === "chained");
    check("main.log mentions the fallback", /preload fallback active/.test(r.mainLog));
}

// ---------------------------------------------------------------------------------------------- S3
console.log("\nS3 Vencord files missing (stub must not brick Discord)");
{
    const t = makeTree("s3", { dropPatcher: true });
    const r = boot("s3", t);
    check("Discord started vanilla", r.afterLoad.discordLoaded && r.addon?.vanillaFallback && r.afterLoad.appPath === join(t.res, "_app.asar"), r.afterLoad);
    check("window keeps Discord's own preload", r.window?.preload === join(t.res, "_app.asar", "mainScreenPreload.js"), r.window?.preload);
    check("main.log says why", /Vencord failed to load, starting Discord without mods/.test(r.mainLog));
}

// ---------------------------------------------------------------------------------------------- S4
console.log("\nS4 Telinha folder removed but our stub left behind");
{
    const t = makeTree("s4", { dropAddon: true });
    const r = boot("s4", t);
    check("stub falls through to plain Vencord", r.afterLoad.discordLoaded && r.addon === null && r.window?.preload === join(t.dist, "preload.js"), r.window);
}

// ---------------------------------------------------------------------------------------------- S5
console.log("\nS5 broken loader (main.js throws while loading)");
{
    const t = makeTree("s5", { tamper: { "main.js": "throw new Error('simulated broken loader');\n" } });
    const r = boot("s5", t);
    check("stub falls through to plain Vencord", r.afterLoad.discordLoaded && r.addon === null && r.window?.preload === join(t.dist, "preload.js") && r.preload?.hasVencordRenderer, r.window);
    check("stub logged the loader failure", /\[Telinha\] loader failed to load/.test(r.log));
}

// ---------------------------------------------------------------------------------------------- S6
console.log("\nS6 broken natives (telinha.main.js throws)");
{
    const t = makeTree("s6", { tamper: { "telinha.main.js": "throw new Error('simulated broken natives');\n" } });
    const r = boot("s6", t);
    const a = r.addon ?? {};
    check("Discord + Vencord + Telinha renderer still loaded", r.afterLoad.discordLoaded && a.vencordLoaded && a.rendererHooked && r.preload?.hasAddonRenderer, a);
    check("no natives registered, error recorded and logged", a.nativeChannels?.length === 0 && a.errors?.some(e => e.startsWith("natives:")) && /ERROR natives:/.test(r.mainLog), a.errors);
    check("pluginHelpers.Telinha left out (the plugin then says its native part is not loaded)", r.preload && !r.preload.pluginHelpers.includes("Telinha"), r.preload?.pluginHelpers);
}

// ---------------------------------------------------------------------------------------------- S7
const forkDist = join(REPO, "dist");
if (existsSync(join(forkDist, "patcher.js")) && readFileSync(join(forkDist, "renderer.js"), "utf8").includes('name:"Telinha"')) {
    console.log("\nS7 Vencord build that already bundles Telinha (this repo's fork build in dist/): add-on stays passive");
    const t = makeTree("s7", { vencord: copyVencord(forkDist, "vencord-fork") });
    const r = boot("s7", t);
    const a = r.addon ?? {};
    check("Discord + Vencord loaded, hooks fired", r.afterLoad.discordLoaded && a.vencordLoaded && a.rendererHooked && a.ipcMapHooked);
    check("Vencord's own Telinha natives kept (not replaced by ours)", a.vencordBundlesPlugin === true && r.preload?.telinhaHelpers?.length >= NATIVES.length && JSON.stringify(r.natives?.listSources) === '{"sources":[]}', { bundles: a.vencordBundlesPlugin, helpers: r.preload?.telinhaHelpers });
    check("main.log says the add-on stays passive", /already bundles Telinha; the add-on stays passive/.test(r.mainLog));
} else console.log("\nS7 skipped (no fork build with Telinha in dist/)");

// ---------------------------------------------------------------------------------------------- installer
console.log("\nDev installer on a fake tree (asar files, like the real machine)");
{
    const root = join(SCRATCH, "inst");
    rmSync(root, { recursive: true, force: true });
    const discord = join(root, "Local", "Discord");
    const appdata = join(root, "Roaming");
    const patcher = join(appdata, "Vencord", "dist", "patcher.js");
    mkdirSync(dirname(patcher), { recursive: true });
    writeFileSync(patcher, "// fake");
    for (const v of ["app-1.0.9188", "app-1.0.9266"]) mkdirSync(join(discord, v, "resources"), { recursive: true });
    writeFileSync(join(discord, "app-1.0.9188", "resources", "app.asar"), Buffer.alloc(100 * 1024)); // old, unpatched
    const res = join(discord, "app-1.0.9266", "resources");
    writeFileSync(join(res, "_app.asar"), Buffer.alloc(100 * 1024));
    const vencordStub = buildStubAsar("require(" + JSON.stringify(patcher) + ")");
    writeFileSync(join(res, "app.asar"), vencordStub);
    const home = join(appdata, "Telinha");
    const args = { discord, appdata, payload: payload.dir };

    const st = installer.status(args);
    check("status: Vencord stub on newest app-*, regenerates byte-identically", st.apps.at(-1).kind === "vencord-stub" && st.apps.at(-1).vencordStubCanonical === true && st.apps[0].kind === "discord-original", st.apps);
    const ins = installer.install(args);
    const after = installer.inspect(res);
    check("install: our stub written, Vencord path kept", after.kind === "telinha-stub" && after.vencordPatcher === patcher && after.telinhaLoader === join(home, "addon", "main.js"), ins);
    check("install: Vencord stub backed up (backup/Discord/app-1.0.9266.app.asar)", Buffer.compare(readFileSync(join(home, "backup", "Discord", "app-1.0.9266.app.asar")), vencordStub) === 0);
    check("install: payload copied and verified (every version.json file)", payload.files.every(f => existsSync(join(home, "addon", f))) && installer.verifyPayload(join(home, "addon")).commit === payload.version.commit);
    check("install: install.json records the target", JSON.parse(readFileSync(join(home, "install.json"), "utf8")).targets.some(x => x.app === "app-1.0.9266" && x.previous === "vencord-stub"));
    check("install: old app-* left alone", installer.inspect(join(discord, "app-1.0.9188", "resources")).kind === "discord-original");
    const stubIndex = readAsarFile(join(res, "app.asar"), "index.js");
    check("stub = payload template with the two paths, nothing else", stubIndex === installer.renderStub(stubTemplate, join(home, "addon", "main.js"), patcher) && stubIndex.startsWith("// Telinha stub v1"));
    installer.install(args);
    check("install again = repair (idempotent), backup still Vencord's", installer.inspect(res).kind === "telinha-stub" && Buffer.compare(readFileSync(join(home, "backup", "Discord", "app-1.0.9266.app.asar")), vencordStub) === 0);
    // Vencord installer "Repair": unpatch + patch -> writes its own stub again
    writeFileSync(join(res, "app.asar"), vencordStub);
    installer.install(args);
    check("after Vencord installer repair, our install restores Telinha", installer.inspect(res).kind === "telinha-stub");

    // corrupted payload: refused, previous install untouched
    const bad = join(root, "bad-payload");
    cpSync(payload.dir, bad, { recursive: true });
    writeFileSync(join(bad, "telinha.renderer.js"), "tampered");
    let refusedBad = false;
    try { installer.install({ ...args, payload: bad }); } catch (e) { refusedBad = /corrupted/.test(e.message); }
    check("corrupted payload refused (SHA-256), installed addon intact", refusedBad && installer.verifyPayload(join(home, "addon")).commit === payload.version.commit);

    // Discord updates: Vencord copies our stub into a new app-* (no backup there)
    const res2 = join(discord, "app-1.0.9300", "resources");
    mkdirSync(res2, { recursive: true });
    writeFileSync(join(res2, "_app.asar"), Buffer.alloc(100 * 1024));
    writeFileSync(join(res2, "app.asar"), readFileSync(join(res, "app.asar")));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", "main.log"), "x\n");

    const un = installer.uninstall(args);
    check("uninstall: both folders restored to Vencord's stub, byte-identical", Buffer.compare(readFileSync(join(res, "app.asar")), vencordStub) === 0 && Buffer.compare(readFileSync(join(res2, "app.asar")), vencordStub) === 0, un);
    check("uninstall: from backup where there was one, regenerated elsewhere", JSON.stringify(un.restored.map(x => [x.app, x.from, x.sameAsVencordInstallerOutput])) === '[["app-1.0.9266","backup",true],["app-1.0.9300","regenerated",true]]', un.restored);
    check("uninstall: addon, backup, install.json removed; logs kept", !existsSync(join(home, "addon")) && !existsSync(join(home, "backup")) && !existsSync(join(home, "install.json")) && existsSync(join(home, "logs", "main.log")));
    installer.uninstall({ ...args, purge: true });
    check("uninstall --purge removes %APPDATA%\\Telinha entirely", !existsSync(home));

    rmSync(join(res2, "_app.asar"));
    let refused = false;
    try { installer.install(args); } catch (e) { refused = /official Vencord is not installed/.test(e.message); }
    check("install refuses without official Vencord (_app.asar missing)", refused);
    let guarded = false;
    try {
        execFileSync(process.execPath, [join(ADDON, "installer", "install.js"), "install", "--discord", join(process.env.LOCALAPPDATA ?? "C:/none", "Discord"), "--appdata", appdata], { stdio: "pipe" });
    } catch (e) { guarded = /without --real/.test(String(e.stderr)); }
    check("CLI refuses the real Discord folder without --real", guarded);
}

finish();
