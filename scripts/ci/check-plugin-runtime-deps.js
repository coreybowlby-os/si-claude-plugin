#!/usr/bin/env node
/**
 * Fail if anything the plugin runs automatically needs an npm package.
 *
 * Claude Code's plugin installer installs npm packages only from a
 * package-lock.json. This repo's canonical lockfile is yarn.lock, so a plugin
 * install ships with no node_modules at all. Hook commands and
 * plugin-registered MCP servers therefore must load using Node built-ins and
 * repo files only; the npx CLI path and CI tooling are unaffected.
 *
 * Starting from every script referenced by hooks/hooks.json and by local MCP
 * servers in .mcp.json / plugin.json, this follows relative require()/import
 * edges and string literals naming another local script (spawn targets), and
 * reports every bare package specifier that is not a Node built-in.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const SCRIPT_PATH = /scripts\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs)/g;
const MODULE_SPECIFIER = /\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
const LOCAL_SCRIPT_LITERAL = /['"]([^'"\n]*\.(?:js|mjs|cjs))['"]/g;
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const SOURCE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '/index.js'];

// Entry points that install the plugin's npm packages themselves before
// running code that needs them. The exemption holds only while the file still
// checks for node_modules and runs `npm install`; drop that step and the
// entry is reported again.
const SELF_PROVISIONING_ENTRIES = new Map([
  ['scripts/hooks/session-start-plugin-sync.js',
    'runs npm install --ignore-scripts when node_modules is missing, before spawning install-apply.js'],
]);
const PROVISIONS_DEPENDENCIES = [/['"]node_modules['"]/, /\[\s*['"]install['"]/];

function selfProvisions(pluginRoot, entry) {
  if (!SELF_PROVISIONING_ENTRIES.has(entry)) return false;
  const source = stripComments(fs.readFileSync(path.join(pluginRoot, entry), 'utf8'));
  return PROVISIONS_DEPENDENCIES.every(pattern => pattern.test(source));
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot parse ${filePath}: ${error.message}`, { cause: error });
  }
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function scriptPathsIn(text) {
  return [...new Set(String(text).match(SCRIPT_PATH) || [])];
}

function localMcpScripts(servers) {
  return Object.values(servers || {})
    .filter(server => server && server.command !== 'npx')
    .flatMap(server => scriptPathsIn([server.command, ...(server.args || [])].join(' ')));
}

function collectEntryPoints(pluginRoot) {
  const hooks = readJson(path.join(pluginRoot, 'hooks', 'hooks.json'));
  const mcp = readJson(path.join(pluginRoot, '.mcp.json'));
  const manifest = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const entries = new Set([
    ...scriptPathsIn(hooks ? JSON.stringify(hooks) : ''),
    ...localMcpScripts(mcp && mcp.mcpServers),
    ...localMcpScripts(manifest && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : null),
  ]);
  return { entries: [...entries].filter(rel => fs.existsSync(path.join(pluginRoot, rel))).sort() };
}

function resolveLocal(pluginRoot, fromFile, specifier) {
  const bases = [path.resolve(path.dirname(fromFile), specifier)];
  if (specifier.startsWith('scripts/')) bases.push(path.join(pluginRoot, specifier));
  for (const base of bases) {
    for (const ext of SOURCE_EXTENSIONS) {
      const candidate = base + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isBuiltin(specifier) {
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.replace(/\/$/, '')) || BUILTINS.has(packageName(specifier));
}

function* edgesOf(source) {
  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    yield { kind: 'module', specifier: match[1] || match[2] || match[3] || match[4] };
  }
  for (const match of source.matchAll(LOCAL_SCRIPT_LITERAL)) {
    yield { kind: 'path', specifier: match[1] };
  }
}

function packagesReachedFrom(pluginRoot, entry) {
  const found = new Map();
  const visited = new Set();
  const queue = [[path.join(pluginRoot, entry), [entry]]];
  while (queue.length) {
    const [file, chain] = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const { kind, specifier } of edgesOf(source)) {
      const relative = specifier.startsWith('.') || specifier.startsWith('scripts/') || kind === 'path';
      if (relative) {
        const next = resolveLocal(pluginRoot, file, specifier);
        if (next && !visited.has(next)) queue.push([next, [...chain, toPosix(path.relative(pluginRoot, next))]]);
        continue;
      }
      if (isBuiltin(specifier)) continue;
      const pkg = packageName(specifier);
      if (!found.has(pkg)) found.set(pkg, chain);
    }
  }
  return found;
}

function findRuntimeDependencyViolations(pluginRoot) {
  const { entries } = collectEntryPoints(pluginRoot);
  return entries
    .filter(entry => !selfProvisions(pluginRoot, entry))
    .flatMap(entry => [...packagesReachedFrom(pluginRoot, entry)]
    .map(([pkg, chain]) => ({ entry, pkg, chain })));
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  const violations = findRuntimeDependencyViolations(root);
  for (const v of violations) {
    process.stderr.write(`ERROR: ${v.entry} needs npm package '${v.pkg}' (via ${v.chain.join(' > ')})\n`);
  }
  if (violations.length) {
    process.stderr.write('Plugin installs ship without node_modules; hooks and plugin MCP servers must use Node built-ins only.\n');
    process.exit(1);
  }
  process.stdout.write(`Plugin runtime surfaces need no npm packages (${collectEntryPoints(root).entries.length} entry scripts checked)\n`);
}

module.exports = { collectEntryPoints, findRuntimeDependencyViolations };
