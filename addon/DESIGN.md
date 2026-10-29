# PeerLive como addon do Vencord oficial: estudo de viabilidade e protótipo

## Resumo (pt-BR)

**Veredito: viável, com ressalvas.** O usuário mantém o **Vencord oficial** (intocado e se atualizando sozinho) e um
instalador pequeno do PeerLive troca só o *stub* `resources\app.asar`, que hoje é o do Vencord. Esse stub tem uma
linha, `require("…\Vencord\dist\patcher.js")`. O nosso faz `nosso loader → patcher.js oficial → Discord`. Não
distribuímos fork nenhum do Vencord.

Como funciona:

1. **Stub** (`resources\app.asar`, no mesmo formato asar do instalador do Vencord). Carrega
   `%APPDATA%\PeerLive\addon\main.js` e depois o `patcher.js` oficial. Se o Vencord sumir, abre o Discord puro em
   vez de travar.
2. **Loader (processo main)**, antes do Vencord:
   - envolve `ipcMain.on` só enquanto o Vencord registra dois canais síncronos. Em
     `VencordPreloadGetRendererJs` acrescentamos o nosso renderer depois do renderer do Vencord, numa única
     `executeJavaScript`. Em `VencordGetPluginIpcMethodMap` acrescentamos as nossas funções nativas, e com isso
     `VencordNative.pluginHelpers.PeerLive.*` funciona sem mudar o código do plugin;
   - registra `ipcMain.handle` para os natives;
   - encadeia o CSP: envolve `webRequest.onHeadersReceived` antes do `initCsp()` do Vencord, então o listener único
     do Vencord passa a acrescentar também os 8 relays;
   - deixa um **fallback dormente**: uma subclasse de `BrowserWindow` abaixo da do Vencord, que só troca o preload
     se o hook de IPC não disparar (por exemplo, se o Vencord renomear o canal).
3. **Renderer**: roda logo depois do Vencord e **antes de qualquer chunk webpack do Discord**. Coloca o plugin em
   `Vencord.Plugins.plugins` e repete o que `initPluginManager()` faz (settings, dependências, `addPatch`). O
   plugin aparece em Configurações → Vencord → Plugins, liga e desliga, e as settings são salvas no `settings.json`
   do próprio Vencord.

**Atualizações.** Na atualização do Discord, o `persistAfterDiscordUpdates` do Vencord copia byte a byte o
`app.asar` *atual*, que é o nosso stub, para a pasta `app-*` nova. Isso foi provado com o `patcher.js` oficial, e o
seu PC já mostra o mesmo comportamento (stub de 25/08 dentro de `app-1.0.9266`, criada em 27/10). Na atualização
do Vencord, o updater só reescreve `%APPDATA%\Vencord\dist\*`, e o loader relê o `renderer.js` a cada janela.

**Ressalvas (o que pode quebrar):**

