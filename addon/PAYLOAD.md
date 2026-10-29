# Telinha add-on payload: install layout and installer contract

Status: **format 1**. Producer: `pnpm build:addon` (`addon/build/build-addon.mjs`). Consumers: the Go installer
(`installer/`) and the Node dev installer (`addon/installer/install.js`, tests and the real-Discord test only).

The user keeps the **official Vencord** untouched (and self-updating). Telinha is added by replacing only Vencord's
one-line stub `resources\app.asar` with our own stub, which chains:

```
Discord.exe -> resources\app.asar (Telinha stub) -> %APPDATA%\Telinha\addon\main.js (loader)
            -> official %APPDATA%\Vencord\dist\patcher.js -> Discord (resources\_app.asar)
```

Anything not written here is not part of the contract. If something here is ambiguous, the Node dev installer
(`addon/installer/install.js` + `addon/installer/asar.js`) is the reference implementation and the offline tests
(`addon/test/`) pin its behaviour.

---

## 1. Build output (what the installer ships)

```
dist/addon/
  payload/                                  <- exactly the files of %APPDATA%\Telinha\addon\ (flat, no subfolders)
  Telinha-addon-<commit>.zip                <- the same files, flat at the zip root (no folder inside the zip)
  Telinha-addon-<commit>.zip.sha256         <- "<64 hex>  Telinha-addon-<commit>.zip\n" (sha256sum format)
```

`<commit>` is `git rev-parse --short=8 HEAD`, with `-dirty` appended when the working tree had changes.

### Payload files (`%APPDATA%\Telinha\addon\`)

| File | What it is | Who uses it |
|---|---|---|
| `main.js` | main-process loader; the stub requires it and calls `boot()` | stub |
| `payload.js` | pure helpers for `main.js` (PluginMeta patch, renderer wrapper, CSP merge) | `main.js` |
| `preload.js` | dormant fallback preload (only if Vencord renames its IPC channels) | `main.js` |
| `register.js` | renderer-side late plugin registration, prepended to the renderer bundle at serve time | `main.js` |
| `addon.json` | runtime manifest (below) | `main.js` |
| `telinha.renderer.js` | the Telinha plugin, renderer side (built from `src/plugins/telinha`, CSS inlined; **no `telinha.css`**) | `main.js` |
| `telinha.main.js` | the Telinha plugin natives (`native.ts`), CommonJS | `main.js` |
| `telinha-audio.exe` | whole-screen audio helper (`native-audio/`), spawned by `telinha.main.js` | `telinha.main.js` |
| `stub-template.js` | template of the stub's `index.js` (section 3) | installers |
| `version.json` | build identity + SHA-256 of every other file (below) | installers |

The installer must copy **every file listed in `version.json.files` plus `version.json`**, and nothing else. It
must not rename files: `main.js` resolves its siblings by these names.

### `version.json`

```json
{
  "name": "Telinha",
  "payloadFormat": 1,
  "version": "0.1.0",
  "commit": "a6e4044d-dirty",
  "vencordBaseCommit": "443688b5",
  "vencordVersion": "1.15.13",
  "builtAt": "2026-10-29T12:00:00.000Z",
  "pluginName": "Telinha",
  "loaderEntry": "main.js",
  "stubTemplate": "stub-template.js",
  "stubFormat": 1,
  "files": {
    "main.js": { "size": 15873, "sha256": "<64 lowercase hex>" },
    "telinha-audio.exe": { "size": 123456, "sha256": "<64 lowercase hex>" }
  }
}
```

- `files` lists every payload file except `version.json` itself. The installer verifies size + SHA-256 of each
  extracted file and aborts (leaving the previous install intact) on any mismatch.
- `vencordBaseCommit`: the upstream Vencord commit the plugin was compiled against. The plugin uses only
  `window.Vencord` exports that are stable across releases, so a newer official Vencord is expected to work; the
  installer may show this value but must not refuse on a mismatch.
- `payloadFormat` / `stubFormat`: bumped only on incompatible changes to this document.

