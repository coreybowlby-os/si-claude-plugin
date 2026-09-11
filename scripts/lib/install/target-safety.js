'use strict';

const fs = require('fs');
const path = require('path');

// Self-install protection is NOT here. `install-targets/registry.js` rejects any
// target root inside the source repo, for every adapter, via path containment —
// broader and better placed than a check at one entrypoint. This module covers only
// the case that guard does not: a project install into somebody else's git repo.

function readTextIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/** True when .gitignore excludes the whole .claude directory. */
function gitignoreCoversClaudeDir(cwd) {
  return readTextIfPresent(path.join(cwd, '.gitignore'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => line === '.claude' || line === '.claude/' || line === '.claude/*');
}

/**
 * A project install writes hundreds of files into ./.claude/. In a git repo whose
 * .gitignore does not cover that directory they all land untracked in the working
 * tree, where they are easy to commit by accident — this plugin's own repo produced
 * 167 such entries before the check existed.
 *
 * Returns { kind: 'ok' } or { kind: 'untracked-git', message }.
 */
function checkProjectInstallTarget(targetRoot, cwd) {
  if (!targetRoot || !String(targetRoot).includes(`${path.sep}.claude`)) {
    return { kind: 'ok' };
  }
  if (!fs.existsSync(path.join(cwd, '.git')) || gitignoreCoversClaudeDir(cwd)) {
    return { kind: 'ok' };
  }
  return {
    kind: 'untracked-git',
    message: [
      'This is a git repository and .gitignore does not cover .claude/.',
      `  ${cwd}`,
      '  The install will leave hundreds of untracked files in your working tree,',
      '  which are easy to commit by accident.',
      '  Add ".claude/" to .gitignore, or re-run with --allow-untracked.',
    ].join('\n'),
  };
}

module.exports = {
  checkProjectInstallTarget,
  gitignoreCoversClaudeDir,
};
