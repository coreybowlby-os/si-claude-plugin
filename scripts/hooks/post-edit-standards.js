'use strict';

/**
 * post-edit-standards.js — Multi-Language Coding Standards Enforcement
 *
 * PostToolUse hook that enforces coding standards on every file edit.
 * Automatically fixes style violations; reports structural violations that
 * require manual refactoring (complexity, type safety, missing annotations).
 *
 * Languages supported (graceful degradation when tool not installed):
 *   TypeScript / JavaScript  -> ESLint (node_modules/.bin/eslint)
 *   PHP                      -> PHPStan + PHP-CS-Fixer (vendor/bin/)
 *   Python                   -> Ruff (system PATH or virtualenv)
 *   Rust                     -> cargo clippy (system PATH)
 *   Shell / Bash             -> shellcheck (system PATH)
 *
 * Protocol: reads tool-call JSON from stdin, writes original JSON to stdout,
 * writes violation report to stderr (Claude reads stderr output).
 *
 * Exit codes:
 *   0  -- no violations, or only warnings (work continues)
 *   1  -- critical violations remain (Claude must fix before continuing)
 *
 * Disable: add  post:edit:standards  to ECC_DISABLED_HOOKS
 */

const path = require('path');
const fs   = require('fs');
const {
  findProjectRoot, handleEslint, handlePhp,
  handlePython, handleRust, handleShell,
} = require('../lib/standards-handlers');

const MAX_STDIN  = 512 * 1024;
const HOOK_LABEL = '[standards]';

/**
 * Architecture-significant file patterns.
 * When critical violations are found in these files, the report appends a prompt
 * to invoke the code-reviewer agent with architectural context.
 *
 * WHY here and not a separate hook:
 * A standalone "review reminder" hook that always fires and exits 0 is no different
 * from the documented rule in common/agents.md — both are just text Claude can ignore.
 * The review prompt is only useful when Claude already has to act (critical violations),
 * in which case adding it to the existing standards report is both contextual and non-noisy.
 */
var ARCHITECTURE_PATTERNS = [
  /\.service\.(ts|js)$/, /\.controller\.(ts|js)$/, /\.module\.(ts|js)$/,
  /\.guard\.(ts|js)$/, /\.filter\.(ts|js)$/, /\.interceptor\.(ts|js)$/,
];

const HANDLERS = {
  '.ts': handleEslint, '.tsx': handleEslint,
  '.js': handleEslint, '.jsx': handleEslint,
  '.mjs': handleEslint, '.cjs': handleEslint,
  '.php':  handlePhp,
  '.py':   handlePython,
  '.rs':   handleRust,
  '.sh':   handleShell, '.bash': handleShell,
};

const ROOT_MARKERS = {
  '.php': ['composer.json'],
  '.rs':  ['Cargo.toml'],
  '.py':  ['pyproject.toml', 'setup.py', 'requirements.txt'],
};
const DEFAULT_MARKERS = ['package.json', 'tsconfig.json', '.git'];

function fmtViolation(v) {
  const icon = v.severity === 'error' ? 'x' : '!';
  const loc  = 'L' + v.line + (v.col ? ':' + v.col : '');
  const rule = v.rule ? ' (' + v.rule + ')' : '';
  return '  ' + icon + ' ' + loc + rule + '\n    ' + v.message;
}

function isArchitectureFile(relPath) {
  return ARCHITECTURE_PATTERNS.some(function(p) { return p.test(relPath); });
}