### `addon.json` (runtime manifest, read by `main.js`; installers treat it as opaque)

```json
{
  "format": 1,
  "pluginName": "Telinha",
  "renderer": "telinha.renderer.js",
  "main": "telinha.main.js",
  "meta": { "folderName": "telinha-addon", "userPlugin": true },
  "helperDirEnv": "TELINHA_HELPER_DIR",
  "preloadFallback": true,
  "csp": {}
}
```

---

## 2. Machine layout after install

```
%LOCALAPPDATA%\Discord\app-<ver>\resources\      (same for DiscordPTB / DiscordCanary / DiscordDevelopment)
    app.asar        <- Telinha stub (section 3)  [was: Vencord's 1-line stub]
    _app.asar       <- Discord's original, renamed by the OFFICIAL Vencord installer. NEVER touched by us.
%APPDATA%\Vencord\dist\                           <- official Vencord. NEVER touched by us.
%APPDATA%\Vencord\settings\settings.json          <- Vencord's settings; Telinha's settings live here (plugins.Telinha)
%APPDATA%\Telinha\
    addon\          <- the payload (section 1), replaced as a whole on install/update
    backup\<FlavorDir>\<app-ver>.app.asar          <- Vencord's stub exactly as found, before we replaced it
    install.json    <- what the installer did (section 4.7)
    logs\main.log   <- loader log (main-process stdout is invisible on Windows); rotates to main.log.1 at 256 KiB
```

`<FlavorDir>` is the folder name under `%LOCALAPPDATA%` (`Discord`, `DiscordPTB`, `DiscordCanary`,
`DiscordDevelopment`). `%APPDATA%` is the user's Roaming folder (resolve it with the Known Folder API, not by
string concatenation).

---

## 3. The stub (`resources\app.asar`)

### 3.1 `index.js` content

Take `stub-template.js` from the payload **byte for byte** (UTF-8, no BOM; use its line endings as they are, do not normalize) and
replace each of these tokens, which occur exactly once:

| Token | Replace with |
|---|---|
| `__TELINHA_LOADER__` | a JSON string literal of the absolute path of `%APPDATA%\Telinha\addon\main.js` |
| `__VENCORD_PATCHER__` | a JSON string literal of Vencord's patcher path, **read from Vencord's current stub** (3.3) |

"JSON string literal" = what `JSON.stringify(path)` gives: double quotes, `\\` for each backslash, `\"` for a quote,
other characters as UTF-8. Go: `json.Marshal` is acceptable (its `\u003c`-style HTML escaping is still valid JS),
but prefer an encoder with `SetEscapeHTML(false)` to match the Node installer byte for byte.

The rendered `index.js` starts with the line `// Telinha stub v1` and contains exactly one line each of:

```
const TELINHA_LOADER = "C:\\Users\\<user>\\AppData\\Roaming\\Telinha\\addon\\main.js";
const VENCORD_PATCHER = "C:\\Users\\<user>\\AppData\\Roaming\\Vencord\\dist\\patcher.js";
```

What the stub does at Discord start (it never lets a Telinha problem keep Discord from opening):

1. loader file exists and loads → `loader.boot({ vencordPatcher, vanilla })`;
2. loader missing or throws while loading → `require(VENCORD_PATCHER)` (plain Vencord);
3. Vencord's patcher missing too → starts Discord vanilla from `_app.asar` (Vencord's own stub would crash here).

### 3.2 asar container (identical to Vencord's installer, `app_asar.go` `WriteAppAsar`)

Two files, `index.js` (above) and `package.json` = the 43 bytes `{\n\t"name": "discord",\n\t"main": "index.js"\n}`
(LF, one TAB of indentation, no trailing newline).

