'use strict';

/**
 * Compares the `dev` field of two stat results.
 *
 * On Windows, `fs.fstatSync(fd).dev` returns the real volume serial while the
 * path-based `fs.lstatSync`/`fs.statSync` return 0 for the same file. Code that
 * compares the two to detect a swapped file therefore reports every ordinary file
 * as changed, which aborts install, repair, uninstall and migration on a healthy
 * tree. Treating a zero on either side as "unknown, not a mismatch" keeps the
 * TOCTOU check meaningful on POSIX without breaking Windows; `ino` still carries
 * the identity guarantee on both.
 */
function sameDevice(left, right) {
  if (!left || !right) return false;
  if (!left.dev || !right.dev) return true;
  return left.dev === right.dev;
}

/** True when two stat results refer to the same file. */
function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  return left.ino === right.ino && sameDevice(left, right);
}

module.exports = { sameDevice, sameFileIdentity };
