# Telinha add-on: real-Discord test (official Vencord + Telinha add-on)

For the orchestrator to run **with the user**, on this PC. Everything is PowerShell, run from the repo
(`C:\Users\Humbe\Evig\Projetos\PeerLive`). Each step says what to expect; stop at the first surprise and roll back
(step 9 takes seconds). Contract behind all of this: [`PAYLOAD.md`](PAYLOAD.md).

What changes on the machine, and nothing else:

| Path | Change | Undo |
|---|---|---|
| `%APPDATA%\Vencord\dist` | fork build renamed to `dist.fork-<date>`; official 443688b copied in | step 9 |
| `%LOCALAPPDATA%\Discord\app-<newest>\resources\app.asar` | Vencord's 219-byte stub → Telinha stub | step 9 / step 10 |
| `%APPDATA%\Telinha\` | new: `addon\`, `backup\`, `install.json`, `logs\` | step 10 |
| `%APPDATA%\Vencord\settings\settings.json` | Vencord keeps writing it as usual (Telinha's settings live in `plugins.Telinha`) | step 9 (backup copy) |

`_app.asar` (Discord itself) is never touched.

---

## 0. Build and check the payload (dev machine, Discord can stay open)

```powershell
cd C:\Users\Humbe\Evig\Projetos\PeerLive
pnpm build:addon                      # must end with: BUILD SMOKE PASSED
node addon\test\run-main-test.mjs     # must end with: ALL ... CHECKS PASSED
node addon\test\run-renderer-test.mjs # must end with: ALL ... CHECKS PASSED
Get-Content dist\addon\*.zip.sha256
```

Write down the commit shown by `pnpm build:addon` (`built Telinha add-on 0.1.0 (<commit>)`); `main.log` must show
the same one later.

## 1. Close Discord completely

Tray icon → **Quit Discord** (closing the window is not enough). Then:

```powershell
Get-Process -Name Discord* -ErrorAction SilentlyContinue   # must print NOTHING
```

If something is still listed, wait a few seconds and run it again (the installer refuses while Discord runs).

## 2. Backups (every Discord install + Vencord settings)

```powershell
$B = "$env:USERPROFILE\Telinha-backup-$(Get-Date -Format yyyyMMdd-HHmm)"
New-Item -ItemType Directory $B | Out-Null
Get-ChildItem $env:LOCALAPPDATA -Directory -Filter "Discord*" | ForEach-Object {
    $flavor = $_.Name
    Get-ChildItem $_.FullName -Directory -Filter "app-*" | ForEach-Object {
        $asar = Join-Path $_.FullName "resources\app.asar"
        if (Test-Path -LiteralPath $asar -PathType Leaf) {
            $dst = Join-Path $B "$flavor\$($_.Name)"
            New-Item -ItemType Directory $dst -Force | Out-Null
            Copy-Item -LiteralPath $asar -Destination $dst
        }
    }
}
Copy-Item "$env:APPDATA\Vencord\settings" "$B\vencord-settings" -Recurse
Get-ChildItem $B -Recurse -File | Select-Object FullName, Length
```

Expected on this PC: `Discord\app-1.0.9188\app.asar` (~7.6 MB, Discord's original, unpatched old folder),
`Discord\app-1.0.9266\app.asar` (**219 bytes**, Vencord's stub) and the `vencord-settings` files.

In a new PowerShell window later, get `$B` back with:

```powershell
$B = (Get-ChildItem $env:USERPROFILE -Directory -Filter "Telinha-backup-*" | Sort-Object Name | Select-Object -Last 1).FullName
```

## 3. Put the official Vencord back in `%APPDATA%\Vencord\dist`

The user currently runs our **fork** build there (it already contains Telinha; with it the add-on would stay passive).

```powershell
$V = "$env:APPDATA\Vencord"
Get-Content "$V\dist\patcher.js" -TotalCount 1                  # today: the fork's header
Rename-Item "$V\dist" "dist.fork-$(Get-Date -Format yyyyMMdd-HHmm)"
Copy-Item "$V\dist.backup-oficial-443688b" "$V\dist" -Recurse
Get-Content "$V\dist\patcher.js" -TotalCount 1                  # must print: // Vencord 443688b
```

**Recommended sanity run:** start Discord, check Settings → Vencord shows 443688b and that searching "Telinha" in
Settings → Vencord → Plugins finds **nothing**. Quit Discord completely again (step 1).

Note: this official build has its updater enabled. If Vencord updates itself during the test, that is fine (the add-on
reads whatever `renderer.js` is there); just note the new version.

## 4. Status (read-only)

```powershell
node addon\installer\install.js status --discord "$env:LOCALAPPDATA\Discord" --appdata "$env:APPDATA"
```

Expected for the newest folder (`app-1.0.9266`, unless Discord updated meanwhile):
`"kind": "vencord-stub"`, `"hasOriginal": true`, `"vencordPatcher": "C:\\Users\\Humbe\\AppData\\Roaming\\Vencord\\dist\\patcher.js"`,
**`"vencordStubCanonical": true`** (regenerating Vencord's stub gives these exact bytes, so uninstall is exact), and
`"installedAddon": null`. Anything else → stop.

## 5. Install (dev installer, Node)

```powershell
node addon\installer\install.js install --discord "$env:LOCALAPPDATA\Discord" --appdata "$env:APPDATA" --real
node addon\installer\install.js status  --discord "$env:LOCALAPPDATA\Discord" --appdata "$env:APPDATA"
```

Expected: install prints `"previous": "vencord-stub"`, a `"backup"` path under `%APPDATA%\Telinha\backup\Discord\`
and the commit from step 0. Status now shows `"kind": "telinha-stub"` on the newest folder with the same
`vencordPatcher`, and `installedAddon` with that commit. Files:

```powershell
Get-ChildItem "$env:APPDATA\Telinha\addon" | Select-Object Name, Length
```

→ `addon.json main.js payload.js preload.js register.js stub-template.js telinha-audio.exe telinha.main.js
telinha.renderer.js version.json`.

## 6. Start Discord and read the logs

Start Discord normally (Start menu). Wait until it is fully loaded, then:

```powershell
Get-Content "$env:APPDATA\Telinha\logs\main.log" -Tail 15
```

Expected for one Discord start (`[pid]` after the timestamp): first these two, in this order,

1. `boot {"vencordPatcher":"...\\Vencord\\dist\\patcher.js",...}`
2. `loaded {"version":"0.1.0","commit":"<step 0>","rendererHooked":true,"ipcMapHooked":true,"natives":8,"helperDir":"...\\Telinha\\addon","errors":0}`

then, once the main window loads (either order):

3. `CSP: added 8 sources (chained)`
4. `renderer served {"metaPatched":true,"metaReason":null}`

Bad signs: any `ERROR`, `Vencord IPC hooks not seen`, `preload fallback active`, `Vencord failed to load`,
`already bundles Telinha` (= `dist` is still the fork: redo step 3).

Discord's renderer log (it may or may not carry page console lines; DevTools below is authoritative):

```powershell
Select-String -Path "$env:APPDATA\discord\logs\renderer_js.log" -Pattern "\[Telinha\]" | Select-Object -Last 20
```

### DevTools checks (Ctrl+Shift+I → Console)

Type `Telinha` in the console filter first: there must be `[Telinha] addon: registered Telinha {enabled: true,
webpackAlreadyRunning: false}` and **no** `Patch by Telinha errored` / `had no effect` warnings. Then paste:

```js
TelinhaAddon.boot                                      // {via: "ipc-hook", metaPatched: true, metaReason: null}
TelinhaAddon.registrations.Telinha                     // {enabled: true, webpackAlreadyRunning: false}
Object.keys(VencordNative.pluginHelpers.Telinha).length // 8
await VencordNative.pluginHelpers.Telinha.screenAudioStatus()
                                                       // {available: true, reason: "áudio do PC sem o Discord (process loopback do Windows)"}
