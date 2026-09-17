# SI Claude Plugin 2.3.0

The first tagged release of SI Claude Plugin, an attributed fork of
[ECC](https://github.com/affaan-m/ECC). Everything before this tag existed only
as commits on `main`.

This release carries the upstream merge plus the work needed to make the fork
installable under its own identity. Several of the fixes below are defects that
would have affected anyone installing it.

## Distribution

This project is distributed from GitHub only. There is no npm package for it,
and `ecc-universal` on npm is upstream's project, not this one.

```bash
npx github:coreybowlby-os/si-claude-plugin setup
```

or, inside Claude Code:

```text
/plugin marketplace add coreybowlby-os/si-claude-plugin
/plugin install SI-Claude-Plugin@SI-Claude-Plugin
```

Codex uses the lowercase identifiers `si-claude-plugin` and
`si-claude-plugin@si-claude-plugin`.

## Install-blocking fixes

- **`npm install` failed for every consumer.** `package.json` declared a
  `postinstall` running `scripts/post-install.js`, but the `files` allowlist
  never shipped that script, so installs ended in `MODULE_NOT_FOUND`. The file
  now ships, and a derived test asserts every lifecycle-script target is packed.
- **46 files had lost their executable bit.** A `core.fileMode=false` clone
  recorded them as `100644`, so `scripts/codex/install-global-git-hooks.sh` and
  others failed with exit 126, and `./install.sh` could not be run from a fresh
  clone. All restored to match upstream's 65 executable files.
- **Yarn users received unpatched dependencies.** `overrides` had been bumped to
  js-yaml 4.3.2 / fast-uri 3.1.6 while `resolutions` still pinned 4.3.1 / 3.1.5,
  so npm and Yarn installed different versions of two security pins. The
  lockfile was also Yarn Classic v1 while `packageManager` pins Yarn 4, which
  broke every Yarn CI lane.

## Identity

Install documentation across the README and translated docs pointed at
upstream's repository, npm package and `ecc@ecc` plugin identifier, while the
installer registered this fork's marketplace and refused any other source. Docs
and installer now agree, and a regression test fails if any public install doc
points at upstream again. Attribution references to upstream are deliberately
kept.

## Release and supply chain

- `auto-release` checked out `workflow_run.head_sha` while holding
  `contents: write`. Because CI also runs on pull requests, a fork PR from a
  branch named `main` could reach that job and execute its own code with a write
  token. It now requires a push from this repository and checks out `main`,
  asserting the CI-verified SHA rather than checking it out.
- The same job could never have released anything: `release.sh` requires an
  attached `main` branch, which a `head_sha` checkout cannot provide.
- Checkout credentials are no longer persisted; the release push is authorised
  per-invocation instead.
- `npm ci` in release workflows now runs with `--ignore-scripts`, which matters
  because this package's postinstall writes to `~/.claude`.

## Verification

CI is green across all 42 jobs — 25 test lanes covering Ubuntu, macOS and
Windows on Node 18/20/22 with npm, pnpm, Yarn and Bun, plus coverage, lint,
component validation, supply-chain scanning, and packed-install lifecycle tests
on all three operating systems.
