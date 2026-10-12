/**
 * Build the environment each suite in tests/run-all.js inherits.
 *
 * The suite must test this checkout, not whatever host happens to launch it.
 * Two kinds of host leak in through process.env:
 *
 * - Git hooks (e.g. pre-push) set GIT_DIR/GIT_WORK_TREE, which hijack
 *   `git -C <dir>` calls in tests that exercise real git.
 * - An agent session (e.g. running `npm test` from inside Claude Code) sets
 *   CLAUDE_PLUGIN_ROOT, which scripts/hooks/run-with-flags.js and
 *   scripts/lib/resolve-ecc-root.js prefer over the repo — so spawned hooks
 *   run the *installed* plugin's code instead of the code under test. User
 *   ECC_* knobs (hook profile, disabled hooks) change hook behaviour the same
 *   way.
 *
 * The whole CLAUDE_* namespace is stripped so variables a future host adds
 * cannot leak either. CI inputs that are intentional are passed through.
 */

'use strict';

const HOST_GIT_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

const HOST_AGENT_PREFIX = 'CLAUDE_';

const HOST_ECC_KEYS = [
  'ECC_HOOK_PROFILE',
  'ECC_DISABLED_HOOKS',
  'ECC_DISABLED_MCPS',
  'ECC_PLUGIN_ROOT',
  'ECC_SESSION_ID',
];

// Set by the CI matrix to select the package-manager lane
// (see tests/scripts/ecc-universal-bin.test.js).
const CI_PASSTHROUGH_KEYS = ['CLAUDE_CODE_PACKAGE_MANAGER'];

function isHostLeak(key) {
  if (CI_PASSTHROUGH_KEYS.includes(key)) return false;
  return HOST_GIT_KEYS.includes(key)
    || HOST_ECC_KEYS.includes(key)
    || key.startsWith(HOST_AGENT_PREFIX);
}

function buildHermeticEnv(sourceEnv = process.env) {
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => !isHostLeak(key)),
  );
}

module.exports = { buildHermeticEnv };
