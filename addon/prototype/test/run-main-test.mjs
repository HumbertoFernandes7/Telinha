/*
 * Offline test of the main-process chain, using a REAL Vencord build (patcher.js + preload.js + renderer.js)
 * and fake Discord trees under %TEMP%\pl-addon. Never touches the real Discord or %APPDATA%\Vencord: the Vencord
 * build is only READ (copied into the scratch tree).
 *
 *   node addon/prototype/test/run-main-test.mjs [--vencord-dist <dir with patcher.js, preload.js, renderer.js>]
 *
 * Default Vencord build: %APPDATA%\Vencord\dist.backup-oficial-* (official release, if present), else ./dist.
 */
import { execFileSync, spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = resolve(HERE, "..");
const REPO = resolve(PROTO, "..", "..");
const SCRATCH = join(tmpdir(), "pl-addon");

const { buildStubAsar, readAsarFile } = require("../installer/asar.js");
const installer = require("../installer/install.js");

function pickVencordDist() {
    const i = process.argv.indexOf("--vencord-dist");
    if (i !== -1) return resolve(process.argv[i + 1]);
    const roaming = process.env.APPDATA && join(process.env.APPDATA, "Vencord");
    const official = roaming && existsSync(roaming) && readdirSync(roaming).find(d => d.startsWith("dist.backup-oficial"));
    return official ? join(roaming, official) : join(REPO, "dist");
}

let failures = 0;
const check = (label, cond, extra) => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
    if (!cond) failures++;
};

// ---------------------------------------------------------------------------------------------- setup
const vencordSrc = pickVencordDist();
const vencordCopy = join(SCRATCH, "vencord-under-test");
rmSync(vencordCopy, { recursive: true, force: true });
mkdirSync(vencordCopy, { recursive: true });
for (const f of ["patcher.js", "preload.js", "renderer.js"]) cpSync(join(vencordSrc, f), join(vencordCopy, f));
const vencordHeader = readFileSync(join(vencordCopy, "patcher.js"), "utf8").split("\n").slice(0, 4).join(" | ");
console.log(`Vencord under test: ${vencordSrc}\n  ${vencordHeader}\nScratch: ${SCRATCH}\n`);

const FAKE_DISCORD_BOOTSTRAP = `"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path");
globalThis.__fakeDiscord = { loaded: true, bwName: BrowserWindow.name };
app.on("ready", () => {
    globalThis.__fakeDiscord.win = new BrowserWindow({ title: "Discord", width: 1280, height: 720,
        webPreferences: { preload: path.join(__dirname, "..", "mainScreenPreload.js"), contextIsolation: true } });
});
`;

