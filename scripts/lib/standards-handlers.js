'use strict';

/**
 * standards-handlers.js — Language-specific analysis handlers.
 *
 * Each handler accepts (absPath, projectRoot) and returns:
 *   { language, autoFixed, critical, warnings }   on success
 *   { notice }                                     when tool is unavailable
 *   { toolError }                                  when tool produces bad output
 *
 * Callers must handle all three result shapes. Handlers never throw.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const {
  ESLINT_CRITICAL, ESLINT_WARNING,
  PHP_CRITICAL_PATTERNS, PHP_WARNING_PATTERNS,
  PY_CRITICAL, PY_WARNING,
} = require('./standards-rules');

const TOOL_TIMEOUT = 30_000;

// ─── Shared utilities ─────────────────────────────────────────────────────────

/**
 * Walks up from startDir until a directory containing one of the marker files
 * is found. Returns that directory, or startDir if none found.
 */
function findProjectRoot(startDir, markers) {
  let dir = startDir;
  for (;;) {
    if (markers.some(m => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/**
 * Returns the first binary path that exists in the candidates list.
 * Absolute paths are checked directly; bare names are searched via which/where.
 */
function findBin(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
      continue;
    }

    // Node is already running; its own path needs no PATH search. This is both
    // faster and immune to the timeout below.
    if (c === 'node' || c === 'node.exe') return c;

    // Resolve via PATH ourselves rather than shelling out. `where`/`which` under
    // a 3s budget is the whole failure mode this replaces: on a loaded CI runner
    // the lookup exceeded it, spawnSync returned status null, and a timeout was
    // indistinguishable from "binary not installed" — so a present tool was
    // reported missing. Locally the same call takes ~77ms, which is why it only
    // ever failed in CI.
    const exts = process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) {
        try {
          if (fs.existsSync(path.join(dir, c + ext))) return c;
        } catch {
          // An unreadable PATH entry is not a reason to stop searching.
        }
      }
    }
  }
  return null;
}

/** Runs a tool synchronously. Never throws. */
function runTool(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: TOOL_TIMEOUT });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

/** Converts an ESLint message object into the standard violation shape. */
function eslintToViolation(m) {
  return { line: m.line, col: m.column, rule: m.ruleId,
    message: m.message, severity: m.severity === 2 ? 'error' : 'warning' };
}

// ─── ESLint handler (TypeScript + JavaScript) ─────────────────────────────────

/**
 * Resolves the ESLint executable for the current platform.
 *
 * WHY not just use node_modules/.bin/eslint directly:
 * On Windows (Git Bash / MSYS2), .bin/eslint is a POSIX shell script that works when
 * the shell invokes it, but NOT when Node.js tries to run it as a JS module via
 * `node <path>`. The canonical JS entry point is eslint/bin/eslint.js which works
 * on all platforms via `node <path>`.
 */
