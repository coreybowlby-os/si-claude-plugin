'use strict';

const { validateInstallModuleIds } = require('../install-manifests');

const LEGACY_INSTALL_TARGETS = ['claude', 'cursor', 'antigravity'];

function dedupeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];
}

// ── parseInstallArgs helpers ──────────────────────────────────────

function consumeNextArg(args, index) {
  return { value: args[index + 1] || null, next: index + 1 };
}

function handleComponentFlag(list, args, index) {
  const value = (args[index + 1] || '').trim();
  if (value) list.push(value);
  return index + 1;
}

function parseInstallArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    target: null,
    dryRun: false,
    json: false,
    help: false,
    configPath: null,
    profileId: null,
    moduleIds: [],
    includeComponentIds: [],
    excludeComponentIds: [],
    languages: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--target') {
      ({ value: parsed.target, next: index } = consumeNextArg(args, index));
    } else if (arg === '--config') {
      ({ value: parsed.configPath, next: index } = consumeNextArg(args, index));
    } else if (arg === '--profile') {
      ({ value: parsed.profileId, next: index } = consumeNextArg(args, index));
    } else if (arg === '--modules') {
      const { value: raw, next } = consumeNextArg(args, index);
      parsed.moduleIds = dedupeStrings((raw || '').split(','));
      index = next;
    } else if (arg === '--with') {
      index = handleComponentFlag(parsed.includeComponentIds, args, index);
    } else if (arg === '--without') {
      index = handleComponentFlag(parsed.excludeComponentIds, args, index);
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      parsed.languages.push(arg);
    }
  }

  return parsed;
}

// ── normalizeInstallRequest helpers ──────────────────────────────

function resolveConfig(options) {
  return options.config && typeof options.config === 'object' ? options.config : null;
}

function mergeArrayField(config, options, field) {
  return dedupeStrings([...(config?.[field] || []), ...(options[field] || [])]);
}

function resolveLegacyLanguages(options) {
  const merged = [
    ...(Array.isArray(options.legacyLanguages) ? options.legacyLanguages : []),
    ...(Array.isArray(options.languages)        ? options.languages        : []),
  ];
  return dedupeStrings(merged.map(l => l.toLowerCase()));
}

function normalizeInstallRequest(options = {}) {
  const config              = resolveConfig(options);
  const profileId           = options.profileId || config?.profileId || null;
  const moduleIds           = validateInstallModuleIds(mergeArrayField(config, options, 'moduleIds'));
  const includeComponentIds = mergeArrayField(config, options, 'includeComponentIds');
  const excludeComponentIds = mergeArrayField(config, options, 'excludeComponentIds');
  const legacyLanguages     = resolveLegacyLanguages(options);
  const target              = options.target || config?.target || 'claude';

  const hasManifestBaseSelection = Boolean(profileId) || moduleIds.length > 0 || includeComponentIds.length > 0;
  const usingManifestMode        = hasManifestBaseSelection || excludeComponentIds.length > 0;

  if (usingManifestMode && legacyLanguages.length > 0) {
    throw new Error(
      'Legacy language arguments cannot be combined with --profile, --modules, --with, --without, or manifest config selections'
    );
  }

  if (!options.help && !hasManifestBaseSelection && legacyLanguages.length === 0) {
    throw new Error('No install profile, module IDs, included components, or legacy languages were provided');
  }

  return {
    mode: usingManifestMode ? 'manifest' : 'legacy-compat',
    target,
    profileId,
    moduleIds,
    includeComponentIds,
    excludeComponentIds,
    legacyLanguages,
    configPath: config?.path || options.configPath || null,
  };
}

module.exports = {
  LEGACY_INSTALL_TARGETS,
  normalizeInstallRequest,
  parseInstallArgs,
};
