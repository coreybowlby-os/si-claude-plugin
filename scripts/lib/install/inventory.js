'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWithinRoot, realpathNearestExisting } = require('../path-safety');

const { CURRENT_PLUGIN_SLUG } = require('../resolve-ecc-root');

// Claude Code plugin ids are `<plugin>@<marketplace>`; both halves are our slug, since
// we register against our own marketplace. This id also keys `pluginConfigs` in the
// user's Claude settings, so it must match what we actually install.
const CURRENT_PLUGIN_ID = `${CURRENT_PLUGIN_SLUG}@${CURRENT_PLUGIN_SLUG}`;

// Deliberately empty. This plugin has never shipped, so there is no earlier install of
// ours to migrate or refuse. Upstream ECC (`ecc@ecc`, `everything-claude-code@*`) is a
// DIFFERENT plugin, not an ancestor of this one, and is allowed to coexist — installing
// us must not require uninstalling it.
const LEGACY_PLUGIN_IDS = new Set();

function resolveClaudePaths(options = {}) {
  const homeDir = options.homeDir
    || process.env.HOME
    || process.env.USERPROFILE
    || os.homedir();
  const configDir = options.configDir
    || process.env.CLAUDE_CONFIG_DIR
    || path.join(homeDir, '.claude');
  const projectRoot = options.projectRoot || process.cwd();

  return {
    homeDir: path.resolve(homeDir),
    configDir: path.resolve(configDir),
    projectRoot: path.resolve(projectRoot),
  };
}

function readJsonObject(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid at ${filePath}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid at ${filePath}: expected a JSON object`);
  }
  return value;
}

function findManualClaudePlugin(options = {}) {
  const { configDir } = resolveClaudePaths(options);
  const pluginsDir = path.join(configDir, 'plugins');
  const candidates = [
    ['ecc', '.claude-plugin', 'plugin.json'],
    ['ecc', 'plugin.json'],
    ['ecc@ecc', '.claude-plugin', 'plugin.json'],
    ['ecc@ecc', 'plugin.json'],
    ['everything-claude-code', '.claude-plugin', 'plugin.json'],
    ['everything-claude-code', 'plugin.json'],
  ];

  for (const segments of candidates) {
    const manifestPath = path.join(pluginsDir, ...segments);
    if (fs.existsSync(manifestPath)) {
      return {
        manifestPath,
        installPath: path.dirname(path.dirname(manifestPath)),
      };
    }
  }
  return null;
}

function validateManagedState(state, statePath, expectedRoot) {
  const selectedModules = state?.resolution?.selectedModules;
  const operations = state?.operations;
  if (
    state?.schemaVersion !== 'ecc.install.v1'
    || !state.target
    || typeof state.target !== 'object'
    || Array.isArray(state.target)
    || !Array.isArray(selectedModules)
    || !selectedModules.every(moduleId => typeof moduleId === 'string' && moduleId.length > 0)
    || !Array.isArray(operations)
  ) {
    throw new Error(`Managed Claude install-state is invalid at ${statePath}`);
  }

  for (const operation of operations) {
    if (
      !operation
      || typeof operation !== 'object'
      || typeof operation.destinationPath !== 'string'
      || !path.isAbsolute(operation.destinationPath)
      || !isWithinRoot(operation.destinationPath, expectedRoot)
    ) {
      throw new Error(`Managed Claude install-state is invalid at ${statePath}`);
    }
  }

  return { selectedModules, operations };
}

function operationOverlapsPlugin(operation, expectedRoot) {
  const canonicalRoot = realpathNearestExisting(expectedRoot);
  const canonicalDestination = realpathNearestExisting(operation.destinationPath);
  const relativePath = path.relative(canonicalRoot, canonicalDestination);
  const firstSegment = relativePath.split(path.sep)[0];
  return ['agents', 'commands', 'hooks', 'skills'].includes(firstSegment);
}

function findManagedClaudeInstalls(options = {}) {
  const { configDir, projectRoot } = resolveClaudePaths(options);
  // Must match where the Claude install targets actually write install-state:
  // claude-home.js / claude-project.js build it from CLAUDE_ECC_NAMESPACE, which is
  // our plugin slug. Hardcoding 'ecc' here meant overlap detection looked in a
  // directory nothing writes to, so a real managed overlap was never detected.
  const candidates = [
    {
      statePath: path.join(configDir, CURRENT_PLUGIN_SLUG, 'install-state.json'),
      expectedRoot: configDir,
    },
    {
      statePath: path.join(projectRoot, '.claude', CURRENT_PLUGIN_SLUG, 'install-state.json'),
      expectedRoot: path.join(projectRoot, '.claude'),
    },
  ];
  const findings = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.statePath)) continue;
    const state = readJsonObject(candidate.statePath, 'Managed Claude install-state');
    const { selectedModules, operations } = validateManagedState(
      state,
      candidate.statePath,
      candidate.expectedRoot
    );
    const modulesOverlap = selectedModules.some(moduleId => moduleId !== 'rules-core');
    const operationsOverlap = operations.some(operation => (
      operationOverlapsPlugin(operation, candidate.expectedRoot)
    ));
    findings.push({
      statePath: candidate.statePath,
      selectedModules: [...selectedModules],
      overlapsPlugin: modulesOverlap || operationsOverlap,
    });
  }

  return findings;
}

module.exports = {
  CURRENT_PLUGIN_ID,
  LEGACY_PLUGIN_IDS,
  findManagedClaudeInstalls,
  findManualClaudePlugin,
  resolveClaudePaths,
};