function findEslintBin(projectRoot) {
  // Prefer the canonical JS entry point (cross-platform, works with `node <path>`)
  const jsEntry = path.join(projectRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (fs.existsSync(jsEntry)) return jsEntry;
  // Fallback: system PATH (works on macOS/Linux where the shim is a symlink, not a shell script)
  return findBin('eslint');
}

function handleEslint(absPath, projectRoot) {
  const bin = findEslintBin(projectRoot);
  if (!bin) return { notice: 'ESLint not found — run: npm install' };

  const hasConfig = ['eslint.config.js','eslint.config.mjs','.eslintrc.json','.eslintrc.js']
    .some(c => fs.existsSync(path.join(projectRoot, c)));
  if (!hasConfig) return { notice: 'No ESLint config found — create eslint.config.js' };

  const lang = /\.(ts|tsx)$/.test(absPath) ? 'TypeScript' : 'JavaScript';

  runTool('node', [bin, absPath, '--fix', '--quiet'], projectRoot);

  const check = runTool('node', [bin, absPath, '--format', 'json'], projectRoot);
  let results;
  try { results = JSON.parse(check.stdout || '[]'); } catch {
    return { toolError: `ESLint output unparseable: ${check.stderr.slice(0, 200)}` };
  }

  const fr = results[0];
  if (!fr) return { language: lang, autoFixed: 0, critical: [], warnings: [] };

  return {
    language: lang,
    autoFixed: (fr.fixableErrorCount ?? 0) + (fr.fixableWarningCount ?? 0),
    critical:  fr.messages.filter(m => ESLINT_CRITICAL.has(m.ruleId) && !m.fix).map(eslintToViolation),
    warnings:  fr.messages.filter(m => ESLINT_WARNING.has(m.ruleId)  && !m.fix).map(eslintToViolation),
  };
}

// ─── PHP handler ──────────────────────────────────────────────────────────────

function handlePhp(absPath, projectRoot) {
  const fixer   = findBin(path.join(projectRoot, 'vendor', 'bin', 'php-cs-fixer'));
  const phpstan = findBin(path.join(projectRoot, 'vendor', 'bin', 'phpstan'));
  if (!fixer && !phpstan) return { notice: 'PHP tools not found — run: composer install' };

  let autoFixed = 0;
  if (fixer) {
    if (runTool(fixer, ['fix', absPath, '--quiet'], projectRoot).status === 0) autoFixed = 1;
  }
  if (!phpstan) return { language: 'PHP', autoFixed, critical: [], warnings: [] };

  const check = runTool(phpstan, ['analyse', absPath, '--error-format=json', '--no-progress'], projectRoot);
  let parsed;
  try { parsed = JSON.parse(check.stdout || '{}'); } catch {
    return { toolError: `PHPStan output unparseable: ${check.stderr.slice(0, 200)}` };
  }

  const msgs = parsed?.files?.[absPath]?.messages ?? [];
  const toV  = m => ({ line: m.line, rule: 'phpstan', message: m.message, severity: 'error' });
  return {
    language: 'PHP', autoFixed,
    critical: msgs.filter(m => PHP_CRITICAL_PATTERNS.some(p => p.test(m.message))).map(toV),
    warnings: msgs.filter(m =>
      !PHP_CRITICAL_PATTERNS.some(p => p.test(m.message)) &&
       PHP_WARNING_PATTERNS.some(p => p.test(m.message)),
    ).map(toV),
  };
}

// ─── Python handler ───────────────────────────────────────────────────────────

function handlePython(absPath, projectRoot) {
  const ruff = findBin(
    path.join(projectRoot, '.venv', 'bin', 'ruff'),
    path.join(projectRoot, 'venv',  'bin', 'ruff'),
    'ruff',
  );
  if (!ruff) return { notice: 'Ruff not found — install with: pip install ruff' };

  runTool(ruff, ['format', absPath, '--quiet'], projectRoot);

  const check = runTool(ruff, ['check', absPath, '--output-format=json'], projectRoot);
  let results;
  try { results = JSON.parse(check.stdout || '[]'); } catch {
    return { toolError: `Ruff output unparseable: ${check.stderr.slice(0, 200)}` };
  }

  const fixable = results.filter(r => r.fix);
  if (fixable.length > 0) runTool(ruff, ['check', absPath, '--fix', '--quiet'], projectRoot);

  const remaining = results.filter(r => !r.fix);
  const toV = r => ({ line: r.location.row, col: r.location.column, rule: r.code,
    message: r.message, severity: PY_CRITICAL.has(r.code) ? 'error' : 'warning' });

  return {
    language: 'Python', autoFixed: fixable.length,
    critical: remaining.filter(r => PY_CRITICAL.has(r.code)).map(toV),
    warnings: remaining.filter(r => PY_WARNING.has(r.code)).map(toV),
  };
}

// ─── Rust handler ─────────────────────────────────────────────────────────────

function handleRust(absPath, projectRoot) {
  const cargo = findBin('cargo');
  if (!cargo) return { notice: 'cargo not found — install from https://rustup.rs' };

  runTool(cargo, ['fmt', '--', absPath], projectRoot);

  const check = runTool(
    cargo, ['clippy', '--message-format=json', '--quiet', '--', '-D', 'clippy::complexity'],
    projectRoot,
  );

  const critical = [], warnings = [];
  for (const line of check.stdout.split('\n')) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.reason !== 'compiler-message') continue;
    const spans = msg.message?.spans ?? [];
    if (!spans.some(s => s.file_name && path.resolve(projectRoot, s.file_name) === absPath)) continue;
    const span = spans[0];
    const v = { line: span?.line_start ?? 0, col: span?.column_start ?? 0,
      rule: msg.message?.code?.code ?? 'clippy', message: msg.message?.message ?? '',
      severity: msg.message?.level === 'error' ? 'error' : 'warning' };
    (v.severity === 'error' ? critical : warnings).push(v);
  }
  return { language: 'Rust', autoFixed: 0, critical, warnings };
}

// ─── Shell handler ────────────────────────────────────────────────────────────

function handleShell(absPath, projectRoot) {
  const sc = findBin('shellcheck');
  if (!sc) return { notice: 'shellcheck not found — see https://github.com/koalaman/shellcheck' };

  const check = runTool(sc, ['--format=json', absPath], projectRoot);
  let results;
  try { results = JSON.parse(check.stdout || '[]'); } catch {
    return { toolError: 'shellcheck output unparseable' };
  }

  const toV = r => ({ line: r.line, col: r.column, rule: `SC${r.code}`,
    message: r.message, severity: r.level === 'error' ? 'error' : 'warning' });
  return {
    language: 'Shell', autoFixed: 0,
    critical: results.filter(r => r.level === 'error').map(toV),
    warnings: results.filter(r => r.level === 'warning' || r.level === 'style').map(toV),
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  findBin,
  findProjectRoot,
  handleEslint,
  handlePhp,
  handlePython,
  handleRust,
  handleShell,
};
