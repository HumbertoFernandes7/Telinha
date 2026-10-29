// Telinha stub v1 (resources/app.asar -> index.js). Written by the Telinha installer in place of Vencord's
// one-line stub `require("<...>\\Vencord\\dist\\patcher.js")`, keeping the same contract:
//   Telinha loader (hooks)  ->  official Vencord patcher.js  ->  Discord (_app.asar)
// Vencord's persistAfterDiscordUpdates copies THIS file into new app-* folders after Discord updates.
// Contract: addon/PAYLOAD.md section 3. Never let a Telinha problem keep Discord from starting.
"use strict";
const TELINHA_LOADER = __TELINHA_LOADER__;
const VENCORD_PATCHER = __VENCORD_PATCHER__;
const fs = require("fs");

// Same thing Vencord's patcher.ts does before loading Discord, minus Vencord: used only when Vencord is gone.
function vanilla() {
    const path = require("path");
    const asarPath = path.join(path.dirname(require.main.filename), "..", "_app.asar");
    const pkg = require(path.join(asarPath, "package.json"));
    require.main.filename = path.join(asarPath, pkg.main);
    require("electron").app.setAppPath(asarPath);
    require(require.main.filename);
}

let loader = null;
try {
    if (fs.existsSync(TELINHA_LOADER)) loader = require(TELINHA_LOADER);
} catch (err) {
    console.error("[Telinha] loader failed to load, starting Vencord without Telinha", err);
    loader = null;
}

if (loader && typeof loader.boot === "function") {
    loader.boot({ vencordPatcher: VENCORD_PATCHER, vanilla });
} else if (fs.existsSync(VENCORD_PATCHER)) {
    require(VENCORD_PATCHER);
} else {
    console.error("[Telinha] Neither Telinha nor Vencord found, starting Discord without mods");
    vanilla();
}
