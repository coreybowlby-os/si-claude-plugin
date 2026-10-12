/**
 * npm runs package.json scripts with cmd.exe on Windows, which does not strip
 * single quotes. A single-quoted glob such as '**\/*.md' therefore reaches the
 * tool with the quotes attached, matches nothing, and the tool may exit 0 —
 * a silent pass that a Linux-only CI lane never notices.
 *
 * Run with: node tests/scripts/package-scripts-portability.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, banner, summary } = require('../lib/helpers/mini-test-runner');

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');
const SINGLE_QUOTED_GLOB = /'[^']*[*?[{][^']*'/g;

let passed = 0;
let failed = 0;

banner('package.json script portability');

if (test('no npm script passes a single-quoted glob (cmd.exe keeps the quotes)', () => {
  const { scripts } = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const offenders = Object.entries(scripts)
    .flatMap(([name, command]) => (command.match(SINGLE_QUOTED_GLOB) || []).map(glob => `${name}: ${glob}`));
  assert.deepStrictEqual(offenders, [], 'Use escaped double quotes (\\"**/*.md\\"), which every shell strips');
})) passed++; else failed++;

summary(passed, failed);
