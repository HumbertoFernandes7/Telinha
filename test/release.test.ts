/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// scripts/release.mjs, what CI decides and writes for a release: the version (package.json vs the last vX.Y.Z tag), which
// changes ship, the "## Novidades" taken from the merged pull requests and the notes rendered from the committed
// template. Plain data in, no git, no network (the release format itself, against the updater, is
// addon/test/run-release-test.mjs).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

const SCRIPT = join(__dirname, "..", "scripts", "release.mjs");
const TAGS = ["v0.1.0", "v0.2.0", "v0.2.1", "v0.2.2", "v0.2.3", "v0.2.4", "v0.2.5"];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("releases (scripts/release.mjs)", () => {
    // the script is ES module JavaScript outside the path aliases: loaded once, by path
    let r: any;

    before(async () => {
        r = await import(pathToFileURL(SCRIPT).href);
    });

    describe("version", () => {
        test("the last release tag is the highest plain vX.Y.Z (numeric order; other tags ignored)", () => {
            assert.equal(r.lastReleaseTag(TAGS), "v0.2.5");
            assert.equal(r.lastReleaseTag(["v0.2.9", "v0.2.10", "v0.2.2"]), "v0.2.10");
            assert.equal(r.lastReleaseTag(["v0.2.5", "v0.3.0-beta.1", "v1.0", "0.9.0", "teste-2", "vX"]), "v0.2.5");
            assert.equal(r.lastReleaseTag([]), null);
        });

        test("every release is the last tag + 1 patch while package.json is not ahead", () => {
            assert.deepEqual(r.nextVersion("0.2.5", TAGS), { version: "0.2.6", lastTag: "v0.2.5" });
            assert.deepEqual(r.nextVersion("0.2.5", [...TAGS, "v0.2.6", "v0.2.7"]), { version: "0.2.8", lastTag: "v0.2.7" });
            assert.deepEqual(r.nextVersion("0.2.0", ["v0.2.9"]), { version: "0.2.10", lastTag: "v0.2.9" });
            assert.deepEqual(r.nextVersion("0.1.0", TAGS), { version: "0.2.6", lastTag: "v0.2.5" });
        });

        test("bumping package.json starts a minor or major; after its release, patches continue from it", () => {
            assert.deepEqual(r.nextVersion("0.3.0", TAGS), { version: "0.3.0", lastTag: "v0.2.5" });
            assert.deepEqual(r.nextVersion("1.0.0", TAGS), { version: "1.0.0", lastTag: "v0.2.5" });
            assert.deepEqual(r.nextVersion("0.3.0", [...TAGS, "v0.3.0"]), { version: "0.3.1", lastTag: "v0.3.0" });
            // a package.json equal to the next patch changes nothing
            assert.deepEqual(r.nextVersion("0.2.6", TAGS), { version: "0.2.6", lastTag: "v0.2.5" });
        });

        test("no release tag yet: package.json's version as it is", () => {
            assert.deepEqual(r.nextVersion("0.2.5", []), { version: "0.2.5", lastTag: null });
            assert.deepEqual(r.nextVersion("0.2.5", ["teste-1"]), { version: "0.2.5", lastTag: null });
        });

        test("package.json's version must be a plain X.Y.Z", () => {
            for (const bad of ["0.3", "v0.3.0", "0.3.0-beta.1", "", undefined, "01.2.3"]) assert.throws(() => r.nextVersion(bad, TAGS), /must be X\.Y\.Z/, String(bad));
        });
    });

    describe("what ships", () => {
        test("product paths: plugin, loader, add-on build, audio helper, installer, dependencies, build inputs", () => {
            for (const f of [
                "src/plugins/telinha/index.tsx", "src/plugins/telinha/core/session.ts", "src/plugins/telinha/style.css",
                "addon/loader/updater.js", "addon/build/build-addon.mjs",
                "native-audio/src/telinha-audio.cpp", "native-audio/build.cmd",
                "installer/main.go", "installer/internal/payload/github.go", "installer/winres/winres.json", "installer/rsrc_windows_amd64.syso", "installer/go.mod",
                "package.json", "pnpm-lock.yaml", "vencord.json", "tsconfig.json", "./src\\plugins\\telinha\\index.tsx"
            ]) assert.equal(r.isProductPath(f), true, f);
        });

        test("never on their own: tests, test data, scripts, CI, docs and Markdown anywhere, the coverage floor", () => {
            for (const f of [
                "src/plugins/telinha/core/session.test.ts", "src/plugins/telinha/ui/Bar.test.tsx",
                "test/setup.ts", "test/fakes/webrtc.ts", "addon/test/run-update-test.mjs", "addon/test/fake/update-kit.mjs",
                "installer/main_test.go", "installer/internal/core/core_extra_test.go", "installer/internal/testutil/fakes.go", "installer/internal/testdata/vencord-stub.asar",
                "native-audio/test/tone-test.mjs", "scripts/release.mjs", "scripts/coverage.mjs", ".github/workflows/ci.yml", ".github/release/notes-template.md",
                "docs/releases.md", "README.md", "addon/PAYLOAD.md", "src/plugins/telinha/README.md", "installer/.editorconfig",
                "coverage-floor.json", "eslint.config.mjs", "tsconfig.test.json", "assets/telinha-icon-256.png", "tools/telinha-peer/index.html", "LICENSE"
            ]) assert.equal(r.isProductPath(f), false, f);
        });

        test("a product change since the last tag ships the next version", () => {
            const plan = r.planRelease({ pkgVersion: "0.2.5", tags: TAGS, changed: ["src/plugins/telinha/index.tsx", "src/plugins/telinha/index.test.ts", "README.md"] });
            assert.equal(plan.version, "0.2.6");
            assert.equal(plan.lastTag, "v0.2.5");
            assert.equal(plan.shippable, true);
            assert.deepEqual(plan.product, ["src/plugins/telinha/index.tsx"]);
            assert.deepEqual(plan.other, ["src/plugins/telinha/index.test.ts", "README.md"]);
            assert.match(plan.reason, /1 product file\(s\) changed since v0\.2\.5/);
        });

        test("only tests, docs, CI or scripts: no release, and the reason says so", () => {
            const plan = r.planRelease({ pkgVersion: "0.2.5", tags: TAGS, changed: ["test/setup.ts", ".github/workflows/ci.yml", "docs/releases.md", "coverage-floor.json", "installer/flow_test.go"] });
            assert.equal(plan.shippable, false);
            assert.equal(plan.version, "0.2.6"); // what the run builds and tests as, all the same
            assert.match(plan.reason, /only tests, docs, CI or scripts changed since v0\.2\.5 \(5 file\(s\)\)/);
        });

        test("nothing changed, or a commit that does not descend from the last release: no release", () => {
            assert.equal(r.planRelease({ pkgVersion: "0.2.5", tags: TAGS, changed: [] }).shippable, false);
            const old = r.planRelease({ pkgVersion: "0.2.5", tags: TAGS, changed: ["src/plugins/telinha/index.tsx"], descends: false });
            assert.equal(old.shippable, false);
            assert.match(old.reason, /does not descend from v0\.2\.5/);
        });

        test("no release tag at all: the first release ships package.json's version", () => {
            const plan = r.planRelease({ pkgVersion: "0.1.0", tags: [], changed: [] });
            assert.deepEqual([plan.version, plan.lastTag, plan.shippable], ["0.1.0", null, true]);
        });
    });

    describe("Novidades from the merged pull requests", () => {
        const BODY = "Juntando a develop.\r\n\r\n## Novidades\r\n\r\n<!-- vira a nota da versão -->\r\n- **Volume:** igual na call e na janela.\r\n\r\n### Detalhe\r\n\r\nmais texto\r\n\r\n## Testes\r\n\r\n- pnpm check\r\n";

        test("the section under \"## Novidades\" (### kept, up to the next ## heading, comments dropped, CRLF fixed)", () => {
            assert.equal(r.novidadesSection(BODY), "- **Volume:** igual na call e na janela.\n\n### Detalhe\n\nmais texto");
            assert.equal(r.novidadesSection("## Novidades da 0.2.6\n- a\n# Fim\n- b"), "- a");
            assert.equal(r.novidadesSection("## novidades\n- a"), "- a");
        });

        test("no such heading, or an empty one: null", () => {
            for (const body of ["- só texto", "### Novidades\n- a", "## Novidade\n- a", "## Novidades\n<!-- nada -->\n\n## Testes\n- b", "", null, undefined])
                assert.equal(r.novidadesSection(body), null, String(body));
        });

        test("the newest merge's whole body when it has no heading; earlier merges count only with the heading", () => {
            const merges = [
                { sha: "1", pr: { body: "## Novidades\n- da primeira" } },
                { sha: "2", pr: { body: "corrige o CI, sem seção" } },
                { sha: "3", pr: null },
                { sha: "4", pr: { body: "<!-- modelo -->\nTudo isto vai\n- inteiro" } }
            ];
            assert.equal(r.novidadesFor(merges, ["subject"]), "- da primeira\n\nTudo isto vai\n- inteiro");
            assert.equal(r.novidadesFor([{ sha: "1", pr: { body: BODY } }]), "- **Volume:** igual na call e na janela.\n\n### Detalhe\n\nmais texto");
        });

        test("no pull request with anything: the commit subjects", () => {
            assert.equal(r.novidadesFor([{ sha: "1", pr: null }], ["Viewer: one volume per friend", "Build: x"]), "- Viewer: one volume per friend\n- Build: x");
            assert.equal(r.novidadesFor([{ sha: "1", pr: { body: "" } }], ["a"]), "- a");
            assert.equal(r.novidadesFor([], []), "- Melhorias internas.");
        });

        test("the pull request of a commit: merged by it, merged with it as second parent, else an open one at it", () => {
            const merged = { number: 7, merged_at: "2026-10-30T00:00:00Z", merge_commit_sha: "m1", head: { sha: "d1" }, state: "closed" };
            const intoDevelop = { number: 5, merged_at: "2026-10-29T00:00:00Z", merge_commit_sha: "d1", head: { sha: "f1" }, state: "closed" };
            const open = { number: 9, merged_at: null, merge_commit_sha: "test-merge", head: { sha: "b1" }, state: "open" };
            assert.equal(r.pickPullRequest([intoDevelop, merged], { sha: "m1", parent: "d1" }), merged);
            assert.equal(r.pickPullRequest([intoDevelop, merged], { sha: "other", parent: "d1" }), merged);
            assert.equal(r.pickPullRequest([intoDevelop], { sha: "m1", parent: "d1" }), null);
            assert.equal(r.pickPullRequest([open], { sha: "b1" }), open);
            assert.equal(r.pickPullRequest([{ ...open, state: "closed" }], { sha: "b1" }), null);
            assert.equal(r.pickPullRequest(null, { sha: "m1" }), null);
            assert.equal(r.pickPullRequest([null, 3], { sha: "m1" }), null);
        });
    });

    describe("notes", () => {
        const files = { installer: { name: "TelinhaInstaller.exe", sha256: HASH_A }, addon: { name: "Telinha-addon-0123abcd.zip", sha256: HASH_B } };
        const render = (template: string, novidades = "- nova") => r.renderNotes(template, { version: "0.2.6", novidades, commit: "0123abcd", ...files });

        test("the committed template: every placeholder filled, the SHA-256 lines in the format the updater reads", () => {
            const notes = render(readFileSync(r.TEMPLATE, "utf8"));
            assert.ok(!notes.includes("{{") && !notes.includes("<!--"));
            assert.ok(notes.startsWith("O **Telinha** deixa"));
            assert.ok(notes.includes("ele baixa a 0.2.6 sozinho") && notes.includes("## Novidades da 0.2.6\n\n- nova\n\n## Como instalar"));
            assert.ok(notes.includes(`## Conferência dos arquivos (SHA-256)\n\n- \`TelinhaInstaller.exe\`: \`${HASH_A}\`\n- \`Telinha-addon-0123abcd.zip\`: \`${HASH_B}\`\n\nCódigo-fonte desta versão: commit \`0123abcd\`.`));
            assert.ok(notes.endsWith("nem pelo Discord.\n"));
        });

        test("the Novidades text goes in as it is (no $ patterns, no placeholders of its own)", () => {
            assert.ok(render("{{VERSION}} {{NOVIDADES}} {{CHECKSUMS}} {{COMMIT}}", "custa $& e $1 {{VERSION}}").includes("custa $& e $1 {{VERSION}}"));
        });

        test("an unknown or missing placeholder is an error", () => {
            assert.throws(() => render("{{VERSION}} {{NOVIDADES}} {{CHECKSUMS}} {{COMMIT}} {{DATE}}"), /unknown placeholder \{\{DATE\}\}/);
            assert.throws(() => render("{{VERSION}} {{NOVIDADES}} {{COMMIT}}"), /\{\{CHECKSUMS\}\} is missing/);
            // a placeholder inside an HTML comment does not count
            assert.throws(() => render("<!-- {{CHECKSUMS}} -->{{VERSION}} {{NOVIDADES}} {{COMMIT}}"), /\{\{CHECKSUMS\}\} is missing/);
        });
    });

    describe("the published folder", () => {
        let root: string;

        before(() => {
            root = mkdtempSync(join(tmpdir(), "tl-release-"));
        });

        after(() => {
            rmSync(root, { recursive: true, force: true });
        });

        const folder = (names: string[]) => {
            const dir = mkdtempSync(join(root, "a-"));
            for (const n of names) writeFileSync(join(dir, n), n);
            return dir;
        };

        test("the installer, one add-on zip and its .sha256", () => {
            const a = r.readAssets(folder(["TelinhaInstaller.exe", "Telinha-addon-0123abcd.zip", "Telinha-addon-0123abcd.zip.sha256"]));
            assert.deepEqual([a.installer.name, a.zip.name, a.sum.name], ["TelinhaInstaller.exe", "Telinha-addon-0123abcd.zip", "Telinha-addon-0123abcd.zip.sha256"]);
            assert.equal(a.zip.sha256, createHash("sha256").update("Telinha-addon-0123abcd.zip").digest("hex"));
            assert.equal(a.installer.bytes.toString(), "TelinhaInstaller.exe");
        });

        test("no zip, two zips or a missing file: an error that says which", () => {
            assert.throws(() => r.readAssets(folder(["TelinhaInstaller.exe"])), /exactly one Telinha-addon-\*\.zip, found none/);
            assert.throws(() => r.readAssets(folder(["TelinhaInstaller.exe", "Telinha-addon-a.zip", "Telinha-addon-b.zip"])), /found Telinha-addon-a\.zip, Telinha-addon-b\.zip/);
            assert.throws(() => r.readAssets(folder(["Telinha-addon-a.zip", "Telinha-addon-a.zip.sha256"])), /TelinhaInstaller\.exe is missing/);
            assert.throws(() => r.readAssets(folder(["TelinhaInstaller.exe", "Telinha-addon-a.zip"])), /Telinha-addon-a\.zip\.sha256 is missing/);
        });
    });
});
