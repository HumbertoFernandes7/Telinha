/*
 * Telinha - releases from CI: every merge into main that changes the product publishes a GitHub release with the
 * installer, the add-on zip and their SHA-256 (docs/releases.md). .github/workflows/ci.yml runs three steps:
 *
 *   node scripts/release.mjs plan [--github-output <file>] [--github-env <file>] [--summary <file>]
 *       The version this commit is built as, and whether it ships. Version: the greater of package.json's version and
 *       the highest vX.Y.Z tag plus one patch (bump package.json to 0.3.0 to start a minor; otherwise every release is
 *       +1 patch). Ships when the diff from that tag touches a product file (isProductPath below) and HEAD descends from
 *       the tag. Prints key=value lines (also appended to --github-output), TELINHA_VERSION=<version> goes to
 *       --github-env (read by build-addon.mjs and installer\build.cmd), and a markdown report to --summary.
 *   node scripts/release.mjs notes --version <X.Y.Z> --assets <dir> --out <file> [--last-tag <tag>] [--pr-body <file>]
 *       The release notes: .github/release/notes-template.md with "## Novidades da X" taken from the pull requests merged
 *       into this branch since the last release (their "## Novidades" section; the newest one's whole body when it has
 *       no such heading; none at all: the commit subjects), and the SHA-256 lines of the files in --assets. The PRs are
 *       found with `gh api` (GH_TOKEN, GITHUB_REPOSITORY); --pr-body <file> uses that file as the newest PR's body.
 *   node scripts/release.mjs verify --version <X.Y.Z> --assets <dir> --notes <file> [--installed <X.Y.Z>]
 *                                    [--commit <sha>] [--release-json <file>]
 *       The release as the add-on's own updater (addon/loader/updater.js) sees it, against the fake GitHub of
 *       addon/test/fake/update-kit.mjs: every published SHA-256 (asset digest, <zip>.sha256, the line in the notes)
 *       agrees, the tag, the zip's version.json and the installed version are in order, and an installed --installed
 *       (default 0.0.0) downloads and stages it. --commit: the zip must be built from that commit, from a clean tree.
 *       --release-json: GitHub's own JSON of the created release (gh api), so its body and digests are the ones checked.
 *       The installer (installer/internal/payload/github.go) reads the same SHA-256 sources with the same rules.
 *
 * --assets holds exactly what is published: TelinhaInstaller.exe, Telinha-addon-<commit>.zip and its .sha256.
 * Exit code 1 on any failure. Nothing here publishes anything (the workflow calls gh release create).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { execFileSync } from "child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { fakeGitHub, makeHome, makePayload, sha256, upd, updaterFor } from "../addon/test/fake/update-kit.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE = join(REPO, ".github", "release", "notes-template.md");
export const GITHUB_REPO = "HumbertoFernandes7/Telinha";
export const INSTALLER = "TelinhaInstaller.exe";
const ZIP_RE = /^Telinha-addon-[0-9A-Za-z._-]+\.zip$/; // the updater's ASSET_RE

// ------------------------------------------------------------------------------------------- versions

const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** "0.2.5" -> [0, 2, 5]; null for anything else (no "v", no pre-release: releases are plain X.Y.Z). */
export function parseVersion(v) {
    const m = PLAIN.exec(String(v ?? "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
}

/** The highest release tag (vX.Y.Z; pre-release and other tags ignored), or null. */
export function lastReleaseTag(tags) {
    let best = null;
    for (const t of tags) {
        const tag = String(t).trim();
        if (!tag.startsWith("v") || !parseVersion(tag.slice(1))) continue;
        if (!best || compareVersions(tag.slice(1), best.slice(1)) > 0) best = tag;
    }
    return best;
}

/** max(package.json version, last release tag + 1 patch). */
export function nextVersion(pkgVersion, tags) {
    if (!parseVersion(pkgVersion)) throw new Error(`package.json "version" must be X.Y.Z (got ${JSON.stringify(pkgVersion)})`);
    const lastTag = lastReleaseTag(tags);
    if (!lastTag) return { version: pkgVersion, lastTag };
    const [major, minor, patch] = parseVersion(lastTag.slice(1));
    const bumped = `${major}.${minor}.${patch + 1}`;
    return { version: compareVersions(pkgVersion, bumped) > 0 ? pkgVersion : bumped, lastTag };
}

// ------------------------------------------------------------------------------------------- what ships

/**
 * Files whose change is a change for users: the plugin (src/, tests excluded), the add-on loader and its build, the
 * audio helper, the installer (tests and test data excluded), the dependencies, and what the add-on is compiled with
 * (vencord.json pins the Vencord it is built against, tsconfig.json is handed to esbuild). Everything else (test/,
 * scripts/, .github/, docs, Markdown anywhere, coverage-floor.json, assets/...) never makes a release on its own.
 */
export function isProductPath(file) {
    const f = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
    if (["package.json", "pnpm-lock.yaml", "vencord.json", "tsconfig.json"].includes(f)) return true;
    if (/\.md$/i.test(f) || /(^|\/)\.editorconfig$/.test(f)) return false;
    if (f.startsWith("src/")) return !/\.test\.tsx?$/.test(f);
    if (f.startsWith("addon/loader/") || f.startsWith("addon/build/")) return true;
    if (f.startsWith("native-audio/")) return !f.startsWith("native-audio/test/");
    if (f.startsWith("installer/")) return !/_test\.go$/.test(f) && !/^installer\/(.*\/)?(testutil|testdata)\//.test(f);
    return false;
}

/**
 * The release plan from plain facts (so it can be tested without git): package.json's version, the repository's tags,
 * the files changed since the last release tag and whether HEAD descends from it.
 */
export function planRelease({ pkgVersion, tags, changed = [], descends = true }) {
    const { version, lastTag } = nextVersion(pkgVersion, tags);
    const product = changed.filter(isProductPath);
    const other = changed.filter(f => !isProductPath(f));
    let shippable;
    let reason;
    if (!lastTag) {
        shippable = true;
        reason = "no vX.Y.Z tag yet: the first release";
    } else if (!descends) {
        shippable = false;
        reason = `this commit does not descend from ${lastTag} (an older commit run again?): nothing to release`;
    } else if (!changed.length) {
        shippable = false;
        reason = `nothing changed since ${lastTag}`;
    } else if (!product.length) {
        shippable = false;
        reason = `only tests, docs, CI or scripts changed since ${lastTag} (${other.length} file(s)): no release`;
    } else {
        shippable = true;
        reason = `${product.length} product file(s) changed since ${lastTag}`;
    }
    return { version, lastTag, pkgVersion, shippable, reason, product, other };
}

// ------------------------------------------------------------------------------------------- release notes

const stripComments = s => s.replace(/<!--[\s\S]*?-->[ \t]*\n?/g, "");
const normalize = s => String(s ?? "").replace(/\r\n?/g, "\n");

/** The text under a "## Novidades..." heading (up to the next # or ## heading), or null when there is none or it is empty. */
export function novidadesSection(body) {
    const lines = stripComments(normalize(body)).split("\n");
    const start = lines.findIndex(l => /^ {0,3}##\s+Novidades\b/i.test(l));
    if (start === -1) return null;
    let end = lines.findIndex((l, i) => i > start && /^ {0,3}#{1,2}\s/.test(l));
    if (end === -1) end = lines.length;
    return lines.slice(start + 1, end).join("\n").trim() || null;
}

/** The pull request a commit on the release branch came from (GitHub's "commits/{sha}/pulls" answers), or null. */
export function pickPullRequest(prs, { sha, parent = null }) {
    const list = (Array.isArray(prs) ? prs : []).filter(p => p && typeof p === "object");
    return list.find(p => p.merged_at && p.merge_commit_sha === sha) // merged by this very commit (merge, squash, rebase)
        ?? (parent ? list.find(p => p.merged_at && p.head?.sha === parent) : undefined) // a merge whose 2nd parent is the PR head
        ?? list.find(p => p.state === "open" && p.head?.sha === sha) // not merged: a dry run on a PR's branch
        ?? null;
}

/**
 * "## Novidades" for the release. merges: the commits merged into the branch since the last release, oldest first,
 * each with its pull request (or null). Every PR's "## Novidades" section, in order; the newest merge's whole body when
 * it has no such heading; when no PR gave anything, the commit subjects.
 */
export function novidadesFor(merges, subjects = []) {
    const parts = [];
    merges.forEach((m, i) => {
        if (!m.pr) return;
        const text = novidadesSection(m.pr.body) ?? (i === merges.length - 1 ? stripComments(normalize(m.pr.body)).trim() : "");
        if (text) parts.push(text);
    });
    if (parts.length) return parts.join("\n\n");
    return subjects.length ? subjects.map(s => `- ${s}`).join("\n") : "- Melhorias internas.";
}

/** The two lines the installer and the updater read the SHA-256 from: each names its file and carries its hash. */
export const checksumLines = ({ installer, addon }) => [installer, addon].map(f => `- \`${f.name}\`: \`${f.sha256}\``).join("\n");

/**
 * The template with its placeholders filled ({{VERSION}}, {{NOVIDADES}}, {{CHECKSUMS}}, {{COMMIT}}); HTML comments are
 * dropped. An unknown placeholder or a missing required one is an error.
 */
export function renderNotes(template, { version, novidades, installer, addon, commit }) {
    const values = { VERSION: version, NOVIDADES: String(novidades).trim(), CHECKSUMS: checksumLines({ installer, addon }), COMMIT: commit };
    const used = new Set();
    const out = stripComments(normalize(template)).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
        if (!Object.hasOwn(values, key)) throw new Error(`notes template: unknown placeholder {{${key}}}`);
        used.add(key);
        return values[key];
    });
    for (const key of Object.keys(values)) if (!used.has(key)) throw new Error(`notes template: {{${key}}} is missing`);
    return out.replace(/^\n+/, "").replace(/\n*$/, "\n");
}

// ------------------------------------------------------------------------------------------- the assets

/** The published files in a folder: { installer, zip, sum } (each { name, path, bytes, sha256 }). */
export function readAssets(dir) {
    const names = readdirSync(dir);
    const zips = names.filter(n => ZIP_RE.test(n));
    if (zips.length !== 1) throw new Error(`${dir}: expected exactly one Telinha-addon-*.zip, found ${zips.length ? zips.join(", ") : "none"}`);
    const file = name => {
        const path = join(dir, name);
        if (!existsSync(path)) throw new Error(`${dir}: ${name} is missing`);
        const bytes = readFileSync(path);
        return { name, path, bytes, sha256: sha256(bytes) };
    };
    return { installer: file(INSTALLER), zip: file(zips[0]), sum: file(`${zips[0]}.sha256`) };
}

/** version.json inside the zip (the updater's own reader: the zip must be one it accepts). */
export const zipManifest = zip => upd.readPayloadZip(zip).manifest;

// ------------------------------------------------------------------------------------------- verify

/**
 * The release through the updater's own checks. Returns [{ label, ok, detail }]; nothing is thrown for a failed check.
 *   version, notes, zip/zipName/sumText (the zip and its .sha256), installer (bytes)
 *   installedVersion  the version an installed copy has (default 0.0.0): it must update to this release
 *   commit            when given: the zip must come from this commit (a prefix of it) and a clean tree
 *   release           GitHub's JSON of the created release: its body, tag and asset digests are the ones checked
 */
export async function verifyRelease({ version, notes, zip, zipName, sumText, installer, installedVersion = "0.0.0", commit = null, release = null }) {
    const checks = [];
    const check = (label, ok, detail) => checks.push({ label, ok: !!ok, detail });
    const zipSha = sha256(zip);
    const rawBody = release ? String(release.body ?? "") : String(notes); // what the updater is served, as it is
    const body = normalize(rawBody);
    const tag = release ? String(release.tag_name ?? "") : `v${version}`;
    const releaseAsset = name => (Array.isArray(release?.assets) ? release.assets : []).find(a => a?.name === name);

    check(`version ${version} is a plain X.Y.Z, newer than the installed ${installedVersion}`, parseVersion(version) && parseVersion(installedVersion) && compareVersions(version, installedVersion) > 0);
    check(`tag ${tag} is version ${version} for the updater`, upd.plainVersion(tag) === version && tag === `v${version}`, upd.plainVersion(tag));
    let manifest = null;
    try {
        manifest = zipManifest(zip);
    } catch (e) {
        check("the zip is a payload the updater accepts", false, e.message);
    }
    if (manifest) {
        check(`the zip's version.json says ${version}`, manifest.version === version, manifest.version);
        check(`zip named after its commit (${manifest.commit}) and picked by the updater's asset pattern`, zipName === `Telinha-addon-${manifest.commit}.zip` &&
            upd.pickAsset({ assets: [{ name: INSTALLER }, { name: `${zipName}.sha256` }, { name: zipName }] })?.name === zipName, zipName);
        if (commit) check(`built from ${commit.slice(0, 8)}, from a clean tree`, !/-dirty$/.test(manifest.commit) && String(commit).startsWith(manifest.commit), manifest.commit);
    }
    check(`${zipName}.sha256 names the zip's SHA-256`, upd.hashFromSumFile(sumText, zipName) === zipSha, sumText.trim());
    check("the release notes name the zip's SHA-256", upd.hashFromReleaseBody(body, zipName) === zipSha, upd.hashFromReleaseBody(body, zipName) || "no line names the zip with a SHA-256");
    check(`the release notes name ${INSTALLER}'s SHA-256`, body.includes(`\`${INSTALLER}\`: \`${sha256(installer)}\``));
    check("no placeholder left in the notes", !/\{\{\s*\w+\s*\}\}/.test(body));
    check(`notes have "## Novidades da ${version}"`, body.includes(`## Novidades da ${version}\n`));

    // GitHub's digest of an asset: computed by GitHub on upload (absent on old releases, which the updater tolerates)
    const digestOf = name => String(releaseAsset(name)?.digest ?? "").toLowerCase().replace(/^sha256:/, "") || null;
    if (release) {
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const digestOk = (name, sha) => [null, sha].includes(digestOf(name));
        check("GitHub release: exactly the installer, the zip and its .sha256", JSON.stringify(assets.map(a => a?.name).sort()) === JSON.stringify([INSTALLER, zipName, `${zipName}.sha256`].sort()), assets.map(a => a?.name));
        check("GitHub's asset digests match the files", digestOk(zipName, zipSha) && digestOk(INSTALLER, sha256(installer)) && digestOk(`${zipName}.sha256`, sha256(Buffer.from(sumText))), assets.map(a => `${a?.name} ${a?.digest}`));
        check("GitHub release is not a pre-release", release.prerelease === false);
    }

    // the updater itself: an installed copy checks releases/latest, downloads, verifies against every hash, stages
    const digest = release ? digestOf(zipName) : zipSha;
    const run = async notesBody => {
        const home = makeHome({ installed: makePayload({ version: installedVersion, commit: "installed" }) });
        try {
            const gh = fakeGitHub();
            gh.publish(tag, zip, { name: zipName, digest, sumFile: sumText, body: notesBody });
            const u = updaterFor(home, { fetch: gh.fetch });
            const status = await u.check({ autoDownload: true });
            const staged = u.lines.find(l => l.startsWith("update: staged"));
            const sources = staged ? JSON.parse(staged.slice(staged.indexOf("{"))).checkedAgainst : [];
            return { status, sources };
        } finally {
            home.cleanup();
        }
    };
    const good = await run(rawBody);
    check(`an installed ${installedVersion} downloads, verifies and stages ${version}`, good.status.phase === "ready" && good.status.ready === version, good.status.error ?? good.status.phase);
    const want = [digest && "GitHub (digest do asset)", `${zipName}.sha256`, "notas da release"].filter(Boolean);
    check(`checked against: ${want.join(", ")}`, want.every(s => good.sources.includes(s)), good.sources);
    const bad = await run(rawBody.replace(new RegExp(zipSha, "gi"), "0".repeat(64)));
    check("the same release with another SHA-256 in the notes is refused (the notes line is really read)", bad.status.phase === "error" && bad.status.error?.kind === "checksum", bad.status.error ?? bad.status.phase);
    return checks;
}

// ------------------------------------------------------------------------------------------- git / gh (CLI only)

function git(...args) {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOk(...args) {
    try {
        execFileSync("git", args, { cwd: REPO, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function ghApi(path) {
    return JSON.parse(execFileSync("gh", ["api", path], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** The commits merged into this branch since lastTag (first parents, oldest first), with their pull requests. */
function mergesSince(lastTag, repo) {
    const range = lastTag ? [`${lastTag}..HEAD`] : ["-1", "HEAD"];
    const shas = git("rev-list", "--first-parent", "--reverse", ...range).split("\n").filter(Boolean);
    return shas.map(sha => {
        const parent = git("rev-list", "--parents", "-n", "1", sha).trim().split(" ")[2] ?? null;
        let pr = pickPullRequest(ghApi(`repos/${repo}/commits/${sha}/pulls`), { sha, parent });
        if (!pr && parent) pr = pickPullRequest(ghApi(`repos/${repo}/commits/${parent}/pulls`), { sha, parent });
        console.log(`[release] ${sha.slice(0, 8)}: ${pr ? `PR #${pr.number} (${pr.title})` : "no pull request"}`);
        return { sha, pr };
    });
}

// ------------------------------------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const opt = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const need = name => opt(name) ?? die(`${name} is required`);

function die(msg) {
    console.error(`[release] FAILED - ${msg}`);
    process.exit(1);
}

function cmdPlan() {
    const pkgVersion = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    const lastTag = lastReleaseTag(tags);
    const changed = lastTag ? git("diff", "--name-only", "--no-renames", "-z", lastTag, "HEAD").split("\0").filter(Boolean) : [];
    const descends = lastTag ? gitOk("merge-base", "--is-ancestor", lastTag, "HEAD") : true;
    const plan = planRelease({ pkgVersion, tags, changed, descends });
    const out = { version: plan.version, last_tag: plan.lastTag ?? "", shippable: String(plan.shippable), reason: plan.reason };
    const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
    console.log(lines.join("\n"));
    if (opt("--github-output")) appendFileSync(opt("--github-output"), lines.join("\n") + "\n");
    if (opt("--github-env")) appendFileSync(opt("--github-env"), `TELINHA_VERSION=${plan.version}\n`);
    if (opt("--summary")) {
        const list = files => files.slice(0, 50).map(f => `- \`${f}\``).join("\n") + (files.length > 50 ? `\n- ... ${files.length - 50} more` : "");
        const md = [
            "## Release plan",
            "",
            `Version **${plan.version}** (package.json ${plan.pkgVersion}, last release ${plan.lastTag ?? "none"}). ` +
            `${plan.shippable ? "**Ships**" : "**No release**"}: ${plan.reason}. Only a push to main publishes; this run builds and tests as ${plan.version}.`,
            ""
        ];
        if (plan.product.length) md.push("<details><summary>Product files changed</summary>", "", list(plan.product), "", "</details>", "");
        if (plan.other.length) md.push("<details><summary>Other files changed (never a release on their own)</summary>", "", list(plan.other), "", "</details>", "");
        appendFileSync(opt("--summary"), md.join("\n") + "\n");
    }
}

function cmdNotes() {
    const version = need("--version");
    const assets = readAssets(resolve(need("--assets")));
    const lastTag = opt("--last-tag") || lastReleaseTag(git("tag", "--list", "v*").split("\n").filter(Boolean));
    let merges;
    if (opt("--pr-body")) merges = [{ sha: "HEAD", pr: { body: readFileSync(resolve(opt("--pr-body")), "utf8") } }];
    else merges = mergesSince(lastTag, process.env.GITHUB_REPOSITORY || GITHUB_REPO);
    const subjects = git("log", "--no-merges", "--format=%s", ...(lastTag ? [`${lastTag}..HEAD`] : ["-n", "30", "HEAD"])).split("\n").filter(Boolean);
    const commit = zipManifest(assets.zip.bytes).commit;
    const notes = renderNotes(readFileSync(TEMPLATE, "utf8"), {
        version, novidades: novidadesFor(merges, subjects), commit,
        installer: { name: assets.installer.name, sha256: assets.installer.sha256 }, addon: { name: assets.zip.name, sha256: assets.zip.sha256 }
    });
    writeFileSync(resolve(need("--out")), notes);
    console.log(`[release] notes for ${version} written to ${need("--out")} (${notes.length} chars)`);
}

async function cmdVerify() {
    const assets = readAssets(resolve(need("--assets")));
    const checks = await verifyRelease({
        version: need("--version"), notes: normalize(readFileSync(resolve(need("--notes")), "utf8")),
        zip: assets.zip.bytes, zipName: assets.zip.name, sumText: assets.sum.bytes.toString("utf8"), installer: assets.installer.bytes,
        installedVersion: opt("--installed") || "0.0.0", commit: opt("--commit") ?? null,
        release: opt("--release-json") ? JSON.parse(readFileSync(resolve(opt("--release-json")), "utf8")) : null
    });
    for (const c of checks) console.log(`${c.ok ? "  ok  " : "  FAIL"} ${c.label}${!c.ok && c.detail !== undefined ? "  -> " + JSON.stringify(c.detail) : ""}`);
    const failed = checks.filter(c => !c.ok).length;
    console.log(failed ? `\nRELEASE CHECK FAILED (${failed})` : "\nRELEASE CHECK PASSED");
    process.exit(failed ? 1 : 0);
}

// run as a script (not when the tests import it)
if (resolve(process.argv[1] ?? "").toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    const commands = { plan: cmdPlan, notes: cmdNotes, verify: cmdVerify };
    const run = commands[argv[0]] ?? (() => die(`usage: node scripts/release.mjs plan|notes|verify ... (got ${JSON.stringify(argv[0] ?? "")})`));
    try {
        await run();
    } catch (e) {
        die(e?.stderr ? `${e.message}\n${e.stderr}` : e?.message ?? String(e));
    }
}