function writeReport(relPath, language, autoFixed, critical, warnings) {
  const lines = ['\n+== STANDARDS [' + language + ']: ' + relPath];
  if (autoFixed > 0)        lines.push('|  ok ' + autoFixed + ' violation(s) auto-fixed.');
  if (critical.length > 0) {
    lines.push('|', '|  ACTION REQUIRED -- ' + critical.length + ' critical violation(s):');
    critical.forEach(function(v) { lines.push('| ' + fmtViolation(v).replace(/\n/g, '\n|')); });
  }
  if (warnings.length > 0) {
    lines.push('|', '|  WARNINGS -- ' + warnings.length + ' issue(s) to address before commit:');
    warnings.forEach(function(v) { lines.push('| ' + fmtViolation(v).replace(/\n/g, '\n|')); });
  }
  // Append a code-review prompt only for architecture files with critical violations.
  // A standalone "review reminder" hook that always fires adds noise without enforcement;
  // the prompt is only contextual and actionable when Claude must already act on violations.
  if (critical.length > 0 && isArchitectureFile(relPath)) {
    lines.push(
      '|',
      '|  ARCHITECTURE FILE — style violations often signal deeper issues.',
      '|  After fixing these violations, invoke the code-reviewer agent:',
      '|    "Review ' + relPath + ' for auth guards, encryption,',
      '|     N+1 queries, and ADR compliance before continuing."',
      '|  Hooks enforce style. Code review enforces architecture.'
    );
  }
  lines.push('+==\n');
  process.stderr.write(lines.join('\n'));
}

// ── run() phases ─────────────────────────────────────────────────

/**
 * Parse raw stdin, resolve the file path, find the language handler.
 * Returns null if the input is invalid or the file/handler is not found.
 */
function resolveContext(raw) {
  var toolInput;
  try { toolInput = JSON.parse(raw); } catch (_e) { return null; }
  var filePath = toolInput && toolInput.tool_input &&
    (toolInput.tool_input.file_path || toolInput.tool_input.path);
  if (!filePath) return null;
  var absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return null;
  var ext = path.extname(absPath).toLowerCase();
  var handler = HANDLERS[ext];
  if (!handler) return null;
  var markers = ROOT_MARKERS[ext] || DEFAULT_MARKERS;
  var projectRoot = findProjectRoot(path.dirname(absPath), markers);
  return { absPath, ext, handler, projectRoot, relPath: path.relative(projectRoot, absPath) };
}

/**
 * Emit a violation report and exit(1) when critical issues remain.
 */
function reportViolations(result, relPath, lang) {
  var autoFixed = result.autoFixed || 0;
  var critical  = result.critical  || [];
  var warnings  = result.warnings  || [];
  if (critical.length === 0 && warnings.length === 0) {
    if (autoFixed > 0) process.stderr.write(HOOK_LABEL + ' ' + relPath + ': ' + autoFixed + ' auto-fixed.\n');
    return;
  }
  writeReport(relPath, lang, autoFixed, critical, warnings);
  if (critical.length > 0) process.exit(1);
}

/**
 * Interpret a handler result: surface errors/notices, then delegate to reportViolations.
 */
function applyResult(result, relPath, ext) {
  if (result.toolError) {
    process.stderr.write(HOOK_LABEL + ' ' + relPath + ': TOOL ERROR -- ' + result.toolError + '\n');
    return;
  }
  var lang = result.language || ext.replace('.', '').toUpperCase();
  if (result.notice) {
    process.stderr.write(HOOK_LABEL + ' ' + relPath + ' (' + lang + '): ' + result.notice + '\n');
    if (!result.critical && !result.warnings) return;
  }
  reportViolations(result, relPath, lang);
}

function run(raw) {
  var ctx = resolveContext(raw);
  if (!ctx) return raw;

  var result;
  try { result = ctx.handler(ctx.absPath, ctx.projectRoot); }
  catch (err) {
    process.stderr.write(HOOK_LABEL + ' handler error for ' + ctx.relPath + ': ' + err.message + '\n');
    return raw;
  }

  applyResult(result, ctx.relPath, ctx.ext);
  return raw;
}

// Guard the CLI entrypoint. Without this, requiring the module from
// posttooluse-dispatcher.js attaches a second set of stdin listeners, so the
// pass-through payload is written to stdout twice and is emitted even when the
// dispatcher decides to suppress it. Every sibling hook uses the same guard.
if (require.main === module) {
  var buf = '';
  process.stdin.on('data', function(chunk) { if (buf.length < MAX_STDIN) buf += chunk; });
  process.stdin.on('end', function() {
    var out = run(buf);
    if (out !== undefined) process.stdout.write(out);
    process.exit(0);
  });
}

module.exports = { run };
