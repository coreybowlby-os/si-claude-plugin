#!/usr/bin/env node
/**
 * Validate selective-install manifests and profile/module relationships.
 * Module paths are curated repo paths only. Generated/imported skill roots
 * (~/.claude/skills/learned, etc.) are never in manifests.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const REPO_ROOT = path.join(__dirname, '../..');
const MODULES_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-modules.json');
const PROFILES_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-profiles.json');
const COMPONENTS_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-components.json');
const MODULES_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-modules.schema.json');
const PROFILES_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-profiles.schema.json');
const COMPONENTS_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-components.schema.json');
const COMPONENT_FAMILY_PREFIXES = {
  baseline:   'baseline:',
  language:   'lang:',
  framework:  'framework:',
  capability: 'capability:',
};

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`, { cause: error });
  }
}

function normalizeRelativePath(relativePath) {
  return String(relativePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

function validateSchema(ajv, schemaPath, data, label) {
  const schema = readJson(schemaPath, `${label} schema`);
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const error of validate.errors) {
      console.error(`ERROR: ${label} schema: ${error.instancePath || '/'} ${error.message}`);
    }
    return true;
  }
  return false;
}

// ── Section validators ────────────────────────────────────────────

function loadManifests(ajv) {
  let modulesData, profilesData;
  let componentsData = { version: null, components: [] };
  try {
    modulesData  = readJson(MODULES_MANIFEST_PATH,  'install-modules.json');
    profilesData = readJson(PROFILES_MANIFEST_PATH, 'install-profiles.json');
    if (fs.existsSync(COMPONENTS_MANIFEST_PATH)) {
      componentsData = readJson(COMPONENTS_MANIFEST_PATH, 'install-components.json');
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }

  let schemaErrors = validateSchema(ajv, MODULES_SCHEMA_PATH,    modulesData,    'install-modules.json');
  schemaErrors     = validateSchema(ajv, PROFILES_SCHEMA_PATH,   profilesData,   'install-profiles.json') || schemaErrors;
  if (fs.existsSync(COMPONENTS_MANIFEST_PATH)) {
    schemaErrors   = validateSchema(ajv, COMPONENTS_SCHEMA_PATH, componentsData, 'install-components.json') || schemaErrors;
  }
  if (schemaErrors) process.exit(1);

  return { modulesData, profilesData, componentsData };
}

function validateModules(modules) {
  let hasErrors = false;
  const moduleIds    = new Set();
  const claimedPaths = new Map();

  for (const module of modules) {
    if (moduleIds.has(module.id)) {
      console.error(`ERROR: Duplicate install module id: ${module.id}`);
      hasErrors = true;
    }
    moduleIds.add(module.id);

    for (const dep of module.dependencies) {
      if (!moduleIds.has(dep) && !modules.some(m => m.id === dep)) {
        console.error(`ERROR: Module ${module.id} depends on unknown module ${dep}`);
        hasErrors = true;
      }
      if (dep === module.id) {
        console.error(`ERROR: Module ${module.id} cannot depend on itself`);
        hasErrors = true;
      }
    }

    for (const relativePath of module.paths) {
      const normalizedPath = normalizeRelativePath(relativePath);
      if (!fs.existsSync(path.join(REPO_ROOT, normalizedPath))) {
        console.error(`ERROR: Module ${module.id} references missing path: ${normalizedPath}`);
        hasErrors = true;
      }
      if (claimedPaths.has(normalizedPath)) {
        console.error(`ERROR: Install path ${normalizedPath} is claimed by both ${claimedPaths.get(normalizedPath)} and ${module.id}`);
        hasErrors = true;
      } else {
        claimedPaths.set(normalizedPath, module.id);
      }
    }
  }

  return { hasErrors, moduleIds };
}

function validateProfiles(profiles, moduleIds) {
  let hasErrors = false;
  const REQUIRED = ['core', 'developer', 'security', 'research', 'full'];

  for (const profileId of REQUIRED) {
    if (!profiles[profileId]) {
      console.error(`ERROR: Missing required install profile: ${profileId}`);
      hasErrors = true;
    }
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    const seen = new Set();
    for (const moduleId of profile.modules) {
      if (!moduleIds.has(moduleId)) {
        console.error(`ERROR: Profile ${profileId} references unknown module ${moduleId}`);
        hasErrors = true;
      }
      if (seen.has(moduleId)) {
        console.error(`ERROR: Profile ${profileId} contains duplicate module ${moduleId}`);
        hasErrors = true;
      }
      seen.add(moduleId);
    }
  }

  if (profiles.full) {
    const fullModules = new Set(profiles.full.modules);
    for (const moduleId of moduleIds) {
      if (!fullModules.has(moduleId)) {
        console.error(`ERROR: full profile is missing module ${moduleId}`);
        hasErrors = true;
      }
    }
  }

  return hasErrors;
}

function validateComponents(components, moduleIds) {
  let hasErrors = false;
  const componentIds = new Set();

  for (const component of components) {
    if (componentIds.has(component.id)) {
      console.error(`ERROR: Duplicate install component id: ${component.id}`);
      hasErrors = true;
    }
    componentIds.add(component.id);

    const expectedPrefix = COMPONENT_FAMILY_PREFIXES[component.family];
    if (expectedPrefix && !component.id.startsWith(expectedPrefix)) {
      console.error(`ERROR: Component ${component.id} does not match expected ${component.family} prefix ${expectedPrefix}`);
      hasErrors = true;
    }

    const seen = new Set();
    for (const moduleId of component.modules) {
      if (!moduleIds.has(moduleId)) {
        console.error(`ERROR: Component ${component.id} references unknown module ${moduleId}`);
        hasErrors = true;
      }
      if (seen.has(moduleId)) {
        console.error(`ERROR: Component ${component.id} contains duplicate module ${moduleId}`);
        hasErrors = true;
      }
      seen.add(moduleId);
    }
  }

  return hasErrors;
}

// ── Entry point ───────────────────────────────────────────────────

function validateInstallManifests() {
  if (!fs.existsSync(MODULES_MANIFEST_PATH) || !fs.existsSync(PROFILES_MANIFEST_PATH)) {
    console.log('Install manifests not found, skipping validation');
    process.exit(0);
  }

  const ajv = new Ajv({ allErrors: true });
  const { modulesData, profilesData, componentsData } = loadManifests(ajv);

  const modules    = Array.isArray(modulesData.modules)         ? modulesData.modules         : [];
  const profiles   = profilesData.profiles                      || {};
  const components = Array.isArray(componentsData.components)   ? componentsData.components   : [];

  const { hasErrors: moduleErrors,   moduleIds } = validateModules(modules);
  const profileErrors                            = validateProfiles(profiles, moduleIds);
  const componentErrors                          = validateComponents(components, moduleIds);

  if (moduleErrors || profileErrors || componentErrors) process.exit(1);

  console.log(
    `Validated ${modules.length} install modules, ${components.length} install components, and ${Object.keys(profiles).length} profiles`
  );
}

validateInstallManifests();
