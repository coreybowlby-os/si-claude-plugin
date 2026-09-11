'use strict';

const fs = require('fs');
const path = require('path');

// A project-scope install copies hundreds of files into ./.claude/. The installer
// derives that location from process.cwd() and previously validated nothing about it,
// so two harmful targets were both reachable in practice.

const SELF_PACKAGE_NAME = 'si-claude-plugin';

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readTextIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * True when cwd is this plugin's own checkout. Installing there would place a second
 * copy of every skill, agent and command under .claude/, beside the originals they
 * were copied from, making it easy to edit the shadowed copy by mistake.
 */
function isPluginOwnRepository(cwd) {
  const pkg = readJsonIfPresent(path.join(cwd, 'package.json'));
  return Boolean(pkg && pkg.name === SELF_PACKAGE_NAME);
}

/** True when .gitignore excludes the whole .claude directory. */
function gitignoreCoversClaudeDir(cwd) {
  return readTextIfPresent(path.join(cwd, '.gitignore'))
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => line === '.claude' || line === '.claude/' || line === '.claude/*');
}

/**
 * Classify a project-scope install target.
 *
 * Returns one of:
 *   { kind: 'ok' }
 *   { kind: 'self-repo', message }      — never permitted
 *   { kind: 'untracked-git', message }  — permitted with allowUntracked
 */
function checkProjectInstallTarget(targetRoot, cwd) {
  if (!targetRoot || !String(targetRoot).includes(`${path.sep}.claude`)) {
    return { kind: 'ok' };
  }

  if (isPluginOwnRepository(cwd)) {
    return {
      kind: 'self-repo',
      message: [
        'Refusing to install into this plugin\'s own repository.',
        `  ${cwd}`,
        '  The source already lives in skills/, agents/ and commands/. Installing here',
        '  would create a duplicate set under .claude/ that shadows it.',
        '  Install into the project you want to use the plugin in, or use',
        '  --target claude for a user-scope install.',
      ].join('\n'),
    };
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
  isPluginOwnRepository,
  gitignoreCoversClaudeDir,
};
