'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendFile } = require('../utils');

const VALID_OUTCOMES = new Set(['success', 'failure', 'partial']);
const VALID_FEEDBACK = new Set(['accepted', 'corrected', 'rejected']);

function resolveHomeDir(homeDir) {
  return homeDir ? path.resolve(homeDir) : os.homedir();
}

function getRunsFilePath(options = {}) {
  if (options.runsFilePath) {
    return path.resolve(options.runsFilePath);
  }

  return path.join(resolveHomeDir(options.homeDir), '.claude', 'state', 'skill-runs.jsonl');
}

function toNullableNumber(value, fieldName) {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error(`${fieldName} must be a number`);
  }

  return numericValue;
}

function extractFields(input, options) {
  return {
    skillId:         input.skill_id || input.skillId,
    skillVersion:    input.skill_version || input.skillVersion,
    taskDescription: input.task_description || input.task_attempted || input.taskAttempted,
    outcome:         input.outcome,
    recordedAt:      input.recorded_at || options.now || new Date().toISOString(),
    userFeedback:    input.user_feedback || input.userFeedback || null,
    failureReason:   input.failure_reason || input.failureReason || null,
    tokensUsed:      toNullableNumber(input.tokens_used ?? input.tokensUsed, 'tokens_used'),
    durationMs:      toNullableNumber(input.duration_ms ?? input.durationMs, 'duration_ms'),
  };
}

function validateFields(f) {
  if (typeof f.skillId !== 'string' || f.skillId.trim().length === 0)
    throw new Error('skill_id is required');
  if (typeof f.skillVersion !== 'string' || f.skillVersion.trim().length === 0)
    throw new Error('skill_version is required');
  if (typeof f.taskDescription !== 'string' || f.taskDescription.trim().length === 0)
    throw new Error('task_description is required');
  if (!VALID_OUTCOMES.has(f.outcome))
    throw new Error('outcome must be one of success, failure, or partial');
  if (f.userFeedback !== null && !VALID_FEEDBACK.has(f.userFeedback))
    throw new Error('user_feedback must be accepted, corrected, rejected, or null');
  if (Number.isNaN(Date.parse(f.recordedAt)))
    throw new Error('recorded_at must be an ISO timestamp');
}

function normalizeExecutionRecord(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('skill execution payload must be an object');
  }
  const f = extractFields(input, options);
  validateFields(f);
  return {
    skill_id:         f.skillId,
    skill_version:    f.skillVersion,
    task_description: f.taskDescription,
    outcome:          f.outcome,
    failure_reason:   f.failureReason,
    tokens_used:      f.tokensUsed,
    duration_ms:      f.durationMs,
    user_feedback:    f.userFeedback,
    recorded_at:      f.recordedAt,
  };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .reduce((rows, line) => {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Ignore malformed rows so analytics remain best-effort.
      }
      return rows;
    }, []);
}

function recordSkillExecution(input, options = {}) {
  const record = normalizeExecutionRecord(input, options);

  if (options.stateStore && typeof options.stateStore.recordSkillExecution === 'function') {
    try {
      const result = options.stateStore.recordSkillExecution(record);
      return {
        storage: 'state-store',
        record,
        result,
      };
    } catch {
      // Fall back to JSONL until the formal state-store exists on this branch.
    }
  }

  const runsFilePath = getRunsFilePath(options);
  appendFile(runsFilePath, `${JSON.stringify(record)}\n`);

  return {
    storage: 'jsonl',
    path: runsFilePath,
    record,
  };
}

function readSkillExecutionRecords(options = {}) {
  if (options.stateStore && typeof options.stateStore.listSkillExecutionRecords === 'function') {
    return options.stateStore.listSkillExecutionRecords();
  }

  return readJsonl(getRunsFilePath(options));
}

module.exports = {
  VALID_FEEDBACK,
  VALID_OUTCOMES,
  getRunsFilePath,
  normalizeExecutionRecord,
  readSkillExecutionRecords,
  recordSkillExecution,
};
