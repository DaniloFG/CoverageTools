# Contributing to Coverage Tools

## Development

```sh
npm ci
npm run lint      # type-check and ESLint
npm run build     # bundle dist/extension.js and dist/worker.js
npm test          # unit tests
npm run test:e2e  # real tools on samples/ (run `node scripts/setup-samples.mjs` first)
npm run test:ui   # real VS Code driven by Playwright (needs a display; use xvfb-run on Linux)
```

## Publishing

Coverage Tools is published by the same workflow scheme as GitTools, under the same
Marketplace publisher (`DaniloFG`), so both extensions live on the same publisher page.

### Build the `.vsix` locally

`npm run package` builds the extension and writes `release/coverage-tools-<version>.vsix`.
Install it with `code --install-extension release/coverage-tools-<version>.vsix`, or in VS Code
with **Extensions: Install from VSIX...**. `npm run build` only compiles.

### When the workflow runs

The `.github/workflows/publish-extension.yml` workflow lints, builds, checks the bundle size,
tests, packages and publishes the extension to the VS Code Marketplace; users get the update
automatically. It runs:

- **on every merge to `main` that touches what goes into the extension**: `src/`, `scripts/`,
  `media/`, `docs/images/`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`
  and the build files (`esbuild.mjs`, `tsconfig.json`, `.vscodeignore`);
- **when a `v*` tag is pushed** (`git tag v0.5.1 && git push origin v0.5.1`), with the version
  of the tag;
- **manually**, from *Actions → Publish VS Code extension → Run workflow*, with an optional
  version.

Only one publication runs at a time; a second one waits for the first instead of cancelling it.

### How the version is chosen

1. The version typed in the manual run, if any.
2. Otherwise, on a tag push, the tag without the `v` (`v0.5.1` → `0.5.1`).
3. Otherwise `scripts/extension-version.mjs` picks it: the `package.json` version when it is
   above the last `v*` tag, else the last tag with its last number + 1 (`v0.1.9` → `0.1.10`).
   So every merge publishes the next patch on its own; **for a minor or major, bump the version
   in `package.json` in the pull request**.

The version must be `x.y.z`; anything else fails the run. It is written into `package.json`
before packaging. If that version is already on the Marketplace, the workflow ends without
error and without a new release.

The release notes come from `CHANGELOG.md`: the `## [<version>]` section when there is one,
otherwise the **Done** list under `## [Unreleased]`. With nothing to say, a merge to `main`
publishes a "Maintenance release." note, while a tag or a manual run fails until the changelog
says what users get.

Every new publication creates the GitHub release `v<version>` with the `.vsix` attached, and
the `.vsix` is also kept as the `coverage-tools-vsix` artifact of the run.

### One-time setup

In the GitHub repository, open *Settings → Secrets and variables → Actions* and create:

- `VSCE_PAT`: a Personal Access Token from Azure DevOps with the scope
  **Marketplace → Manage**, for the publisher `DaniloFG` (the same publisher as GitTools,
  so the same token can be used for both repositories).
- `OVSX_PAT` (optional): an [Open VSX](https://open-vsx.org/) access token. With it, each
  version is also published to Open VSX (VSCodium, Cursor and other VS Code forks).

### Without the secret

If `VSCE_PAT` is not configured, the workflow still builds, tests and packages the extension,
shows a warning that nothing went to the Marketplace, and only attaches the `.vsix` to the
GitHub release `v<version>` (and to the run's artifacts). Without `OVSX_PAT`, Open VSX is
skipped silently.
