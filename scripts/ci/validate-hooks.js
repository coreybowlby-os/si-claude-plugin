#!/usr/bin/env node
/**
 * Validate hooks.json schema and hook entry rules.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Ajv = require('ajv');

const HOOKS_FILE = path.join(__dirname, '../../hooks/hooks.json');
const HOOKS_SCHEMA_PATH = path.join(__dirname, '../../schemas/hooks.schema.json');
const VALID_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'InstructionsLoaded',
  'TeammateIdle',
  'TaskCompleted',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'SessionEnd',
];
const VALID_HOOK_TYPES = ['command', 'http', 'prompt', 'agent'];
const EVENTS_WITHOUT_MATCHER = new Set(['UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => isNonEmptyString(item));
}

// ── Per-type hook validators ─────────────────────────────────────

function validateTypeField(hook, label) {
  if (!hook.type || typeof hook.type !== 'string') {
    console.error(`ERROR: ${label} missing or invalid 'type' field`);
    return true;
  }
  if (!VALID_HOOK_TYPES.includes(hook.type)) {
    console.error(`ERROR: ${label} has unsupported hook type '${hook.type}'`);
    return true;
  }
  return false;
}

function validateTimeout(hook, label) {
  if ('timeout' in hook && (typeof hook.timeout !== 'number' || hook.timeout < 0)) {
    console.error(`ERROR: ${label} 'timeout' must be a non-negative number`);
    return true;
  }
  return false;
}

function validateCommandHook(hook, label) {
  let hasErrors = false;
  if ('async' in hook && typeof hook.async !== 'boolean') {
    console.error(`ERROR: ${label} 'async' must be a boolean`);
    hasErrors = true;
  }
  if (!isNonEmptyString(hook.command) && !isNonEmptyStringArray(hook.command)) {
    console.error(`ERROR: ${label} missing or invalid 'command' field`);
    return true;
  }
  if (typeof hook.command === 'string') {
    const nodeEMatch = hook.command.match(/^node -e "(.*)"$/s);
    if (nodeEMatch) {
      try {
        new vm.Script(nodeEMatch[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
      } catch (syntaxErr) {
        console.error(`ERROR: ${label} has invalid inline JS: ${syntaxErr.message}`);
        hasErrors = true;
      }
    }
  }
  return hasErrors;
}

function validateHttpHook(hook, label) {
  let hasErrors = false;
  if (!isNonEmptyString(hook.url)) {
    console.error(`ERROR: ${label} missing or invalid 'url' field`);
    hasErrors = true;
  }
  if ('headers' in hook && (typeof hook.headers !== 'object' || hook.headers === null || Array.isArray(hook.headers) || !Object.values(hook.headers).every(value => typeof value === 'string'))) {
    console.error(`ERROR: ${label} 'headers' must be an object with string values`);
    hasErrors = true;
  }
  if ('allowedEnvVars' in hook && (!Array.isArray(hook.allowedEnvVars) || !hook.allowedEnvVars.every(value => isNonEmptyString(value)))) {
    console.error(`ERROR: ${label} 'allowedEnvVars' must be an array of strings`);
    hasErrors = true;
  }
  return hasErrors;
}

function validatePromptHook(hook, label) {
  let hasErrors = false;
  if (!isNonEmptyString(hook.prompt)) {
    console.error(`ERROR: ${label} missing or invalid 'prompt' field`);
    hasErrors = true;
  }
  if ('model' in hook && !isNonEmptyString(hook.model)) {
    console.error(`ERROR: ${label} 'model' must be a non-empty string`);
    hasErrors = true;
  }
  return hasErrors;
}

const HOOK_TYPE_VALIDATORS = {
  command: validateCommandHook,
  http:    validateHttpHook,
};

/**
 * Validate a single hook entry has required fields and valid inline JS.
 * @param {object} hook - Hook object
 * @param {string} label - Label for error messages
 * @returns {boolean} true if errors were found
 */
function validateHookEntry(hook, label) {
  let hasErrors = validateTypeField(hook, label) | validateTimeout(hook, label);

  if (hook.type === 'command') {
    return Boolean(hasErrors | validateCommandHook(hook, label));
  }

  if ('async' in hook) {
    console.error(`ERROR: ${label} 'async' is only supported for command hooks`);
    hasErrors = true;
  }

  const typeValidator = HOOK_TYPE_VALIDATORS[hook.type];
  if (typeValidator) return Boolean(hasErrors | typeValidator(hook, label));
  return Boolean(hasErrors | validatePromptHook(hook, label));
}

