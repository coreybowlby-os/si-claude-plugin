const adalProject = require('./adal-project');
const antigravityProject = require('./antigravity-project');
const claudeHome = require('./claude-home');
const claudeProject = require('./claude-project');
const codebuddyProject = require('./codebuddy-project');
const codexHome = require('./codex-home');
const cursorProject = require('./cursor-project');
const geminiProject = require('./gemini-project');
const hermesHome = require('./hermes-home');
const joycodeProject = require('./joycode-project');
const kimiProject = require('./kimi-project');
const openclawHome = require('./openclaw-home');
const opencodeHome = require('./opencode-home');
const qwenHome = require('./qwen-home');
const zedProject = require('./zed-project');
const path = require('path');

const { resolveInvocationEnvironment } = require('../invocation-environment');

const SELF_INSTALL_TARGET_CODE = 'target-root-inside-repo-root';

function isPathWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const ADAPTERS = Object.freeze([
  claudeHome,
  claudeProject,
  cursorProject,
  antigravityProject,
  codexHome,
  geminiProject,
  hermesHome,
  opencodeHome,
  openclawHome,
  codebuddyProject,
  joycodeProject,
  kimiProject,
  qwenHome,
  zedProject,
  adalProject,
]);

function listInstallTargetAdapters() {
  return ADAPTERS.slice();
}

function getInstallTargetAdapter(targetOrAdapterId) {
  const adapter = ADAPTERS.find(candidate => candidate.supports(targetOrAdapterId));

  if (!adapter) {
    throw new Error(`Unknown install target adapter: ${targetOrAdapterId}`);
  }

  return adapter;
}

function planInstallTargetScaffold(options = {}) {
  const adapter = getInstallTargetAdapter(options.target);
  const modules = Array.isArray(options.modules) ? options.modules : [];
  const exemptValidationCodes = new Set(Array.isArray(options.exemptValidationCodes) ? options.exemptValidationCodes : []);
  const planningInput = {
    repoRoot: options.repoRoot,
    projectRoot: options.projectRoot || options.repoRoot,
    homeDir: options.homeDir,
    env: resolveInvocationEnvironment(options),
  };
  const validationIssues = adapter.validate(planningInput);
  const targetRoot = adapter.resolveRoot(planningInput);
  const installStatePath = adapter.getInstallStatePath(planningInput);

  // Guard against self-installs: when the installer runs from inside the ECC
  // source repo without a separate project root, managed writes land in the
  // source tree and corrupt the distribution (e.g. the stale .kimi mirror
  // produced by a v2.1.0 self-run). Reject unless explicitly exempted.
  const resolvedRepoRoot = planningInput.repoRoot ? path.resolve(planningInput.repoRoot) : null;
  if (resolvedRepoRoot && isPathWithin(resolvedRepoRoot, path.resolve(targetRoot))) {
    validationIssues.push({
      severity: 'error',
      code: SELF_INSTALL_TARGET_CODE,
      message: `Refusing to plan ${adapter.id} install: target root ${targetRoot} is inside the ECC source repo ${resolvedRepoRoot}. Run the installer from a project directory outside the source repo, or exempt '${SELF_INSTALL_TARGET_CODE}' if this is intentional.`,
    });
  }

  const blockingIssues = validationIssues.filter(issue => (
    issue.severity === 'error' && !exemptValidationCodes.has(issue.code)
  ));
  if (blockingIssues.length > 0) {
    throw new Error(blockingIssues.map(issue => issue.message).join('; '));
  }
  const operations = adapter.planOperations({
    ...planningInput,
    modules,
  });

  return {
    adapter: {
      id: adapter.id,
      target: adapter.target,
      kind: adapter.kind,
    },
    targetRoot,
    installStatePath,
    validationIssues,
    operations,
  };
}

module.exports = {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
  planInstallTargetScaffold,
};
