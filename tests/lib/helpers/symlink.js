/**
 * Create a symlink for a test, or report that this host cannot.
 *
 * Windows without Developer Mode or admin rights refuses file symlinks with
 * EPERM/EACCES. Directory links use a junction there, which needs no
 * privilege and which Node reports as a symbolic link. Any other error is
 * rethrown so real failures are never masked.
 *
 * @param {string} target
 * @param {string} linkPath
 * @param {'file'|'dir'} [type='file']
 * @returns {boolean} true if the link was created, false if the host forbids it
 */

'use strict';

const fs = require('fs');

const UNPRIVILEGED_CODES = new Set(['EPERM', 'EACCES']);

function trySymlink(target, linkPath, type = 'file', fsModule = fs, platform = process.platform) {
  const linkType = type === 'dir' && platform === 'win32' ? 'junction' : type;
  try {
    fsModule.symlinkSync(target, linkPath, linkType);
    return true;
  } catch (error) {
    if (error && UNPRIVILEGED_CODES.has(error.code)) return false;
    throw error;
  }
}

module.exports = { trySymlink };
