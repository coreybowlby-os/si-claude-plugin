/**
 * Tests for scripts/ci/check-plugin-runtime-deps.js.
 *
 * Claude Code's plugin installer does not install npm packages for this
 * plugin (it only supports package-lock.json, and yarn.lock is canonical), so
 * anything that runs automatically — hook commands and plugin-registered MCP
 * servers — must load with Node built-ins and repo files only.
 *
 * Run with: node tests/ci/plugin-runtime-deps.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findRuntimeDependencyViolations } = require('../../scripts/ci/check-plugin-runtime-deps');
const { test, banner, section, summary } = require('../lib/helpers/mini-test-runner');

const repoRoot = path.join(__dirname, '..', '..');

let passed = 0;
let failed = 0;

function withPlugin(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-runtime-deps-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const hooksJson = commands => JSON.stringify({
  hooks: { PreToolUse: [{ matcher: '*', hooks: commands.map(command => ({ type: 'command', command })) }] },
});

banner('plugin runtime dependencies');

section('detects violations:');

if (test('flags a hook script that requires an npm package directly', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/gate.js"']),
    'scripts/hooks/gate.js': "const yaml = require('js-yaml');\n",
  }, root => {
    const violations = findRuntimeDependencyViolations(root);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].pkg, 'js-yaml');
    assert.deepStrictEqual(violations[0].chain, ['scripts/hooks/gate.js']);
  });
})) passed++; else failed++;

if (test('follows relative requires to a package several files deep', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/gate.js']),
    'scripts/hooks/gate.js': "require('../lib/a');\n",
    'scripts/lib/a.js': "require('./b');\n",
    'scripts/lib/b/index.js': "const Ajv = require('ajv');\n",
  }, root => {
    const [violation] = findRuntimeDependencyViolations(root);
    assert.strictEqual(violation.pkg, 'ajv');
    assert.deepStrictEqual(violation.chain, ['scripts/hooks/gate.js', 'scripts/lib/a.js', 'scripts/lib/b/index.js']);
  });
})) passed++; else failed++;

if (test('follows scripts a hook launches by path, not only require()', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/run-with-flags.js']),
    'scripts/hooks/run-with-flags.js': "spawnSync(process.execPath, [path.join(__dirname, 'target.js')]);\n",
    'scripts/hooks/target.js': "import toml from '@iarna/toml';\n",
  }, root => {
    const [violation] = findRuntimeDependencyViolations(root);
    assert.strictEqual(violation.pkg, '@iarna/toml', 'scoped package names are reported whole');
    assert.deepStrictEqual(violation.chain, ['scripts/hooks/run-with-flags.js', 'scripts/hooks/target.js']);
  });
})) passed++; else failed++;

if (test('flags a local MCP server script registered by the plugin', () => {
  withPlugin({
    '.mcp.json': JSON.stringify({ mcpServers: { memory: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/memory-mcp.mjs'] } } }),
    'scripts/memory-mcp.mjs': "import initSqlJs from 'sql.js';\n",
  }, root => {
    const [violation] = findRuntimeDependencyViolations(root);
    assert.strictEqual(violation.pkg, 'sql.js');
    assert.strictEqual(violation.entry, 'scripts/memory-mcp.mjs');
  });
})) passed++; else failed++;

if (test('flags packages listed only in devDependencies too (the installer installs none)', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/gate.js']),
    'scripts/hooks/gate.js': "require('typescript');\n",
  }, root => {
    assert.strictEqual(findRuntimeDependencyViolations(root)[0].pkg, 'typescript');
  });
})) passed++; else failed++;

section('allows what the installer can run:');

if (test('allows Node built-ins, node: specifiers, and repo-relative requires', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/gate.js']),
    'scripts/hooks/gate.js': "require('fs'); require('node:path'); require('child_process/');\nrequire('./util');\n",
    'scripts/hooks/util.js': "require('os');\n",
  }, root => {
    assert.deepStrictEqual(findRuntimeDependencyViolations(root), []);
  });
})) passed++; else failed++;

if (test('ignores MCP servers launched through npx (they install their own packages)', () => {
  withPlugin({
    '.mcp.json': JSON.stringify({ mcpServers: { devtools: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] } } }),
  }, root => {
    assert.deepStrictEqual(findRuntimeDependencyViolations(root), []);
  });
})) passed++; else failed++;

if (test('ignores packages mentioned only in comments', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/gate.js']),
    'scripts/hooks/gate.js': "// we used to require('ajv') here\n/* import x from 'js-yaml' */\nmodule.exports = {};\n",
  }, root => {
    assert.deepStrictEqual(findRuntimeDependencyViolations(root), []);
  });
})) passed++; else failed++;

section('self-provisioning entry points:');

const PROVISIONING_HOOK = [
  "const nodeModulesPath = path.join(pluginRoot, 'node_modules');",
  'if (!fs.existsSync(nodeModulesPath)) {',
  "  spawnSync(npmBin, ['install', '--ignore-scripts']);",
  '}',
  "spawnSync(process.execPath, ['scripts/install-apply.js']);",
].join('\n');

if (test('exempts a listed entry that installs its own dependencies first', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/session-start-plugin-sync.js']),
    'scripts/hooks/session-start-plugin-sync.js': PROVISIONING_HOOK,
    'scripts/install-apply.js': "require('ajv');\n",
  }, root => {
    assert.deepStrictEqual(findRuntimeDependencyViolations(root), []);
  });
})) passed++; else failed++;

if (test('re-flags a listed entry once its self-install step is removed', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/session-start-plugin-sync.js']),
    'scripts/hooks/session-start-plugin-sync.js': "spawnSync(process.execPath, ['scripts/install-apply.js']);\n",
    'scripts/install-apply.js': "require('ajv');\n",
  }, root => {
    const [violation] = findRuntimeDependencyViolations(root);
    assert.ok(violation, 'expected the exemption to lapse without the npm install step');
    assert.strictEqual(violation.pkg, 'ajv');
  });
})) passed++; else failed++;

if (test('does not exempt entries that are not on the list', () => {
  withPlugin({
    'hooks/hooks.json': hooksJson(['node scripts/hooks/other.js']),
    'scripts/hooks/other.js': PROVISIONING_HOOK,
    'scripts/install-apply.js': "require('ajv');\n",
  }, root => {
    assert.strictEqual(findRuntimeDependencyViolations(root)[0].pkg, 'ajv');
  });
})) passed++; else failed++;

section('this repository:');

if (test('no hook or plugin-registered MCP server needs an npm package', () => {
  const violations = findRuntimeDependencyViolations(repoRoot);
  assert.deepStrictEqual(
    violations.map(v => `${v.entry} -> ${v.pkg} via ${v.chain.join(' > ')}`),
    [],
    'Hooks and plugin MCP servers must run without node_modules: Claude Code plugin installs do not install npm packages here.',
  );
})) passed++; else failed++;

if (test('actually inspects the repository hooks (guards against a silent no-op)', () => {
  const { entries } = require('../../scripts/ci/check-plugin-runtime-deps').collectEntryPoints(repoRoot);
  assert.ok(entries.length >= 20, `expected the hook entry scripts to be found, got ${entries.length}`);
})) passed++; else failed++;

summary(passed, failed);
