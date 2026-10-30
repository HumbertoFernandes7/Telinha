# How releases work

Releases are published by CI, never by hand: every merge into `main` that changes the product becomes a GitHub release
(`vX.Y.Z`, marked latest) with `TelinhaInstaller.exe`, `Telinha-addon-<commit>.zip`, its `.zip.sha256` and the notes.
Installed copies pick it up through the automatic updater (`addon/loader/updater.js`), new users through the
installer, both from `releases/latest`.

## Branches

- **`develop`**: day-to-day work. Feature branches open pull requests into `develop`; CI runs on every pull request
  and push, into `develop` and into `main` alike. Nothing is released from `develop`.
- **`main`**: the official line. A pull request **`develop` → `main`** is "ship it": when it is merged, CI runs every
  gate again on the merge commit and, if they pass and the product changed, publishes the release. Nobody pushes to
  `main` directly.

## What to write in the `develop` → `main` pull request

A `## Novidades` section, in Portuguese, for the people who use Telinha: it becomes "Novidades da X.Y.Z" in the release
notes. Everything else in the description stays out of the notes. Include the short "**Da 0.2.x:**" recap lines of the
earlier versions there too, if you want them (copy them from the last release's notes and add one line).

```markdown
Merge da develop: volume por amigo e correções.

## Novidades

- **Um volume só por amigo:** o volume que você escolhe agora é o mesmo na call e na janela separada.

**Da 0.2.5:** ...

## Testes

- pnpm check
```

Without a `## Novidades` heading the **whole description** goes into the notes. Without any pull request (a commit
pushed to `main`) the notes list the commit subjects since the last release. If several merges into `main` are released
together (see "Several merges in a row"), the `## Novidades` of each one is used, oldest first. The description can be
fixed after the merge: the notes are written by the release job, so re-running a failed one uses the new text.

The rest of the notes is fixed text in [`.github/release/notes-template.md`](../.github/release/notes-template.md)
(intro, "Já tem o Telinha?", "Como instalar", "O que dá pra fazer", "Avisos", "Deu problema?"). Edit it there; the
SHA-256 lines and the commit line are generated, because the installer and the updater read the zip's SHA-256 from the
line that names the zip.

## Version

The next version is the greater of:

- `package.json`'s `"version"`, and
- the highest `vX.Y.Z` tag plus one patch.

So every release is the previous one + 1 patch (0.2.5 → 0.2.6 → 0.2.7...), and nobody edits a version number for it.
**To start a minor or major version**, set `package.json`'s `"version"` to it (for example `0.3.0`) in a pull request;
the next release is 0.3.0, the one after it 0.3.1. `package.json` is a floor, not the current version: it is not bumped
after each release.

The same version goes everywhere: the add-on's `version.json` (`build-addon.mjs` reads `TELINHA_VERSION`), the
installer's `--version` and file properties (`installer\build.cmd` and go-winres in CI), the tag and the title. Local
builds without `TELINHA_VERSION` use `package.json`'s version and the committed `rsrc_windows_*.syso`.

## When a merge does not release

Only changes to the product release. The diff from the last `vX.Y.Z` tag must touch at least one of:

- `src/**` (except `*.test.ts` / `*.test.tsx`), `addon/loader/**`, `addon/build/**`, `native-audio/**` (except `test/`),
  `installer/**` (except `*_test.go`, `internal/testutil/`, `internal/testdata/`)
- `package.json`, `pnpm-lock.yaml`, `vencord.json` (the Vencord the add-on is compiled against), `tsconfig.json` (handed
  to esbuild)

Markdown files never count, wherever they are. A merge that only changes tests, `test/**`, `scripts/**`, `.github/**`,
docs or `coverage-floor.json` publishes nothing; the job summary of the CI run says why ("Release plan"). The next merge
that does change the product releases everything since the last tag. The exact rule is `isProductPath` in
[`scripts/release.mjs`](../scripts/release.mjs) (unit tests in `test/release.test.ts`).

## What CI does

All in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

1. **`check`** (Windows), on every run: `scripts/release.mjs plan` computes the version and whether this commit ships;
   every build below carries that version (`TELINHA_VERSION`), on pull requests too. Then the usual gates: `pnpm check`
   (which also runs `addon/test/run-release-test.mjs`: the notes template rendered for the zip just built, run through
   the updater's own checks), coverage, `go vet` / `go test`, the installer build, the update test's group G, the
   coverage floor. Only after all of them pass, and only for a push to `main` that ships (or a dry run), the installer,
   zip and `.sha256` are uploaded as the `release-files` artifact, and their SHA-256 passed on as job outputs.
2. **`release`** (Linux, the only job with `contents: write`): checks the artifact against those hashes (the files
   built and tested in this run, never rebuilt), writes the notes (`scripts/release.mjs notes`), checks the whole
   release with the add-on's updater against a fake GitHub (`scripts/release.mjs verify`: every SHA-256 the updater and
   the installer read agrees, the tag, the zip's `version.json` and the last release are in order, an installed copy
   of the last release downloads and stages it, the zip was built from this commit from a clean tree), then
   `gh release create vX.Y.Z --target <commit> --latest` with the three files. It then reads the release back from
   GitHub (its body, its asset digests) and runs the same checks; a published release that fails them is turned into a
   pre-release at once, so `releases/latest`, the installer and the updater fall back to the previous version, and the
   job fails.

A release is never created over an existing release or tag of the same version (the job fails instead).

**Several merges in a row:** runs on `main` queue, one at a time, and a release in progress is never cancelled. GitHub
keeps only one waiting run per branch, so with three quick merges the middle run is dropped and the last one releases
both (its notes gather the `## Novidades` of every merge since the last tag). A run that failed, or an old run started
again after a newer release, never publishes an older commit: a commit must descend from the last release tag.

## Dry run

To see a release without publishing it, run the workflow by hand on any branch:

```sh
gh workflow run ci.yml --ref <branch>             # draft (default)
gh workflow run ci.yml --ref <branch> -f draft=false
```

(or Actions → CI → Run workflow). Everything runs as for a release, but the `release` job creates at most a **draft**
release titled "Telinha X.Y.Z (dry run)": drafts never show up in `releases/latest`, so neither the updater nor the
installer can see it, and GitHub creates no tag for a draft. The job summary has the notes and a link to the draft.
**Delete the draft when you are done** (`gh release delete vX.Y.Z --yes`): the real release refuses to start while a
release with its tag exists. With `draft=false` nothing is created; the notes and the checks are in the job summary.

## When a release went wrong

- **The `release` job failed before publishing** (a check, the network): fix the cause (or the PR description) and
  re-run the failed job; nothing was published.
- **A published release is bad** (it installs or starts badly): mark it as a pre-release
  (`gh release edit vX.Y.Z --prerelease`). `releases/latest` goes back to the previous release: new installs and copies
  that did not update yet get the previous version; copies that already updated keep the bad one (the updater never
  downgrades; a version that fails to start is rolled back on that PC by itself). Then merge the fix: the next release is
  the next patch.

The release format itself (tag, asset names, SHA-256 sources) is the contract in
[`addon/PAYLOAD.md`](../addon/PAYLOAD.md), section 8.6.