Vencord.WebpackPatcher.patches.filter(p => p.plugin === "Telinha").length
                                                       // 0, or 1 until a call screen was opened (the call-tile module loads lazily)
Vencord.Plugins.plugins.SupportHelper.commands.find(c => c.name === "vencord-plugins").execute().content
                                                       // lists Telinha under "Enabled UserPlugins" (sends nothing)
```

CSP (optional): `const w = new WebSocket("wss://nos.lol"); setTimeout(() => w.close(), 3000)` must **not** log a
`Content Security Policy` refusal; `new WebSocket("wss://example.com")` must.

### UI checks

- Settings → Vencord → Plugins, search "Telinha": the card is there and enabled; the cog opens its settings
  (password, quality, codec, …) with the "Copiar diagnóstico" button.
- Change **Codec** to VP9, quit Discord completely, start again: still VP9 (and
  `Select-String "$env:APPDATA\Vencord\settings\settings.json" -Pattern '"codec"'` shows it). Set it back to Automático.
- Join a voice channel: the "Transmitir com Telinha" bar appears under the voice connection panel; the Vencord toolbox
  (title bar icon) has the Telinha actions.

## 7. Functional test (two PCs, as before)

Both PCs need Telinha (the friend can keep the fork build). In the same voice channel: stream a window with audio, then
the whole screen with audio; the other side clicks the TELINHA tag and also watches inside the call view. Afterwards
"Copiar diagnóstico" on both sides if anything looked wrong.

## 8. Restart / update survival (quick)

- Quit and restart Discord twice: step 6 log lines repeat each time, `errors:0`.
- Do **not** force a Discord update. After the next natural one, `status` must show `telinha-stub` on the new
  `app-*` folder (Vencord copies our stub forward).

## 9. Roll back instantly (any time)

Quit Discord completely (step 1), then either of:

**a) the dev uninstaller (normal way):**

```powershell
node addon\installer\install.js uninstall --discord "$env:LOCALAPPDATA\Discord" --appdata "$env:APPDATA" --real
```

Expected: `"restored": [{"app": "app-1.0.9266", "from": "backup", "sameAsVencordInstallerOutput": true, ...}]`.

**b) by hand from the step-2 backup (if Node/the repo is not usable):**

```powershell
if (-not $B) { $B = (Get-ChildItem $env:USERPROFILE -Directory -Filter "Telinha-backup-*" | Sort-Object Name | Select-Object -Last 1).FullName }
Get-ChildItem "$B\Discord" -Directory | ForEach-Object {
    $target = "$env:LOCALAPPDATA\Discord\$($_.Name)\resources\app.asar"
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath "$($_.FullName)\app.asar" -Destination $target -Force }
}
```

Either way, verify the stub is Vencord's again (must say `FC: no differences encountered`):

```powershell
fc.exe /b "$env:LOCALAPPDATA\Discord\app-1.0.9266\resources\app.asar" "$B\Discord\app-1.0.9266\app.asar"
```

Then, to go back to the fork build the user had before (optional), and to restore Vencord's settings if anything
odd happened to them:

```powershell
$V = "$env:APPDATA\Vencord"
$fork = (Get-ChildItem $V -Directory -Filter "dist.fork-*" | Sort-Object Name | Select-Object -Last 1).Name
Rename-Item "$V\dist" "dist.official-test-$(Get-Date -Format yyyyMMdd-HHmm)"
Rename-Item "$V\$fork" "dist"
Get-Content "$V\dist\patcher.js" -TotalCount 1          # the fork's header again
# only if settings got damaged:
# Copy-Item "$B\vencord-settings\*" "$V\settings" -Recurse -Force
```

## 10. Uninstall test (end of the session, optional)

With Discord closed: run 9a, then `fc.exe` as in 9, then start Discord: official Vencord only, no Telinha in the
plugin list. `%APPDATA%\Telinha` keeps only `logs\` (`--purge` removes that too). Re-run step 5 to put Telinha back.

---

## What could bite in the real test

- **Discord updates mid-test**: the newest `app-*` changes. Fine for Telinha (Vencord copies our stub), but the
  `fc.exe` paths above mention `app-1.0.9266`; use the folder `status` reports. `uninstall` handles every folder.
- **Vencord installer Repair** during the test: replaces our stub (Telinha off, Vencord on). Re-run step 5.
- **`dist` still the fork**: the add-on stays passive (`already bundles Telinha` in `main.log`); redo step 3.
- **Antivirus** may quarantine the unsigned `telinha-audio.exe` in `%APPDATA%\Telinha\addon`: everything else works,
  `screenAudioStatus()` then says the helper is missing.
- **Settings**: `settings.json` already has `plugins.Telinha` from the fork; the add-on uses it as is (enabled stays
  whatever it was). The add-on defaults to enabled only when there is no saved choice.