/** Fake machine: Local/Discord/app-1.0.9002 (+exploded stub), Roaming/Vencord/dist, Roaming/PeerLive/addon */
function makeTree(name, { renameChannels = false, dropPatcher = false, dropAddon = false, payloadDir = join(PROTO, "payload") } = {}) {
    const root = join(SCRATCH, "main-" + name);
    rmSync(root, { recursive: true, force: true });
    const appDir = join(root, "Local", "Discord", "app-1.0.9002");
    const res = join(appDir, "resources");
    const dist = join(root, "Roaming", "Vencord", "dist");
    const addonDir = join(root, "Roaming", "PeerLive", "addon");

    mkdirSync(join(res, "_app.asar", "app_bootstrap"), { recursive: true });
    writeFileSync(join(appDir, "Discord.exe"), "");
    writeFileSync(join(res, "_app.asar", "package.json"), JSON.stringify({ name: "discord", main: "app_bootstrap/index.js" }));
    writeFileSync(join(res, "_app.asar", "app_bootstrap", "index.js"), FAKE_DISCORD_BOOTSTRAP);
    writeFileSync(join(res, "_app.asar", "mainScreenPreload.js"), "globalThis.__fakeDiscordPreloadRan = true;\n");

    mkdirSync(dist, { recursive: true });
    for (const f of ["patcher.js", "preload.js", "renderer.js"]) {
        let code = readFileSync(join(vencordCopy, f), "utf8");
        if (renameChannels) code = code.replaceAll("VencordPreloadGetRendererJs", "VencordPreloadGetRendererJsV2").replaceAll("VencordGetPluginIpcMethodMap", "VencordGetPluginIpcMethodMapV2");
        writeFileSync(join(dist, f), code);
    }
    if (dropPatcher) rmSync(join(dist, "patcher.js"));

    mkdirSync(addonDir, { recursive: true });
    for (const d of [join(PROTO, "loader"), payloadDir]) for (const f of readdirSync(d)) cpSync(join(d, f), join(addonDir, f));
    if (dropAddon) rmSync(addonDir, { recursive: true, force: true });

    // exploded stub (Node can't require from inside an asar FILE; driver swaps in the real asar file later)
    mkdirSync(join(res, "app.asar"), { recursive: true });
    writeFileSync(join(res, "app.asar", "index.js"), installer.renderStub(join(addonDir, "main.js"), join(dist, "patcher.js")));
    writeFileSync(join(res, "app.asar", "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));

    return { root, appDir, res, dist, addonDir };
}

function boot(name, tree, extraEnv = {}) {
    const reportPath = join(tree.root, "report.json");
    const env = { ...process.env, FAKE_ROOT: tree.root, FAKE_REPORT: reportPath, FAKE_DISCORD_EXE: join(tree.appDir, "Discord.exe"), ...extraEnv };
    delete env.VENCORD_USER_DATA_DIR;
    delete env.DISCORD_USER_DATA_DIR;
    delete env.DISABLE_UPDATER_AUTO_PATCHING;
    const r = spawnSync(process.execPath, ["--require", join(HERE, "fake", "register.js"), join(tree.res, "app.asar", "index.js")], { env, encoding: "utf8", timeout: 60_000 });
    const log = (r.stdout + r.stderr).trim();
    writeFileSync(join(tree.root, "boot.log"), log);
    if (!existsSync(reportPath)) {
        console.log(log);
        throw new Error(`${name}: no report (exit ${r.status})`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.log = log;
    if (report.error) console.log(`  [${name}] driver error:\n${report.error}`);
    return report;
}

// ---------------------------------------------------------------------------------------------- S1
console.log("S1 official Vencord + PeerLive stub (primary path: IPC hooks)");
{
    const t = makeTree("s1");
    const r = boot("s1", t, { FAKE_NEXT_APP: "app-1.0.9003", FAKE_SERVED_OUT: join(SCRATCH, "served-renderer-s1.js"), FAKE_UPDATE_RENDERER: join(t.dist, "renderer.js") });
    const a = r.addon ?? {};
    check("stub -> loader -> Vencord -> Discord loaded", r.afterLoad.discordLoaded && a.vencordLoaded);
    check("Vencord re-pointed app path to _app.asar", r.afterLoad.appPath === join(t.res, "_app.asar"), r.afterLoad.appPath);
    check("both IPC hooks fired and ipcMain.on restored", a.rendererHooked && a.ipcMapHooked && r.afterLoad.ipcOnRestored, a);
    check("Discord sees a class named BrowserWindow", r.afterLoad.discordSawBrowserWindowName === "BrowserWindow");
    check("window chain Vencord -> PeerLive(dormant) -> Electron", JSON.stringify(r.window?.ctorChain).startsWith('["BrowserWindow(vencord)","BrowserWindow(peerlive)"'), r.window?.ctorChain);
    check("window still listed by getAllWindows()", r.window?.listedByGetAllWindows);
    check("window preload = Vencord's (fallback dormant)", r.window?.preload === join(t.dist, "preload.js") && !a.preloadFallback, r.window?.preload);
    check("DISCORD_PRELOAD = Discord's original preload", r.window?.env.DISCORD_PRELOAD === join(t.res, "_app.asar", "mainScreenPreload.js"));
    check("real Vencord preload ran Discord's preload", r.preload?.discordPreloadRan);
    check("ONE executeJavaScript: Vencord renderer then addon", r.preload?.executedScripts === 1 && r.preload?.hasVencordRenderer && r.preload?.hasAddonRenderer && r.preload?.addonAfterVencord, r.preload);
    check("PluginMeta entry injected", r.preload?.pluginMetaEntry && a.metaPatched === true, a.metaReason);
    check("Vencord renderer read fresh (update picked up)", r.preload?.sawVencordUpdate);
    check("VencordNative.pluginHelpers.PeerLiveAddonHello = {ping, armDisplayMedia}", JSON.stringify(r.preload?.addonHelpers) === '["ping","armDisplayMedia"]', r.preload?.addonHelpers);
    check("native ping round-trip via pluginHelpers", r.natives?.ping?.pong === "from-test" && r.natives.ping.vencordLoaded, r.natives?.ping);
    check("display-media handler installed by addon main code", r.natives?.arm === true && r.natives.displayMediaAnswer?.video?.id === "window:123:0" && r.natives.handlerRemovedAfterUse, r.natives);
    check("natives refuse non-Discord frames", r.natives?.untrustedFrame === "rejected");
    check("CSP: one listener (Vencord's) wrapped by ours", r.csp.installs === 1 && r.csp.mode === "chained" && r.csp.methodIsVencordNoopNow, r.csp);
    const relays = Object.keys(JSON.parse(readFileSync(join(PROTO, "payload", "addon.json"), "utf8")).csp);
    const connect = (r.csp.header ?? "").split(";").map(s => s.trim()).find(s => s.startsWith("connect-src ")) ?? "";
    check("CSP: all 8 relays in connect-src", relays.length === 8 && relays.every(u => connect.split(" ").includes(u)), connect);
    check("CSP: Vencord's own rewrite still there", /script-src [^;]*'unsafe-eval'/.test(r.csp.header) && connect.split(" ").includes("vencord:") && connect.split(" ").includes("api.github.com"), r.csp.header);
    check("CSP: Vencord stylesheet content-type fix intact", r.csp.stylesheetContentType === "text/css");
    check("Discord update: Vencord copied OUR stub into app-1.0.9003", r.persist?.newAppAsarIsOurStub && r.persist.newIndexIsPeerLiveStub && r.persist.newOriginalMovedTo_app, r.persist);
    check("no addon errors", (a.errors ?? []).length === 0, a.errors);
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
    check("our preload chained Vencord's preload", r.window?.env.PEERLIVE_VENCORD_PRELOAD === join(t.dist, "preload.js") && r.preload?.discordPreloadRan);
    check("two scripts: Vencord renderer, then addon", r.preload?.executedScripts === 2 && r.preload?.addonAfterVencord, r.preload);
    check("window.PeerLiveNative exposed, ping works", r.preload?.peerLiveNative?.includes("ping") && r.natives?.ping?.pong === "from-test", r.natives);
    check("CSP still chained", r.csp.mode === "chained");
}

// ---------------------------------------------------------------------------------------------- S3
console.log("\nS3 Vencord files missing (stub must not brick Discord)");
{
    const t = makeTree("s3", { dropPatcher: true });
    const r = boot("s3", t);
    check("Discord started vanilla", r.afterLoad.discordLoaded && r.addon?.vanillaFallback && r.afterLoad.appPath === join(t.res, "_app.asar"), r.afterLoad);
    check("window keeps Discord's own preload", r.window?.preload === join(t.res, "_app.asar", "mainScreenPreload.js"), r.window?.preload);
}

// ---------------------------------------------------------------------------------------------- S4
console.log("\nS4 PeerLive files removed but our stub left behind");
{
    const t = makeTree("s4", { dropAddon: true });
    const r = boot("s4", t);
    check("stub falls through to plain Vencord", r.afterLoad.discordLoaded && r.addon === null && r.window?.preload === join(t.dist, "preload.js"), r.window);
}

// ---------------------------------------------------------------------------------------------- S5
const built = join(SCRATCH, "build");
if (existsSync(join(built, "addon.json"))) {
    console.log("\nS5 the REAL PeerLive plugin built by build/build-plugin.mjs (native.ts unchanged)");
    const t = makeTree("s5", { payloadDir: built });
    const r = boot("s5", t);
    const relays = Object.keys(JSON.parse(readFileSync(join(PROTO, "payload", "addon.json"), "utf8")).csp);
    const connect = (r.csp.header ?? "").split(";").map(s => s.trim()).find(s => s.startsWith("connect-src ")) ?? "";
    check("loaded with hooks, no addon errors", r.addon?.rendererHooked && r.addon?.ipcMapHooked && (r.addon?.errors ?? []).length === 0, r.addon?.errors);
    check("VencordNative.pluginHelpers.PeerLive present (plugin code unchanged)", r.preload?.pluginHelpers?.includes("PeerLive"), r.preload?.pluginHelpers);
    check("relays from native.ts (CspPolicies shim) reach the CSP header", relays.every(u => connect.split(" ").includes(u)), connect.slice(-300));
} else console.log("\nS5 skipped (run addon/prototype/build/build-plugin.mjs first)");

// ---------------------------------------------------------------------------------------------- installer
console.log("\nInstaller on a fake tree (asar files, like the real machine)");
{
    const root = join(SCRATCH, "installer");
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

    const args = { discord, appdata };
    check("status sees Vencord stub on newest app-*", installer.status(args).at(-1).kind === "vencord-stub");
    const ins = installer.install(args);
    check("install: our stub written, Vencord path kept", installer.inspect(res).kind === "peerlive-stub" && installer.inspect(res).vencordPatcher === patcher, ins);
    check("install: Vencord stub backed up", Buffer.compare(readFileSync(join(appdata, "PeerLive", "backup", "app-1.0.9266.vencord-app.asar")), vencordStub) === 0);
    check("install: addon files copied", existsSync(join(appdata, "PeerLive", "addon", "main.js")) && existsSync(join(appdata, "PeerLive", "addon", "addon.json")));
    check("stub index.js points at loader", readAsarFile(join(res, "app.asar"), "index.js").includes(JSON.stringify(join(appdata, "PeerLive", "addon", "main.js"))));
    installer.install(args);
    check("install again = repair (idempotent)", installer.inspect(res).kind === "peerlive-stub");
    // Vencord installer "Repair": unpatch + patch -> writes its own stub again
    writeFileSync(join(res, "app.asar"), vencordStub);
    installer.install(args);
    check("after Vencord installer repair, our install restores PeerLive", installer.inspect(res).kind === "peerlive-stub");
    const un = installer.uninstall(args);
    check("uninstall: Vencord stub byte-identical restored", Buffer.compare(readFileSync(join(res, "app.asar")), vencordStub) === 0, un);
    check("uninstall: addon dir removed", !existsSync(join(appdata, "PeerLive", "addon")));
    rmSync(join(res, "_app.asar"));
    let refused = false;
    try { installer.install(args); } catch { refused = true; }
    check("install refuses without official Vencord (_app.asar missing)", refused);
    let guarded = false;
    try {
        execFileSync(process.execPath, [join(PROTO, "installer", "install.js"), "install", "--discord", join(process.env.LOCALAPPDATA ?? "C:/none", "Discord"), "--appdata", appdata], { stdio: "pipe" });
    } catch (e) { guarded = /without --real/.test(String(e.stderr)); }
    check("CLI refuses the real Discord folder without --real", guarded);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
