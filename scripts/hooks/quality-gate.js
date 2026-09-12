#!/usr/bin/env node
/**
 * Quality Gate Hook
 *
 * Runs lightweight quality checks after file edits.
 * - Targets one file when file_path is provided
 * - Falls back to no-op when language/tooling is unavailable
 *
 * For JS/TS files with Biome, this hook is skipped because
 * post-edit-format.js already runs `biome check --write`.
 * This hook still handles .json/.md files for Biome, and all
 * Prettier / Go / Python checks.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { findProjectRoot, detectFormatter, resolveFormatterBin } = require('../lib/resolve-formatter');

const MAX_STDIN = 1024 * 1024;

const WEB_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md']);
const JS_EXTS  = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * Execute a command synchronously, returning the spawnSync result.
 *
 * @param {string} command - Executable path or name
 * @param {string[]} args - Arguments to pass
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function exec(command, args, cwd = process.cwd()) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: 15000
  });
}

/**
 * Write a message to stderr for logging.
 *
 * @param {string} msg - Message to log
 */
function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function readEnvBool(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
}

// ── Per-formatter / per-language handlers ────────────────────────

function runBiomeCheck(filePath, ext, projectRoot, fix, strict) {
  // JS/TS already handled by post-edit-format via `biome check --write`
  if (JS_EXTS.has(ext)) return;
  const resolved = resolveFormatterBin(projectRoot, 'biome');
  if (!resolved) return;
  const args = [...resolved.prefix, 'check', filePath];
  if (fix) args.push('--write');
  const result = exec(resolved.bin, args, projectRoot);
  if (result.status !== 0 && strict) {
    log(`[QualityGate] Biome check failed for ${filePath}`);
  }
}

function runPrettierCheck(filePath, projectRoot, fix, strict) {
  const resolved = resolveFormatterBin(projectRoot, 'prettier');
  if (!resolved) return;
  const args = [...resolved.prefix, fix ? '--write' : '--check', filePath];
  const result = exec(resolved.bin, args, projectRoot);
  if (result.status !== 0 && strict) {
    log(`[QualityGate] Prettier check failed for ${filePath}`);
  }
}

function warnNoFormatter(ext, projectRoot) {
  // No formatter configured — emit a visible warning instead of silently skipping.
  // Previously this code path returned silently, creating false confidence that checks
  // ran when they did not. Engineers discovered the gap only during code review.
  // A warning here makes the configuration gap immediately visible at edit time.
  if (!JS_EXTS.has(ext)) return;
  process.stderr.write(
    `[quality-gate] WARNING: No formatter (Biome or Prettier) found in ${projectRoot}.\n` +
    `  TypeScript/JavaScript files are not being checked or formatted.\n` +
    `  Fix: create .prettierrc or biome.json in the project root.\n`
  );
}

function runWebCheck(filePath, ext, projectRoot, fix, strict) {
  const formatter = detectFormatter(projectRoot);
  if (formatter === 'biome') { runBiomeCheck(filePath, ext, projectRoot, fix, strict); return; }
  if (formatter === 'prettier') { runPrettierCheck(filePath, projectRoot, fix, strict); return; }
  warnNoFormatter(ext, projectRoot);
}

function runGoCheck(filePath, fix, strict) {
  if (fix) {
    const r = exec('gofmt', ['-w', filePath]);
    if (r.status !== 0 && strict) log(`[QualityGate] gofmt failed for ${filePath}`);
    return;
  }
  if (strict) {
    const r = exec('gofmt', ['-l', filePath]);
    if (r.status !== 0) log(`[QualityGate] gofmt failed for ${filePath}`);
    else if (r.stdout && r.stdout.trim()) log(`[QualityGate] gofmt check failed for ${filePath}`);
  }
}

function runPythonCheck(filePath, fix, strict) {
  const args = ['format'];
  if (!fix) args.push('--check');
  args.push(filePath);
  const r = exec('ruff', args);
  if (r.status !== 0 && strict) log(`[QualityGate] Ruff check failed for ${filePath}`);
}

// ── Dispatch table: extension → handler(filePath, fix, strict) ───

const EXT_HANDLER = {
  '.go': runGoCheck,
  '.py': runPythonCheck,
};

/**
 * Run quality-gate checks for a single file based on its extension.
 *
 * @param {string} filePath - Path to the edited file
 */
function maybeRunQualityGate(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  filePath = path.resolve(filePath);
  const ext    = path.extname(filePath).toLowerCase();
  const fix    = readEnvBool('ECC_QUALITY_GATE_FIX');
  const strict = readEnvBool('ECC_QUALITY_GATE_STRICT');

  if (WEB_EXTS.has(ext)) {
    runWebCheck(filePath, ext, findProjectRoot(path.dirname(filePath)), fix, strict);
    return;
  }
  const handler = EXT_HANDLER[ext];
  if (handler) handler(filePath, fix, strict);
}

/**
 * Core logic — exported so run-with-flags.js can call directly.
 *
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {string} The original input (pass-through)
 */
function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    const filePath = String(input.tool_input?.file_path || '');
    maybeRunQualityGate(filePath);
  } catch {
    // Ignore parse errors.
  }
  return rawInput;
}

// ── stdin entry point (backwards-compatible) ────────────────────
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
    }
  });

  process.stdin.on('end', () => {
    const result = run(raw);
    process.stdout.write(result);
  });
}

module.exports = { run };
