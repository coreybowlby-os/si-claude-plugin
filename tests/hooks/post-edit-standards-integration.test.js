"use strict";

/**
 * Integration test for post-edit-standards.js — validates the architecture review
 * prompt added in PR #31 and the ESLint Windows path fix.
 *
 * Three scenarios against REAL ESLint using the integration-hub eslint.config.js:
 *   1. *.service.ts with critical violations -> report + architecture review prompt
 *   2. *.service.ts with no violations       -> no output (clean, no noise)
 *   3. *.dto.ts with critical violations     -> report only, no architecture prompt
 *
 * REQUIRES: npm install in integration-hub directory.
 */

const assert  = require("assert");
const path    = require("path");
const fs      = require("fs");
const { spawnSync } = require("child_process");

const HOOK_SCRIPT     = path.resolve(__dirname, "../../scripts/hooks/post-edit-standards.js");
const INTEGRATION_HUB = path.resolve(__dirname, "../../../integration-hub");
const ESLINT_BIN      = path.join(INTEGRATION_HUB, "node_modules", "eslint", "bin", "eslint.js");

function prereqCheck() {
  if (!fs.existsSync(ESLINT_BIN)) {
    process.stdout.write("SKIP: integration-hub eslint not found. Run npm install in integration-hub.\n");
    process.exit(0);
  }
}

function runHook(filePath) {
  const toolInput = JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });
  const result = spawnSync("node", [HOOK_SCRIPT], {
    input: toolInput, encoding: "utf8", timeout: 30000, cwd: INTEGRATION_HUB,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 0 };
}

function writeTestFile(dir, filename, content) {
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

// Test file contents — complexity violations that ESLint's eslint.config.js will catch

const SERVICE_BAD = `
import { Injectable } from "@nestjs/common";
@Injectable()
export class BadService {
  process(a: number, b: number, c: number): number {
    if (a > 0) {
      if (b > 1) {
        if (c > 2) {
          if (a > b) {
            if (b > c) {
              if (c > 0) { return a + b + c; }
            }
          }
        }
      }
    }
    return 0;
  }
}
`;

const SERVICE_CLEAN = `
import { Injectable } from "@nestjs/common";
/** Minimal clean service — no violations. */
@Injectable()
export class CleanService {
  greet(name: string): string { return "Hello " + name; }
}
`;

const DTO_BAD = `
import { z } from "zod";
function validate(a: number, b: number, c: number): boolean {
  if (a > 0) {
    if (b > 1) {
      if (c > 2) {
        if (a > b) {
          if (b > c) {
            if (c > 0) { return true; }
          }
        }
      }
    }
  }
  return false;
}
export const Schema = z.object({ slug: z.string() });
`;

// Run tests

prereqCheck();

// Use a non-hidden directory inside src/ so ESLint's file patterns match
const tmp = fs.mkdtempSync(path.join(INTEGRATION_HUB, "src", "test-standards-"));

let passed = 0, failed = 0;
function test(desc, fn) {
  try { fn(); process.stdout.write("  PASS " + desc + "\n"); passed++; }
  catch (e) { process.stdout.write("  FAIL " + desc + "\n       " + e.message + "\n"); failed++; }
}

// Scenario 1: bad service file

process.stdout.write("\nScenario 1: bad.service.ts (critical violations)\n");
const s1path = writeTestFile(tmp, "bad.service.ts", SERVICE_BAD);
const s1 = runHook(s1path);

test("exits 1 — Claude is blocked", () => assert.strictEqual(s1.exitCode, 1, "exit: " + s1.exitCode + "\nstderr:\n" + s1.stderr));
test("ACTION REQUIRED in violation report", () => assert.ok(s1.stderr.includes("ACTION REQUIRED"), s1.stderr));
test("ARCHITECTURE FILE prompt shown", () => assert.ok(s1.stderr.includes("ARCHITECTURE FILE"), s1.stderr));
test("code-reviewer agent mentioned", () => assert.ok(s1.stderr.includes("code-reviewer"), s1.stderr));
test("ADR compliance referenced", () => assert.ok(s1.stderr.includes("ADR"), s1.stderr));

// Scenario 2: clean service file

process.stdout.write("\nScenario 2: clean.service.ts (no violations)\n");
const s2path = writeTestFile(tmp, "clean.service.ts", SERVICE_CLEAN);
const s2 = runHook(s2path);

test("exits 0", () => assert.strictEqual(s2.exitCode, 0, "exit: " + s2.exitCode));
test("NO architecture prompt for clean file", () => assert.ok(!s2.stderr.includes("ARCHITECTURE FILE"), s2.stderr));
test("stderr silent or auto-fix only", () => {
  const noise = s2.stderr.split("\n").filter(function(l) {
    return l.trim() && !l.includes("auto-fixed") && !l.includes("[standards]");
  }).join("");
  assert.strictEqual(noise, "", "unexpected output:\n" + s2.stderr);
});

// Scenario 3: DTO file with violations

process.stdout.write("\nScenario 3: bad.dto.ts (non-architecture file with violations)\n");
const s3path = writeTestFile(tmp, "bad.dto.ts", DTO_BAD);
const s3 = runHook(s3path);

test("NO architecture prompt for DTO", () => assert.ok(!s3.stderr.includes("ARCHITECTURE FILE"), s3.stderr));
test("NO code-reviewer mention for DTO", () => assert.ok(!s3.stderr.includes("code-reviewer"), s3.stderr));

// Cleanup

fs.rmSync(tmp, { recursive: true, force: true });

// Summary

process.stdout.write("\n" + passed + " passed, " + failed + " failed\n");
if (failed > 0) {
  process.stdout.write("\n--- Scenario 1 stderr ---\n" + s1.stderr);
  process.stdout.write("--- Scenario 2 stderr ---\n" + s2.stderr);
  process.stdout.write("--- Scenario 3 stderr ---\n" + s3.stderr);
  process.exit(1);
}