```
header = {"files":{"index.js":{"size":<len(index.js)>,"offset":"0"},"package.json":{"size":<len(package.json)>,"offset":"<len(index.js)>"}}}
         (compact JSON, keys in exactly this order, offsets as strings, sizes as numbers)
headerStringSize = len(header)
alignedSize      = headerStringSize rounded up to a multiple of 4
header          += "0" * (alignedSize - headerStringSize)          (ASCII '0' characters, not NUL)

bytes:
  [0..4)    uint32 LE  4                      (data size)
  [4..8)    uint32 LE  alignedSize + 8        (header size)
  [8..12)   uint32 LE  alignedSize + 4        (header object size)
  [12..16)  uint32 LE  headerStringSize
  [16..)    header (padded) | index.js | package.json
```

The Go installer can reuse Vencord installer's `WriteAppAsar` code as is, passing our `index.js` instead of
`require("<patcher>")`. The Node writer (`addon/installer/asar.js buildStubAsar`) reproduces the user's real
219-byte Vencord stub byte for byte, which is what makes uninstall exact (section 5).

### 3.3 Reading an existing `app.asar` (classification)

Read `index.js` from the asar: `headerSize = u32le@4`, `headerStringSize = u32le@12`, header JSON at
`[16, 16+headerStringSize)`, file data base = `8 + headerSize`, `index.js` at `base + offset`, `size` bytes.

| `resources\app.asar` | kind | action |
|---|---|---|
| missing, or a directory | `missing` / `unknown` | refuse |
| larger than 64 KiB, or not a parseable asar | `discord-original` | refuse: Vencord not installed |
| `index.js`, trimmed, matches `^require\(("(?:[^"\\]\|\\.)*")\)$` | `vencord-stub` | patcher = JSON-decode of group 1 |
| `index.js` starts with `// Telinha stub` | `telinha-stub` | patcher = JSON-decode of the `const VENCORD_PATCHER = (...);` line |
| anything else | `unknown` | refuse (OpenAsar, other mods, a future Vencord stub format) |

Install also requires `resources\_app.asar` to exist (that is how Vencord itself detects "patched") and the patcher
path to exist as a file. Never guess the patcher path; if the stub can't be read, refuse and tell the user to run
Vencord's installer (Repair) first.

---

## 4. Install / update / repair (one idempotent operation)

1. **Discord must not be running**: no `Discord.exe`, `DiscordPTB.exe`, `DiscordCanary.exe`, `DiscordDevelopment.exe`
   processes (tray included). Refuse otherwise (`telinha-audio.exe` and `main.log` may also be held open).
2. For each flavor root the user picked (default: every `%LOCALAPPDATA%\Discord*` root that has Vencord installed),
   take the **newest** `app-*` folder (compare the dotted version numerically) that has a `resources` folder. That is
   the folder Discord runs and the one Vencord's installer patches. Older `app-*` folders are left alone.
3. Classify `resources\app.asar` (3.3). Proceed only for `vencord-stub` or `telinha-stub`, with `_app.asar` present and
   the patcher file present.