- Dependemos de internals que não são API pública. São todos pequenos e estáveis, e cada um tem detecção ou
  fallback (tabela em [Internals](#internals-we-depend-on-and-how-fragile-each-is)).
- `PluginMeta` não é alcançável em runtime. Sem uma entrada nele, o modal de settings do plugin e o
  `/vencord-plugins` quebram. Resolvemos com um patch de string, verificado, no renderer que servimos, só em
  memória: o arquivo do Vencord não muda.
- O **Vencord Installer → Repair/Install** troca o nosso stub pelo dele. O Vencord continua ok, mas o PeerLive some
  até rodar o nosso instalador de novo. O **Uninstall** do Vencord remove os dois.
- O instalador final precisa ser um `.exe`/`.ps1`, porque o usuário não tem Node. O protótipo do instalador é Node.

**Provado offline** (Vencord **oficial 443688b**, com cópias em `%TEMP%\pl-addon`; nada real foi tocado):

- 46 checagens do lado main com o `patcher.js` e o `preload.js` reais;
- 25 checagens do renderer em `vm` com o `renderer.js` real e um runtime webpack falso, em que o patch é **aplicado**
  de fato;
- o build do **plugin PeerLive real, sem alterações**, como addon, com smoke ok.

O teste no Discord real é o próximo passo, com backup (veja o
[plano de teste no Discord real](#real-discord-test-plan-explicit-step-with-backups)).

---

## 1. Recommended architecture

```
%LOCALAPPDATA%\Discord\app-<ver>\resources\
    app.asar     <- PeerLive stub (asar: index.js + package.json; same layout Vencord's installer writes)
    _app.asar    <- Discord's original (renamed by the OFFICIAL Vencord installer; we never touch it)
%APPDATA%\Vencord\dist\          <- official Vencord, self-updating, untouched
%APPDATA%\PeerLive\
    addon\  main.js payload.js register.js preload.js addon.json <plugin>.main.js <plugin>.renderer.js
    backup\ app-<ver>.vencord-app.asar      (Vencord's stub as we found it)
    logs\   main.log                        (main-process stdout is invisible on Windows)
```

Boot sequence (main process):

```
Discord.exe -> resources/app.asar/index.js  (our stub; require.main)
  -> %APPDATA%/PeerLive/addon/main.js boot()
       install hooks: ipcMain.on wrapper, ipcMain.handle(natives), whenReady CSP wrapper, BrowserWindow subclass
  -> require(<Vencord patcher.js path copied from Vencord's own stub>)
       Vencord: require.main.filename -> _app.asar main, BrowserWindow subclass (extends ours), ipcMain.on(...) [hooked]
       -> require(Discord main)
  <- restore ipcMain.on once both hooks fired
```

Window load (renderer):

```
Vencord preload.js (unchanged)
  sendSync("VencordGetPluginIpcMethodMap")  -> {...Vencord's, PeerLive: {listSources: "PeerLiveAddon_PeerLive_listSources", ...}}
  exposeInMainWorld("VencordNative")         -> pluginHelpers.PeerLive.* = ipcRenderer.invoke(our channels)
  executeJavaScript(sendSync("VencordPreloadGetRendererJs"))
        = Vencord renderer.js (+ PluginMeta entry)  ;  try{(0,eval)(register.js + plugin bundle)}catch{}
  require(DISCORD_PRELOAD)
Discord scripts -> webpack runtime -> Vencord's Function.prototype.m hook -> factories patched lazily (ours included)
```

## 2. Q1: loader chain, Discord updates, Vencord updates

**The stub can sit in front of Vencord.** Vencord derives everything from `require.main`, which stays our stub:
- `src/main/patcher.ts:29` `injectorPath = require.main!.filename`, `:32` `asarName = require.main.path.endsWith("app.asar") ? "_app.asar" : …`,
  `:35-41` resolves `_app.asar`, re-points `require.main.filename` and `app.setAppPath`, `:140` requires Discord.
- Requiring `patcher.js` from our loader is identical to Vencord's stub `require("<path>")` (Vencord installer
  `app_asar.go` `WriteAppAsar`: `index.js` = `require(<json path>)`). Our Node writer reproduces the user's real
  219-byte stub **byte for byte** (checked against `%LOCALAPPDATA%\Discord\app-1.0.9266\resources\app.asar`, read-only).
- We copy the patcher path out of Vencord's existing stub instead of guessing it (Vencord's installer honours
  `VENCORD_USER_DATA_DIR` etc.).

**(a) Discord updates: no extra work.** `src/main/persistAfterDiscordUpdates.ts:35-63` (`patchLatest`) renames the new
version's `app.asar` to `_app.asar` and `copyFileSync(oldResources/app.asar → new)`. It copies whatever stub is
current, which is ours. The hooks are `host-updated` (`:72`) and `before-quit` (`:82`). Proved in scenario S1 with the
real official `patcher.js`, where the log shows `[Vencord] Detected Host Update (app-1.0.9002 -> app-1.0.9003)` and the
new `app.asar` is byte-identical to our stub. The real machine shows the same: the Aug-25 stub sits in `app-1.0.9266`,
whose `_app.asar` is from Oct 27 (`CopyFileW` keeps the mtime).
*Hardening, optional and not implemented:* if Vencord ever switched to regenerating its own stub, a `before-quit`
listener of ours registered after Vencord's could re-copy our stub.

**(b) Vencord updates: no interplay.** The in-app updater writes only `join(__dirname, name)` for release assets
(`src/main/updater/http.ts:75-83`). The installer re-downloads `dist` too. The renderer is read fresh on every window
load (`src/main/ipcMain.ts:178-180`), and the hook transforms whatever comes back (S1 appends a marker to
`renderer.js` after boot and the served script contains it).

**Hooking through Vencord's own files is a dead end, confirmed.** Anything in `dist\` is overwritten by the updater and
the installer, and the Vencord installer's "patched" detection does not even look at the files.

## 3. Q2: main process (CSP, display media, IPC)

**CSP.** `initCsp()` (`src/main/csp/index.ts:142-164`) installs one `session.defaultSession.webRequest.onHeadersReceived`
listener inside `app.whenReady().then` (`src/main/index.ts:32,77`). It then sets `webRequest.onHeadersReceived = () => {}`
so nobody else can install one. `CspPolicies` (`:22`) is module-private in the bundle, so there is no global to push into.

What we do (`loader/main.js installCspChain`): our `whenReady().then` is registered before Vencord's and runs first. It
sets `webRequest.onHeadersReceived` to a wrapper that wraps the listener passed in. Vencord's `initCsp()` therefore
installs *its* listener through us. After Vencord's rewrite we add our sources to the same response. Result in S1:
`installs: 1`, Vencord's `'unsafe-eval'`/`vencord:`/`api.github.com` additions intact, the stylesheet content-type fix
intact, and all 8 relays in `connect-src`. If Vencord installs nothing (vanilla fallback, future change), a
`setImmediate` installs our own listener.

Sources are `addon.json.csp` plus `globalThis.__PeerLiveAddonCsp`. The addon build shims `@main/csp` so that the
unchanged `native.ts` (`CspPolicies[url] = ConnectSrc`) lands there (scenario S5).

Alternatives considered:
- **User CSP override storage** (`native-settings.json` `customCspRules`, read per request at `csp/index.ts:126`). The
  loader could merge our hosts into the file before Vencord starts. It works without any hook, but it persists into the
  user's Vencord config. Kept as the fallback idea.
- **`VencordNative.csp.requestAddOverride`** (`src/main/csp/manager.ts:21-31,82`). It needs one dialog per domain (8
  dialogs) plus a restart. Rejected for UX.

**Display media.** Vencord sets no `setDisplayMediaRequestHandler` (grep `src/main`), and PeerLive's `native.ts` installs
and removes its own handler per request on `event.sender.session`. That runs unchanged in our main bundle (hello
`armDisplayMedia` is checked in S1).

**Renderer ↔ main.** Vencord's preload builds `VencordNative.pluginHelpers` from the sync map it fetches
(`src/VencordNative.ts:24-31`; registry in `src/main/ipcPlugins.ts:27-42`). We hook that reply and add
`PeerLive: { method: "PeerLiveAddon_PeerLive_<method>" }`, with our own `ipcMain.handle` per method, using our own
prefix so we never clash with Vencord's handlers. The plugin's `getNativeOrNull()` (`core/nativeApi.ts`) works as is.
Natives reject frames that are not `https://*.discord.com/` (stricter than Vencord).

No preload of our own is needed on the primary path. **Fallback B** (`loader/preload.js`) is our preload wrapping
Vencord's, which exposes `window.PeerLiveNative` and queues our renderer with a second `executeJavaScript`.

## 4. Q3: renderer injection and plugin registration

- **Timing.** Vencord's preload runs the renderer with `webFrame.executeJavaScript` (`src/preload.ts:32`) before
  Discord's scripts. Our code is appended to that same script, so ordering is guaranteed: after `var Vencord=` and
  before any Discord chunk. Indirect `eval` keeps Vencord's `sourceURL`/`sourceMappingURL` footer intact, and Vencord's
  CSP always adds `'unsafe-eval'` (`csp/index.ts:120`).
- **The plugin list is a plain object.** `~plugins` is generated at build time
  (`scripts/build/common.mjs:136-198`: `export default {[p.name]: p}`) and exported as `Vencord.Plugins.plugins`
  (`src/api/PluginManager.ts:39-40`). The settings UI (`tabs/plugins/index.tsx:151`), `startAllPlugins`
  (`PluginManager.ts:119-131`), `isPluginEnabled` (`:49`) and `$self` (`addPatch` → `Vencord.Plugins.plugins["name"]`,
  `:77`) all read that same object.
- **We arrive after `initPluginManager()`** (`src/Vencord.ts:176-178`), so `loader/register.js` repeats its per-plugin
  work (`PluginManager.ts:327-398`):
  - `settings.pluginName`;
  - `onChange` listeners;
  - dependencies and API plugins (we also queue *their* patches if we had to enable them);
  - binding;
  - `addPatch()` for each patch when enabled;
  - `StartAt.Init` start.

  `DOMContentLoaded` and `WebpackReady` starts come from Vencord's own `startAllPlugins` calls (`Vencord.ts:149,182`),
  which iterate the object we added to.
- **Patches apply because they are lazy.** `patches` (`src/webpack/patchWebpack.ts:18`) is consumed when each Discord
  module factory first runs (`:254-264`), and with `eagerPatches` when it is set (`:287`). Either way that is after us.
  Proved in vm: a fake Discord webpack runtime loaded from `https://discord.com/assets/…` is adopted by Vencord's
  `Function.prototype.m` hook (`:97`), our probe module returns our setting, and an account-panel-shaped module passes
  through our `$self` hook. Applied patches leave the pending list (`:633`).

  Note: `getFactoryPatchedBy` is `IS_DEV`-only (`:640`), so in production we check effects instead.
- **`PluginMeta` gap.** It is module-private, but `PluginModal.tsx:167,177` (`pluginMeta.userPlugin`) and
  `supportHelper.tsx:116-117` dereference it without `?.`. Control run D proves `/vencord-plugins` crashes without an
  entry. The main hook inserts `"<name>":{"folderName":…,"userPlugin":true}` into the minified literal (regex in
  `loader/payload.js`, applied only if it matches exactly once; otherwise logged and skipped). Marking the plugin as a
  *UserPlugin* is honest: the modal hides the "View source on Vencord's GitHub" links, and SupportHelper lists it
  under UserPlugins.

## 5. Q4: Settings UI

The plugin appears in Settings → Vencord → Plugins (same object, `index.tsx:151`), with a settings cog
(`hasAnyVisibleSettings`) and its modal (thanks to `PluginMeta`). The toggle works like any patching plugin
(`PluginCard.tsx:51-55`: flips `enabled` and asks for a restart).

`definePluginSettings` works because defaults are resolved lazily through `key in plugins`
(`src/api/Settings.ts:144-170`), and changes go through `VencordNative.settings.set` (`:175-180`) into
`%APPDATA%\Vencord\settings\settings.json`. Proved in vm runs A, B and C: defaults, `onChange`, persisted value, and
disabled state surviving "restarts". Cloud settings sync carries them too.

## 6. Q5: uninstall and repair interplay (Vencord installer source, `github.com/Vencord/Installer`)

- **Patched detection** = `resources\_app.asar` exists (`find_shared.go isResourcesFolderPatched`), and only the newest
  `app-*` folder is checked (`find_discord_windows.go ParseDiscord`). Our stub keeps `_app.asar`, so Vencord sees
  "installed".
- **Install/Repair on a patched Discord** = `unpatch()` (rename `app.asar`→tmp, `_app.asar`→`app.asar`, delete tmp)
  then `patch()` (rename → `_app.asar`, write *its* stub) (`patcher.go`). Our stub is replaced, so PeerLive is off and
  Vencord is fine. Re-running our installer restores PeerLive (tested on a fake tree).
- **Uninstall** restores Discord's original, so both are off. Our `%APPDATA%\PeerLive` stays inert, and our installer
  then refuses to install (no `_app.asar`) until Vencord is back.
- **Our uninstall** writes back a Vencord stub that is byte-identical to the installer's output for the recorded
  patcher path (a backup copy is also kept), then deletes `%APPDATA%\PeerLive\addon`. Vencord's `settings.json` keeps a
  harmless `plugins.PeerLive` entry.
- **Our stub without our files** falls through to plain Vencord (S4). **Our stub without Vencord** starts Discord
  vanilla instead of crashing (S3; Vencord's own stub would crash Discord there).
- OpenAsar (replaces `_app.asar`) and a Squirrel reinstall (wipes `app-*`) behave as they do for Vencord.

## Internals we depend on (and how fragile each is)

| # | Internal | Where | Risk | If it changes |
|---|---|---|---|---|
| 1 | Stub contract: `app.asar` + `_app.asar`, Vencord reads `require.main` | `patcher.ts:29-41`, installer `app_asar.go` | low (unchanged since 2022, the installer depends on it) | nothing loads; same for Vencord itself |
| 2 | `persistAfterDiscordUpdates` copies the current `app.asar` | `persistAfterDiscordUpdates.ts:52-63` | low | after a Discord update, Vencord stays but PeerLive drops (add our own re-copy) |
| 3 | Sync IPC `VencordPreloadGetRendererJs` / `VencordGetPluginIpcMethodMap` via `ipcMain.on` + `returnValue` | `IpcEvents.ts:47,55`, `ipcMain.ts:178`, `ipcPlugins.ts:40` | low-medium | **fallback B kicks in automatically** (S2); logged |
| 4 | Vencord's `BrowserWindow` subclass extends `require("electron").BrowserWindow` read from `require.cache` (fallback B only) | `patcher.ts:70-128` | medium | only matters if #3 also broke |
| 5 | CSP: single listener installed in `whenReady().then` | `csp/index.ts:142-164`, `index.ts:32,77` | low-medium | we install our own listener (`cspMode:"standalone"`); worst case: no relays |
| 6 | `pluginHelpers` map shape `{plugin:{method:channel}}` | `VencordNative.ts:24-31` | low | natives unreachable (fallback `window.PeerLiveNative` exists) |
| 7 | `window.Vencord` exports: `Plugins.{plugins,addPatch,isPluginEnabled,startPlugin}`, `Api.Settings.{definePluginSettings,SettingsStore}`, `Settings`, `Webpack(.Common)`, `Components`, `Util` | `Vencord.ts:25-32` | low-medium (de facto console/userscript API) | registration refuses and logs; Discord + Vencord unaffected |
| 8 | Duties of `initPluginManager()` | `PluginManager.ts:327-398` | medium | `register.js` must be updated if new plugin features need init |
| 9 | Minified `PluginMeta` literal shape | `common.mjs:184-188` | medium | skipped and logged; only our modal and `/vencord-plugins` crash |
| 10 | Lazy patching (patches pushed before webpack init apply) | `patchWebpack.ts:254-264` | low | patches miss modules (warned by `register.js`) |

Discord-side `find`/`match` fragility is the same as for any Vencord plugin and is not addon-specific.

**Early warning (recommended):** a CI job that downloads each new Vencord release and runs
`addon/prototype/test/run-main-test.mjs --vencord-dist <dir>` and `run-renderer-test.mjs --vencord-dist <dir> --rebuild`.
They take seconds and need no Discord.

## 7. Building the real plugin as an addon

`addon/prototype/build/build-plugin.mjs` bundles **`src/plugins/peerLive` unchanged**. In the renderer bundle each
`@api/*`, `@components/*`, `@utils/*`, `@webpack(/common)` becomes a shim over `window.Vencord`, so the addon shares
Vencord's settings store, finders and React. `@utils/types` is the only file inlined, and it is pure: identity
`definePlugin` plus enum constants. Any other Vencord import fails the build ("would bundle a private copy of Vencord
internals"). `.css` becomes a `<style>`. JSX uses Vencord's own `VencordCreateElement` inject.

Result today:
- renderer 356 KiB, main 14 KiB, no Vencord source files bundled;
- internals used: `@api/Settings`, `@components/{Button,ErrorBoundary,FormSwitch,Paragraph}`,
  `@utils/{Logger,clipboard,css,types}`, `@webpack`, `@webpack/common`;
- it registers in official 443688b, and S5 boots it through the real `patcher.js`/`preload.js`: `pluginHelpers.PeerLive`
  is present, and the relays from the unchanged `native.ts` reach the CSP header.

Todo for production:
- `enabledByDefault` for the addon build (otherwise the user must enable it and restart once);
- an addon self-updater (GitHub release → `%APPDATA%\PeerLive\addon`);
- the installer as a signed Go/PowerShell tool (prototype is Node; Vencord's own installer is Go, and our asar writer
  is a port of it);
- publishing the source under GPL-3.0, since the addon is a Vencord plugin.

## 8. Prototype layout and offline results

```
addon/prototype/
  loader/stub-template.js   our resources/app.asar index.js (loader -> Vencord -> vanilla fallback)
  loader/main.js            main-process loader (hooks, natives, CSP chain, fallback B, log file)
  loader/payload.js         pure helpers: PluginMeta patch, renderer wrapper, CSP merge
  loader/register.js        renderer: late plugin registration (initPluginManager equivalent)
  loader/preload.js         fallback B preload
  payload/addon.json, hello.main.js, hello.renderer.js   trivial PeerLiveAddonHello (1 setting, 2 patches, natives)
  installer/asar.js, install.js     status/install/uninstall (refuses real paths without --real; refuses if Discord runs)
  build/build-plugin.mjs    build + smoke an unchanged Vencord plugin folder as addon payload
  test/run-main-test.mjs    S1-S5 + installer, real Vencord patcher/preload/renderer, fake electron + fake trees
  test/run-renderer-test.mjs  vm: real Vencord renderer + payload actually served in S1 + fake Discord webpack
```

Run (Vencord build defaults to `%APPDATA%\Vencord\dist.backup-oficial-*`, read-only, else `./dist`; scratch is
`%TEMP%\pl-addon`):

```
node addon/prototype/build/build-plugin.mjs        # optional; enables S5
node addon/prototype/test/run-main-test.mjs        # 46 checks
node addon/prototype/test/run-renderer-test.mjs    # 25 checks (uses S1's served script)
```

What the scenarios show:

- **S1**, official 443688b:
  - stub → loader → Vencord → Discord;
  - both hooks fire and `ipcMain.on` is restored;
  - window chain `Vencord → PeerLive(dormant) → Electron`, still listed by `getAllWindows()`;
  - Vencord's real preload runs Discord's preload;
  - one `executeJavaScript` with Vencord then the addon, `PluginMeta` patched;
  - `pluginHelpers.PeerLiveAddonHello` round-trip, display-media handler, untrusted frame rejected;
  - CSP chained (1 listener, Vencord's rules + 8 relays, stylesheet fix intact);
  - Discord-update persistence of our stub.
- **S2**, channels renamed: fallback B swaps the preload, two scripts, `window.PeerLiveNative` works, CSP still chained.
- **S3**, no Vencord: vanilla Discord. **S4**, no addon files: plain Vencord. **S5**, the real PeerLive bundle.
- **Installer**: install, backup, idempotent repair, recovery after a Vencord-installer repair, byte-identical
  uninstall, refusal without Vencord, `--real` guard.
- **Renderer**:
  - A: registered before webpack, `$self` canonicalised, patch applied to a fake Discord module, live setting,
    persisted via `VencordNative.settings.set`, `onChange` fires, Vencord's `startAllPlugins` starts it, `start()`
    reaches main, `/vencord-plugins` lists it as a UserPlugin, toolbox action, toggle requires restart.
  - B and C: disabled/enabled across restarts with the saved value.
  - D: control showing the `PluginMeta` entry is required.

## Real-Discord test plan (explicit step, with backups)

> Important: on this PC `%APPDATA%\Vencord\dist` currently holds a **fork** build (`// Vencord cd0559cd`, already
> containing PeerLive). The official build is in `dist.backup-oficial-443688b`. The addon model assumes official Vencord.

0. **Close Discord completely** (tray → Quit). Check with `tasklist | findstr /i discord`, which should return nothing.
1. **Backups** (PowerShell):
   ```powershell
   $B = "$env:USERPROFILE\PeerLive-backup-$(Get-Date -f yyyyMMdd-HHmm)"; mkdir $B
   $App = (Get-ChildItem "$env:LOCALAPPDATA\Discord" -Directory -Filter app-* | Sort-Object { [version]($_.Name.Substring(4)) } | Select-Object -Last 1).FullName
   Copy-Item "$App\resources\app.asar" "$B\app.asar"
   Copy-Item "$env:APPDATA\Vencord\settings" "$B\vencord-settings" -Recurse
   ```
2. **Make Vencord official.** Rename `%APPDATA%\Vencord\dist` to `dist.fork-cd0559cd`, copy
   `dist.backup-oficial-443688b` to `dist` (or run the official Vencord installer → Repair). Start Discord and confirm
   Vencord works and Settings → Vencord shows 443688b. Close Discord fully.
3. `node addon\prototype\installer\install.js status --discord "$env:LOCALAPPDATA\Discord" --appdata "$env:APPDATA" --real`
   should show `vencord-stub` on the newest `app-*`.
4. `… install … --real` should report `previous: vencord-stub`, and `status` should now show `peerlive-stub`.
5. Start Discord normally. Check `%APPDATA%\PeerLive\logs\main.log` for `boot`, then
   `loaded {rendererHooked:true, ipcMapHooked:true, natives:2}`, then `CSP: added 8 sources (chained)`.
6. DevTools (Ctrl+Shift+I) console:
   - `PeerLiveAddon.boot` should be `{via:"ipc-hook", metaPatched:true}`, and
     `PeerLiveAddon.registrations.PeerLiveAddonHello` should be `{enabled:true, webpackAlreadyRunning:false}`.
   - `await VencordNative.pluginHelpers.PeerLiveAddonHello.ping("x")` should show `cspMode:"chained"`,
     `rendererHooked:true`, `errors:0`.
   - `Vencord.Plugins.plugins.PeerLiveAddonHello.accountPanelRenders` should be > 0 (the real Discord patch applied).
     `Vencord.WebpackPatcher.patches.filter(p => p.plugin === "PeerLiveAddonHello").length` should be 1 (only the
     offline probe stays pending). There should be no `Patch by PeerLiveAddonHello errored/had no effect` lines.
   - CSP: `new WebSocket("wss://nos.lol")` should give no CSP violation, while `new WebSocket("wss://example.com")`
     should log `Refused to connect … Content Security Policy`.
   - `Vencord.Plugins.plugins.SupportHelper.commands.find(c => c.name === "vencord-plugins").execute().content` should
     list it under UserPlugins. This sends nothing.
7. **UI.** In Settings → Vencord → Plugins, search "PeerLiveAddonHello". Open the cog, change "greeting", and restart.
   The value should be kept, and `settings.json` should contain `plugins.PeerLiveAddonHello`. The toggle should prompt
   for a restart. The Vencord toolbox should show "PeerLive addon: ping main", and clicking it should log the answer.
8. **Display media (optional).** Run `await VencordNative.pluginHelpers.PeerLiveAddonHello.armDisplayMedia("screen:0:0")`,
   then `(await navigator.mediaDevices.getDisplayMedia({video:true})).getTracks().forEach(t => t.stop())`. This should
   take no picker and give no error.
9. **Vencord update survival.** In Settings → Vencord → Updater, update if one is offered, or replace `dist` with a newer
   official release, then restart. Step 6 should still pass.
10. **Vencord installer interplay.** Running the official installer → Repair should leave Vencord ok and PeerLive gone.
    Running our `install` again should bring PeerLive back.
11. **Discord update survival.** After the next natural Discord update, `status` on the new `app-*` should show
    `peerlive-stub`. Do not force updates.
12. **Uninstall.** `… uninstall … --real`, then `fc /b "$App\resources\app.asar" "$B\app.asar"` should report no
    differences. Discord should start with official Vencord only.
13. **Rollback at any time.** Close Discord, then `Copy-Item "$B\app.asar" "$App\resources\app.asar" -Force`. Restore
    the fork `dist` if wanted.
14. **Then repeat with the real plugin.** Build it (`build-plugin.mjs`), copy its output and `addon/prototype/loader/*`
    into `%APPDATA%\PeerLive\addon`, and run the two-PC streaming test.
