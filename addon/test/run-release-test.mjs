/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Offline test of the release format (docs/releases.md): the add-on zip just built (dist/addon, `pnpm build:addon`) and
 * its .sha256, with release notes rendered from the committed .github/release/notes-template.md, go through the add-on
 * updater's own checks (scripts/release.mjs verifyRelease: every published SHA-256, tag vs version.json vs installed
 * version, download + stage from the fake GitHub of fake/update-kit.mjs). A template or build change that would make
 * installed copies refuse the next release fails here, on every pull request, long before anything is published.
 *
 *   node addon/test/run-release-test.mjs [--payload <dir>]
 *
 * The installer in the notes is dist\installer\TelinhaInstaller.exe when it was built, else a stand-in (only its hash is
 * used). Never touches the real Discord, %APPDATA% or GitHub.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

import { INSTALLER, novidadesFor, renderNotes, TEMPLATE, verifyRelease } from "../../scripts/release.mjs";
import { makeChecker, pickPayload, REPO } from "./common.mjs";
import { sha256 } from "./fake/update-kit.mjs";

const { check, finish } = makeChecker();
const payload = pickPayload();
const { version, commit } = payload.version;
const zipDir = dirname(payload.dir);
const zipName = `Telinha-addon-${commit}.zip`;

if (!existsSync(join(zipDir, zipName)) || !existsSync(join(zipDir, `${zipName}.sha256`))) {
    console.log(`R skipped: no ${zipName} (+ .sha256) next to ${payload.dir} (run \`pnpm build:addon\`)`);
    finish();
}

const zip = readFileSync(join(zipDir, zipName));
const sumText = readFileSync(join(zipDir, `${zipName}.sha256`), "utf8");
const builtInstaller = join(REPO, "dist", "installer", INSTALLER);
const installer = existsSync(builtInstaller) ? readFileSync(builtInstaller) : Buffer.from("stand-in for TelinhaInstaller.exe\n");
console.log(`Release ${version}: ${zipName} (${zip.length} bytes), installer ${existsSync(builtInstaller) ? builtInstaller : "(stand-in)"}\n`);

// a develop -> main pull request body as the owner writes it: only its "## Novidades" goes into the notes
const PR_BODY = [
    "Merge de develop: correções da semana.",
    "",
    "## Novidades",
    "",
    "<!-- o que entra nas notas da versão -->",
    "- **Volume por amigo:** o volume fica igual na call e na janela.",
    "",
    "**Da 0.2.4:** qualidade automática pela placa de vídeo.",
    "",
    "## Testes",
    "",
    "- pnpm check"
].join("\r\n");

console.log("R1 notes rendered from .github/release/notes-template.md");
let notes = "";
try {
    notes = renderNotes(readFileSync(TEMPLATE, "utf8"), {
        version, commit, novidades: novidadesFor([{ pr: { body: PR_BODY } }]),
        installer: { name: INSTALLER, sha256: sha256(installer) }, addon: { name: zipName, sha256: sha256(zip) }
    });
} catch (e) {
    check("the template renders", false, e.message);
}
check(`"Já tem o Telinha?" and "## Novidades da ${version}"`, notes.includes(`ele baixa a ${version} sozinho`) && notes.includes(`## Novidades da ${version}\n\n- **Volume por amigo:**`));
check("only the PR's \"## Novidades\" section, without its HTML comment or the rest of the body", notes.includes("**Da 0.2.4:** qualidade") && !notes.includes("Merge de develop") && !notes.includes("pnpm check") && !notes.includes("<!--"));
check("the fixed sections are all there, in order", ["## Novidades da", "## Como instalar", "## O que dá pra fazer", "## Avisos", "## Deu problema?", "## Conferência dos arquivos (SHA-256)"]
    .map(h => notes.indexOf(h)).every((at, i, all) => at > 0 && (i === 0 || at > all[i - 1])));
check(`commit line names ${commit}`, notes.includes(`Código-fonte desta versão: commit \`${commit}\`.`));

console.log("\nR2 the release through the updater's own checks (an installed 0.0.0 updates to it)");
for (const c of await verifyRelease({ version, notes, zip, zipName, sumText, installer })) check(c.label, c.ok, c.detail);

console.log("\nR3 the same checks catch a broken release");
{
    const failed = async (label, opts) => {
        const checks = await verifyRelease({ version, notes, zip, zipName, sumText, installer, ...opts });
        check(label, checks.some(c => !c.ok), checks.filter(c => !c.ok).map(c => c.label));
    };
    await failed("notes without the SHA-256 lines", { notes: notes.replace(/^- `Telinha-addon-.*$/m, "") });
    await failed("tag one version ahead of the zip's version.json", { version: version.replace(/\d+$/, n => String(Number(n) + 1)) });
    await failed("installed copy already on this version (no update)", { installedVersion: version });
    await failed(".sha256 of another file", { sumText: `${"1".repeat(64)}  ${zipName}\n` });
}

finish();
