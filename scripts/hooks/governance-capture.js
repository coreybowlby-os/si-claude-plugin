#!/usr/bin/env node
/**
 * Governance Event Capture Hook
 *
 * PreToolUse/PostToolUse hook that detects governance-relevant events
 * and writes them to the governance_events table in the state store.
 *
 * Captured event types:
 *   - secret_detected: Hardcoded secrets in tool input/output
 *   - policy_violation: Actions that violate configured policies
 *   - security_finding: Security-relevant tool invocations
 *   - approval_requested: Operations requiring explicit approval
 *   - hook_input_truncated: Hook input exceeded the safe inspection limit
 *
 * Enable: Set ECC_GOVERNANCE_CAPTURE=1
 * Configure session: Set ECC_SESSION_ID for session correlation
 */

'use strict';

const crypto = require('crypto');

const MAX_STDIN = 1024 * 1024;

// Patterns that indicate potential hardcoded secrets
const SECRET_PATTERNS = [
  { name: 'aws_key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/i },
  { name: 'generic_secret', pattern: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
];

// Tool names that represent security-relevant operations
const SECURITY_RELEVANT_TOOLS = new Set([
  'Bash', // Could execute arbitrary commands
]);

// Commands that require governance approval
const APPROVAL_COMMANDS = [
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /rm\s+-rf?\s/,
  /DROP\s+(?:TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+\s*(?:;|$)/i,
];

// File patterns that indicate policy-sensitive paths
const SENSITIVE_PATHS = [
  /\.env(?:\.|$)/,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
];

/**
 * Generate a unique event ID.
 */
function generateEventId() {
  return `gov-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Scan text content for hardcoded secrets.
 * Returns array of { name, match } for each detected secret.
 */
function detectSecrets(text) {
  if (!text || typeof text !== 'string') return [];

  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ name });
    }
  }
  return findings;
}

/**
 * Check if a command requires governance approval.
 */
function detectApprovalRequired(command) {
  if (!command || typeof command !== 'string') return [];

  const findings = [];
  for (const pattern of APPROVAL_COMMANDS) {
    if (pattern.test(command)) {
      findings.push({ pattern: pattern.source });
    }
  }
  return findings;
}

/**
 * Check if a file path is policy-sensitive.
 */
function detectSensitivePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;

  return SENSITIVE_PATHS.some(pattern => pattern.test(filePath));
}

function fingerprintCommand(command) {
  if (!command || typeof command !== 'string') return null;
  return crypto.createHash('sha256').update(command).digest('hex').slice(0, 12);
}

function summarizeCommand(command) {
  if (!command || typeof command !== 'string') {
    return {
      commandName: null,
      commandFingerprint: null,
    };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return {
      commandName: null,
      commandFingerprint: null,
    };
  }

  return {
    commandName: trimmed.split(/\s+/)[0] || null,
    commandFingerprint: fingerprintCommand(trimmed),
  };
}

function emitGovernanceEvent(event) {
  process.stderr.write(`[governance] ${JSON.stringify(event)}\n`);
}

function makeEvent(eventType, sessionId, payload) {
  return { id: generateEventId(), sessionId, eventType, payload, resolvedAt: null, resolution: null };
}

function buildAnalysisContext(input, context) {
  const toolInput = input.tool_input || {};
  return {
    toolName:   input.tool_name || '',
    toolInput,
    toolOutput: typeof input.tool_output === 'string' ? input.tool_output : '',
    sessionId:  context.sessionId || null,
    hookPhase:  context.hookPhase || 'unknown',
    inputText:  typeof toolInput === 'object' ? JSON.stringify(toolInput) : String(toolInput),
  };
}

function detectSecretEvents(ctx) {
  const inputSecrets  = detectSecrets(ctx.inputText);
  const outputSecrets = detectSecrets(ctx.toolOutput);
  const allSecrets    = [...inputSecrets, ...outputSecrets];
  if (allSecrets.length === 0) return [];
  return [makeEvent('secret_detected', ctx.sessionId, {
    toolName:    ctx.toolName,
    hookPhase:   ctx.hookPhase,
    secretTypes: allSecrets.map(s => s.name),
    location:    inputSecrets.length > 0 ? 'input' : 'output',
    severity:    'critical',
  })];
}

function detectApprovalEvents(ctx) {
  if (ctx.toolName !== 'Bash') return [];
  const command  = ctx.toolInput.command || '';
  const findings = detectApprovalRequired(command);
  if (findings.length === 0) return [];
  return [makeEvent('approval_requested', ctx.sessionId, {
    toolName:        ctx.toolName,
    hookPhase:       ctx.hookPhase,
    ...summarizeCommand(command),
    matchedPatterns: findings.map(f => f.pattern),
    severity:        'high',
  })];
}

function detectPolicyViolationEvents(ctx) {
  const filePath = ctx.toolInput.file_path || ctx.toolInput.path || '';
  if (!filePath || !detectSensitivePath(filePath)) return [];
  return [makeEvent('policy_violation', ctx.sessionId, {
    toolName:  ctx.toolName,
    hookPhase: ctx.hookPhase,
    filePath:  filePath.slice(0, 200),
    reason:    'sensitive_file_access',
    severity:  'warning',
  })];
}

function detectElevatedPrivilegeEvents(ctx) {
  if (!SECURITY_RELEVANT_TOOLS.has(ctx.toolName) || ctx.hookPhase !== 'post') return [];
  const command    = ctx.toolInput.command || '';
  const hasElevated = /sudo\s/.test(command) || /chmod\s/.test(command) || /chown\s/.test(command);
  if (!hasElevated) return [];
  return [makeEvent('security_finding', ctx.sessionId, {
    toolName:  ctx.toolName,
    hookPhase: ctx.hookPhase,
    ...summarizeCommand(command),
    reason:    'elevated_privilege_command',
    severity:  'medium',
  })];
}

/**
 * Analyze a hook input payload and return governance events to capture.
 *
 * @param {Object} input - Parsed hook input (tool_name, tool_input, tool_output)
 * @param {Object} [context] - Additional context (sessionId, hookPhase)
 * @returns {Array<Object>} Array of governance event objects
 */
function analyzeForGovernanceEvents(input, context = {}) {
  const ctx = buildAnalysisContext(input, context);
  return [
    ...detectSecretEvents(ctx),
    ...detectApprovalEvents(ctx),
    ...detectPolicyViolationEvents(ctx),
    ...detectElevatedPrivilegeEvents(ctx),
  ];
}

/**
 * Core hook logic — exported so run-with-flags.js can call directly.
 *
 * @param {string} rawInput - Raw JSON string from stdin
 * @returns {string} The original input (pass-through)
 */
function run(rawInput, options = {}) {
  // Gate on feature flag
  if (String(process.env.ECC_GOVERNANCE_CAPTURE || '').toLowerCase() !== '1') {
    return rawInput;
  }

  const sessionId = process.env.ECC_SESSION_ID || null;
  const hookPhase = process.env.CLAUDE_HOOK_EVENT_NAME || 'unknown';

  if (options.truncated) {
    emitGovernanceEvent({
      id: generateEventId(),
      sessionId,
      eventType: 'hook_input_truncated',
      payload: {
        hookPhase: hookPhase.startsWith('Pre') ? 'pre' : 'post',
        sizeLimitBytes: options.maxStdin || MAX_STDIN,
        severity: 'warning',
      },
      resolvedAt: null,
      resolution: null,
    });
  }

  try {
    const input = JSON.parse(rawInput);

    const events = analyzeForGovernanceEvents(input, {
      sessionId,
      hookPhase: hookPhase.startsWith('Pre') ? 'pre' : 'post',
    });

    if (events.length > 0) {
      for (const event of events) {
        emitGovernanceEvent(event);
      }
    }
  } catch {
    // Silently ignore parse errors — never block the tool pipeline.
  }

  return rawInput;
}

// ── stdin entry point ────────────────────────────────
if (require.main === module) {
  let raw = '';
  let truncated = /^(1|true|yes)$/i.test(String(process.env.ECC_HOOK_INPUT_TRUNCATED || ''));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
      if (chunk.length > remaining) {
        truncated = true;
      }
    } else {
      truncated = true;
    }
  });

  process.stdin.on('end', () => {
    const result = run(raw, {
      truncated,
      maxStdin: Number(process.env.ECC_HOOK_INPUT_MAX_BYTES) || MAX_STDIN,
    });
    process.stdout.write(result);
  });
}

module.exports = {
  APPROVAL_COMMANDS,
  SECRET_PATTERNS,
  SECURITY_RELEVANT_TOOLS,
  SENSITIVE_PATHS,
  analyzeForGovernanceEvents,
  detectApprovalRequired,
  detectSecrets,
  detectSensitivePath,
  generateEventId,
  run,
};