4. **Payload**: extract the zip to `%APPDATA%\Telinha\addon.new\`, verify `version.json.files` (size + SHA-256), then
   swap: rename `addon` → `addon.old` (if present), `addon.new` → `addon`, delete `addon.old`. On any failure delete
   `addon.new` and keep the previous `addon`.
5. **Backup** (only when the kind was `vencord-stub`): copy `app.asar` to
   `%APPDATA%\Telinha\backup\<FlavorDir>\<app-ver>.app.asar`, overwriting an older backup for the same folder.
   Never back up a `telinha-stub` (we would lose the real Vencord stub).
6. **Stub**: render the stub (3.1, 3.2) with the patcher path from step 3, write it to
   `resources\app.asar.telinha-tmp`, then atomically replace `resources\app.asar` (`MoveFileEx` with
   `MOVEFILE_REPLACE_EXISTING`). Re-read and re-classify: it must now be `telinha-stub` with the same patcher.
7. Write `%APPDATA%\Telinha\install.json`:
   ```json
   { "installedAt": "<ISO>", "version": "0.1.0", "commit": "a6e4044d",
     "targets": [ { "flavor": "Discord", "app": "app-1.0.9266", "resources": "<abs>", "vencordPatcher": "<abs>",
                    "previous": "vencord-stub", "backup": "<abs or null>" } ] }
   ```

Running install again is the **repair/update** path (new payload, stub refreshed), including after the Vencord
installer's Repair/Install replaced our stub with its own (kind `vencord-stub` again → backed up → replaced).

---

## 5. Uninstall (byte-identical restore)

1. Discord must not be running (4.1).
2. For **every** `app-*` folder of **every** `%LOCALAPPDATA%\Discord*` root (not only the newest: after a Discord
   update Vencord copies our stub into the new folder too) whose `app.asar` is a `telinha-stub`:
   - if `backup\<FlavorDir>\<app-ver>.app.asar` exists, is a `vencord-stub` and its patcher equals the one in our
     stub → write those exact bytes back;
   - otherwise → regenerate Vencord's stub: asar (3.2) with `index.js` = `require(` + JSON string of the patcher
     path + `)`. That is exactly what Vencord's installer writes, so the result is the same bytes either way (the
     dev installer's `status` command checks this per folder: `vencordStubCanonical: true`).
   - atomic write as in 4.6, then re-classify: must be `vencord-stub` with the same patcher.
3. Delete `%APPDATA%\Telinha\addon\`, `backup\` and `install.json`. Keep `logs\` (small, useful for support) unless
   the user asked for a full removal.
4. Leave Vencord and `%APPDATA%\Vencord\settings\settings.json` alone (it keeps a harmless `plugins.Telinha` entry).

---

## 6. Runtime behaviour (what happens at Discord start)

| Situation | Result |
|---|---|
| normal | Vencord + Telinha. `main.log`: `boot`, `loaded {"version":…,"commit":…,"rendererHooked":true,"ipcMapHooked":true,"natives":8,…,"errors":0}`, then `CSP: added 8 sources (chained)` and `renderer served {"metaPatched":true,…}` |
| `%APPDATA%\Telinha\addon\` missing | stub requires Vencord directly: plain Vencord |
| `main.js` throws while loading | stub logs `[Telinha] loader failed` to stderr and requires Vencord: plain Vencord |
| `addon.json` broken / unreadable | logged; no hooks installed; plain Vencord |
| `telinha.main.js` throws | logged; renderer part still loads; `pluginHelpers.Telinha` is left out, so the plugin reports "a parte nativa do Telinha não está carregada" |
| `telinha-audio.exe` missing / quarantined | everything works except whole-screen audio (the plugin says the helper is missing) |
| Vencord's `patcher.js` missing or throws before loading Discord | logged; Discord starts **vanilla** |
| Discord itself throws | rethrown (not ours to hide), same as with Vencord's stub |
| Vencord renamed its IPC channels | dormant fallback preload takes over (logged `preload fallback`) |
| Vencord's `PluginMeta` literal not found | logged `metaPatched:false`; plugin works, only its settings modal / `/vencord-plugins` may error |
| `%APPDATA%\Vencord\dist` is a Vencord build that already contains Telinha (our fork) | addon stays passive: the bundled Telinha wins, ours refuses the duplicate (logged) |
| `--vanilla` command-line flag | handed to Vencord unchanged |

The loader sets `process.env.TELINHA_HELPER_DIR` to its own folder before loading `telinha.main.js`; the plugin's
native code looks for `telinha-audio.exe` there (and next to its own bundle when the variable is absent, which is
the fork build's case: next to `patcher.js`).

## 7. Interplay with Vencord and Discord updates

- **Discord update**: Vencord's `persistAfterDiscordUpdates` copies the *current* `app.asar` (our stub) into the new
  `app-*` folder. Nothing to do.
- **Vencord update** (in-app updater or installer re-download): only `%APPDATA%\Vencord\dist\*` changes; our loader
  reads the new `renderer.js` on every window load.
- **Vencord installer Repair/Install**: replaces our stub with its own → Telinha off, Vencord fine. Re-run our
  install (repair).
- **Vencord installer Uninstall**: restores Discord's original `app.asar` → both off. Our install then refuses
  (`discord-original`) until Vencord is back. Our uninstall finds no `telinha-stub` and only deletes our folder.
