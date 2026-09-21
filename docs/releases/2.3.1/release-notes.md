# SI Claude Plugin 2.3.1

The first published release of SI Claude Plugin, an attributed fork of
[ECC](https://github.com/affaan-m/ECC).

A `v2.3.0` tag exists but was never released: the release pipeline failed after
tagging, and the tag was deliberately left in place rather than rewritten. 2.3.1
is that release, plus the fixes that make the pipeline work.

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

## Release pipeline

This release is the first to complete, and getting there fixed a chain of
defects that had never run:

- `auto-release` checked out `workflow_run.head_sha` while holding
  `contents: write`. Because CI also runs on pull requests, a fork PR from a
  branch named `main` could reach that job and execute its own code with a write
  token. It now requires a push from this repository and checks out `main`.
- That job could never have released anything regardless: `release.sh` requires
  an attached `main` branch, which a `head_sha` checkout cannot provide.
- `npm ci` rewrites an existing `yarn.lock` into Yarn Classic v1, which dirtied
  the tree and made `release.sh` refuse to run.
- `release.sh` looked up the Codex marketplace entry and plugin directory by the
  pre-rename name `ecc`.
- `release.yml` had no `workflow_dispatch` trigger for the call `auto-release`
  makes, and that call dispatched `main` rather than the tag, so the workflow
  read `main` where it expected `vX.Y.Z`.
- The packed-lifecycle runner is executed with no repository present and could
  not read the manifest it had started depending on.
- Checkout credentials are no longer persisted; the release push is authorised
  per-invocation instead.

## Verification

CI is green across all 42 jobs — 25 test lanes covering Ubuntu, macOS and
Windows on Node 18/20/22 with npm, pnpm, Yarn and Bun, plus coverage, lint,
component validation, supply-chain scanning, and packed-install lifecycle tests
on all three operating systems.