// ── Format-specific validators ───────────────────────────────────

function loadHooksFile() {
  if (!fs.existsSync(HOOKS_FILE)) {
    console.log('No hooks.json found, skipping validation');
    process.exit(0);
  }
  try {
    return JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'));
  } catch (e) {
    console.error(`ERROR: Invalid JSON in hooks.json: ${e.message}`);
    process.exit(1);
  }
}

function validateMatcherEntry(matcher, eventType, index) {
  let hasErrors = false;
  if (typeof matcher !== 'object' || matcher === null) {
    console.error(`ERROR: ${eventType}[${index}] is not an object`);
    return true;
  }
  if (!('matcher' in matcher) && !EVENTS_WITHOUT_MATCHER.has(eventType)) {
    console.error(`ERROR: ${eventType}[${index}] missing 'matcher' field`);
    hasErrors = true;
  } else if ('matcher' in matcher && typeof matcher.matcher !== 'string' && (typeof matcher.matcher !== 'object' || matcher.matcher === null)) {
    console.error(`ERROR: ${eventType}[${index}] has invalid 'matcher' field`);
    hasErrors = true;
  }
  if (!matcher.hooks || !Array.isArray(matcher.hooks)) {
    console.error(`ERROR: ${eventType}[${index}] missing 'hooks' array`);
    return true;
  }
  for (let j = 0; j < matcher.hooks.length; j++) {
    if (validateHookEntry(matcher.hooks[j], `${eventType}[${index}].hooks[${j}]`)) {
      hasErrors = true;
    }
  }
  return hasErrors;
}

function validateObjectFormat(hooks) {
  let hasErrors = false;
  let totalMatchers = 0;
  for (const [eventType, matchers] of Object.entries(hooks)) {
    if (!VALID_EVENTS.includes(eventType)) {
      console.error(`ERROR: Invalid event type: ${eventType}`);
      hasErrors = true;
      continue;
    }
    if (!Array.isArray(matchers)) {
      console.error(`ERROR: ${eventType} must be an array`);
      hasErrors = true;
      continue;
    }
    for (let i = 0; i < matchers.length; i++) {
      if (validateMatcherEntry(matchers[i], eventType, i)) hasErrors = true;
      totalMatchers++;
    }
  }
  return { hasErrors, totalMatchers };
}

function validateArrayFormat(hooks) {
  let hasErrors = false;
  let totalMatchers = 0;
  for (let i = 0; i < hooks.length; i++) {
    const hook = hooks[i];
    if (!('matcher' in hook)) {
      console.error(`ERROR: Hook ${i} missing 'matcher' field`);
      hasErrors = true;
    } else if (typeof hook.matcher !== 'string' && (typeof hook.matcher !== 'object' || hook.matcher === null)) {
      console.error(`ERROR: Hook ${i} has invalid 'matcher' field`);
      hasErrors = true;
    }
    if (!hook.hooks || !Array.isArray(hook.hooks)) {
      console.error(`ERROR: Hook ${i} missing 'hooks' array`);
      hasErrors = true;
    } else {
      for (let j = 0; j < hook.hooks.length; j++) {
        if (validateHookEntry(hook.hooks[j], `Hook ${i}.hooks[${j}]`)) hasErrors = true;
      }
    }
    totalMatchers++;
  }
  return { hasErrors, totalMatchers };
}

function validateHooks() {
  const data = loadHooksFile();

  if (fs.existsSync(HOOKS_SCHEMA_PATH)) {
    const schema = JSON.parse(fs.readFileSync(HOOKS_SCHEMA_PATH, 'utf-8'));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      for (const err of validate.errors) {
        console.error(`ERROR: hooks.json schema: ${err.instancePath || '/'} ${err.message}`);
      }
      process.exit(1);
    }
  }

  const hooks = data.hooks || data;
  let result;

  if (typeof hooks === 'object' && !Array.isArray(hooks)) {
    result = validateObjectFormat(hooks);
  } else if (Array.isArray(hooks)) {
    result = validateArrayFormat(hooks);
  } else {
    console.error('ERROR: hooks.json must be an object or array');
    process.exit(1);
  }

  if (result.hasErrors) process.exit(1);
  console.log(`Validated ${result.totalMatchers} hook matchers`);
}

validateHooks();
