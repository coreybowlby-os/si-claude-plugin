#!/usr/bin/env node
/**
 * Run all tests
 *
 * Usage: node tests/run-all.js
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testsDir = __dirname;
const repoRoot = path.resolve(testsDir, '..');
const TEST_GLOB = 'tests/**/*.test.js';

function matchesTestGlob(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (typeof path.matchesGlob === 'function') {
    return path.matchesGlob(normalized, TEST_GLOB);
  }

  return /^tests\/(?:.+\/)?[^/]+\.test\.js$/.test(normalized);
}

function walkFiles(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, acc);
    } else if (entry.isFile()) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function discoverTestFiles() {
  return walkFiles(testsDir)
    .map(fullPath => path.relative(repoRoot, fullPath))
    .filter(matchesTestGlob)
    .map(repoRelativePath => path.relative(testsDir, path.join(repoRoot, repoRelativePath)))
    .sort();
}

const testFiles = discoverTestFiles();

const BOX_W = 58; // inner width between ║ delimiters
const boxLine = s => `║${s.padEnd(BOX_W)}║`;

console.log('╔' + '═'.repeat(BOX_W) + '╗');
console.log(boxLine('           SI Claude Plugin - Test Suite'));
console.log('╚' + '═'.repeat(BOX_W) + '╝');
console.log();

if (testFiles.length === 0) {
  console.log(`✗ No test files matched ${TEST_GLOB}`);
  process.exit(1);
}

let totalPassed = 0;
let totalFailed = 0;
let totalTests = 0;

for (const testFile of testFiles) {
  const testPath = path.join(testsDir, testFile);
  const displayPath = testFile.split(path.sep).join('/');

  if (!fs.existsSync(testPath)) {
    console.log(`WARNING Skipping ${displayPath} (file not found)`);
    continue;
  }

  console.log(`\n━━━ Running ${displayPath} ━━━`);

  // Run each test hermetically: strip inherited git env vars. When the suite
  // runs inside a git hook (e.g. pre-push), git sets GIT_DIR/GIT_WORK_TREE,
  // which would hijack `git -C <dir>` calls in tests that exercise real git
  // and make them operate on the host repo instead of their own fixtures.
  const childEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    delete childEnv[key];
  }

  // Bound every suite. Without a timeout a single hung suite holds the whole
  // lane until the CI job's own deadline kills it, and the job log then shows
  // no suite name, no signal and no error code — which is why intermittent
  // stalls here have been so hard to attribute. The budget is deliberately
  // larger than the largest in-suite spawn budget (120s in the hook suites) so
  // that a suite always gets to report its own failure first; this only fires
  // when a suite is genuinely stuck.
  //
  // maxBuffer is set explicitly because the default is 1MB: a suite that ever
  // printed more than that would be killed mid-run and surface as a bare
  // `status: null`, indistinguishable from a crash.
  const SUITE_TIMEOUT_MS = 300000;
  const startedAt = Date.now();
  const result = spawnSync('node', [testPath], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    timeout: SUITE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  // Show both stdout and stderr so hook warnings are visible
  if (stdout) console.log(stdout);
  if (stderr) console.log(stderr);

  // Parse results from combined output
  const combined = stdout + stderr;
  const passedMatch = combined.match(/Passed:\s*(\d+)/);
  const failedMatch = combined.match(/Failed:\s*(\d+)/);

  if (passedMatch) totalPassed += parseInt(passedMatch[1], 10);
  if (failedMatch) totalFailed += parseInt(failedMatch[1], 10);

  // spawnSync reports a timeout, a signal kill, a failed spawn and a maxBuffer
  // overflow all as `status: null`. Print the fields that tell them apart so a
  // stall names itself instead of reading as a generic failure.
  const elapsedMs = Date.now() - startedAt;
  const spawnDetail =
    ` [status=${result.status} signal=${result.signal || 'none'}` +
    ` error=${(result.error && result.error.code) || 'none'} elapsed=${elapsedMs}ms]`;

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    console.log(
      `✗ ${displayPath} ${timedOut ? `timed out after ${SUITE_TIMEOUT_MS}ms` : `failed to start: ${result.error.message}`}${spawnDetail}`
    );
    totalFailed += failedMatch ? 0 : 1;
    continue;
  }

  if (result.status !== 0) {
    console.log(`✗ ${displayPath} exited with status ${result.status}${result.status === null ? spawnDetail : ''}`);
    totalFailed += failedMatch ? 0 : 1;
  }
}

totalTests = totalPassed + totalFailed;

console.log('\n╔' + '═'.repeat(BOX_W) + '╗');
console.log(boxLine('                     Final Results'));
console.log('╠' + '═'.repeat(BOX_W) + '╣');
console.log(boxLine(`  Total Tests: ${String(totalTests).padStart(4)}`));
console.log(boxLine(`  Passed:      ${String(totalPassed).padStart(4)}  ✓`));
console.log(boxLine(`  Failed:      ${String(totalFailed).padStart(4)}  ${totalFailed > 0 ? '✗' : ' '}`));
console.log('╚' + '═'.repeat(BOX_W) + '╝');

process.exit(totalFailed > 0 ? 1 : 0);
