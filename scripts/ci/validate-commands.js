#!/usr/bin/env node
/**
 * Validate command markdown files are non-empty, readable,
 * and have valid cross-references to other commands, agents, and skills.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../..');
const COMMANDS_DIR = path.join(ROOT_DIR, 'commands');
const AGENTS_DIR = path.join(ROOT_DIR, 'agents');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');

// ── Reference index ───────────────────────────────────────────────

function buildReferenceIndex(files) {
  const validCommands = new Set(files.map(f => f.replace(/\.md$/, '')));

  const validAgents = new Set();
  if (fs.existsSync(AGENTS_DIR)) {
    for (const f of fs.readdirSync(AGENTS_DIR)) {
      if (f.endsWith('.md')) validAgents.add(f.replace(/\.md$/, ''));
    }
  }

  const validSkills = new Set();
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR)) {
      try {
        if (fs.statSync(path.join(SKILLS_DIR, f)).isDirectory()) validSkills.add(f);
      } catch {
        // skip unreadable entries
      }
    }
  }

  return { validCommands, validAgents, validSkills };
}

// ── Per-file cross-reference checks ──────────────────────────────

function checkCommandRefs(file, content, validCommands) {
  let hasErrors = false;
  for (const line of content.split('\n')) {
    if (/creates:|would create:/i.test(line)) continue;
    for (const match of line.matchAll(/`\/([a-z][-a-z0-9]*)`/g)) {
      if (!validCommands.has(match[1])) {
        console.error(`ERROR: ${file} - references non-existent command /${match[1]}`);
        hasErrors = true;
      }
    }
  }
  return hasErrors;
}

function checkAgentRefs(file, content, validAgents) {
  let hasErrors = false;
  for (const match of content.matchAll(/agents\/([a-z][-a-z0-9]*)\.md/g)) {
    if (!validAgents.has(match[1])) {
      console.error(`ERROR: ${file} - references non-existent agent agents/${match[1]}.md`);
      hasErrors = true;
    }
  }
  return hasErrors;
}

function checkSkillRefs(file, content, validSkills) {
  const reservedSkillRoots = new Set(['learned', 'imported']);
  let warnCount = 0;
  for (const match of content.matchAll(/skills\/([a-z][-a-z0-9]*)\//g)) {
    if (reservedSkillRoots.has(match[1]) || validSkills.has(match[1])) continue;
    console.warn(`WARN: ${file} - references skill directory skills/${match[1]}/ (not found locally)`);
    warnCount++;
  }
  return warnCount;
}

function checkWorkflowRefs(file, content, validAgents) {
  let hasErrors = false;
  for (const match of content.matchAll(/^([a-z][-a-z0-9]*(?:\s*->\s*[a-z][-a-z0-9]*)+)$/gm)) {
    for (const agent of match[1].split(/\s*->\s*/)) {
      if (!validAgents.has(agent)) {
        console.error(`ERROR: ${file} - workflow references non-existent agent "${agent}"`);
        hasErrors = true;
      }
    }
  }
  return hasErrors;
}

function validateCommandFile(file, content, index) {
  // Strip fenced code blocks — examples inside ``` are not real references
  const stripped = content.replace(/```[\s\S]*?```/g, '');
  let hasErrors = false;
  let warnCount = 0;
  hasErrors = checkCommandRefs(file, stripped, index.validCommands) || hasErrors;
  hasErrors = checkAgentRefs(file, stripped, index.validAgents) || hasErrors;
  warnCount += checkSkillRefs(file, stripped, index.validSkills);
  hasErrors = checkWorkflowRefs(file, stripped, index.validAgents) || hasErrors;
  return { hasErrors, warnCount };
}

// ── Entry point ───────────────────────────────────────────────────

function validateCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) {
    console.log('No commands directory found, skipping validation');
    process.exit(0);
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  const index = buildReferenceIndex(files);
  let hasErrors = false;
  let warnCount = 0;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
    } catch (err) {
      console.error(`ERROR: ${file} - ${err.message}`);
      hasErrors = true;
      continue;
    }

    if (content.trim().length === 0) {
      console.error(`ERROR: ${file} - Empty command file`);
      hasErrors = true;
      continue;
    }

    const result = validateCommandFile(file, content, index);
    if (result.hasErrors) hasErrors = true;
    warnCount += result.warnCount;
  }

  if (hasErrors) process.exit(1);

  let msg = `Validated ${files.length} command files`;
  if (warnCount > 0) msg += ` (${warnCount} warnings)`;
  console.log(msg);
}

validateCommands();
