import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateProviderSettingsClient } from './lib/migrate-provider-settings.mjs';
import { migrateWebuiChatRenderers } from './webui-chat-compat.mjs';
import { migrateWebuiPromptOptimize } from './webui-prompt-optimize-compat.mjs';
import { migrateWebuiNativeModelSelection } from './webui-native-model-selection-compat.mjs';
import { migrateWebuiContinue } from './webui-continue-compat.mjs';
import { migrateWebuiInputChatToolShapes } from './webui-input-chat-tool-compat.mjs';
import { fileURLToPath } from 'node:url';

// Bounded to the seven reviewed archives and upstream c389f96. This is NOT a
// general JS codemod, package installer, rebuild, or runtime compatibility test.
export const officialVersion = '0.1.5-rc.2';
// The audited upstream source checkout used to rebuild the compatibility
// adapter is still pinned at the last reviewed alpha source. It is evidence
// for the transformation, not the runtime kernel target.
export const reviewedSourceVersion = '0.1.3-alpha.2';
const prefix = '@deepseek-ai/';
const runtime = `${prefix}dsh-client-runtime`;
const store = `${prefix}dsh-client-store`;
const renderer = 'dsh-client-ui-renderer';
const sessions = 'dsh-api-session-controller';
const workspaces = 'dsh-api-workspace-controller';
const locale = 'dsh-client-locale';
const owners = [renderer, locale, 'dsh-client-connection', sessions, workspaces,
  'dsh-client-ui-settings', 'dsh-api-remotes', 'dsh-client-ui-layout'];

const reviewed = [
  ['dsh-plugin-wallpaper-engine', '0.6.7', 'dsh-plugin-wallpaper-engine-0.6.7.tgz',
    '18dfd3223c25d6aba8400066a90190bbb60e9c56e68177383e9c9b77361c36a4', [renderer]],
  ['dsh-drag-and-drop', '0.1.6', 'dsh-drag-and-drop-0.1.6.tgz',
    '9421006e694dbb4fa3784d1b429785a24422fd69d46dcf35a73c62b72c33d7c2',
    [sessions, workspaces]],
  ['@dsh-external/dsh-visualize', '0.1.2', 'dsh-external-dsh-visualize-0.1.2.tgz',
    'ee4ff2963c94ac77bddc3126e84ba1f77c374c334f4d0d1fc184a6c2d6c4d808',
    [renderer, 'dsh-client-ui-tool', 'dsh-client-ui-conversation']],
  ['@dsh-external/dsh-webui', '0.5.1', 'dsh-external-dsh-webui-0.5.1.tgz',
    '68b2895fae3f644303d10578b8141e3d2a6903b6a77d3452739f3cc2c73e54d7',
    [...owners, 'dsh-client-ui-conversation']],
  ['dsh-usage-skill', '0.3.0', 'dsh-usage-skill-0.3.0.tgz',
    'ff74e3ae3a28ec89e392afe3cbf47db0a60e1504dedeae54e6a384a346cc8108',
    [renderer, locale]],
  ['@ha-na-bi/dsh-client-ui-custom', '0.1.0-rc.6', 'ha-na-bi-dsh-client-ui-custom-0.1.0-rc.6.tgz',
    '71d9513692b1cd8450e734b8f3b5fad2e304cd3b6d4c1bfa5a9a3a9a59255d89',
    owners],
  ['@local/dsh-webui-statem-bridge', '1.2.2', 'local-dsh-webui-statem-bridge-1.2.2.tgz',
    'feade65f2ec60bd847a7b8fc1315ca1ce869990404ea21f64663f8d24e6e0456', []],
  ['@vlln/dsh-navbar', '0.4.0', 'vlln-dsh-navbar-0.4.0.tgz',
    '9e990f23042c40078a9c8f0214087d33dd3a3552286ad4b14f8930132208ec7b',
    [renderer, locale]],
];
export const reviewedPackages = Object.freeze(reviewed.map(([name, version, archive]) =>
  Object.freeze({ name, version, archive })));

// Versions of vendored Cordis, Schemastery and React are deliberately untouched.
const officialPeers = new Set([
  ...owners, 'dsh-client-store', 'dsh-agent', 'dsh-client-ui-attachment',
  'dsh-client-ui-conversation', 'dsh-client-ui-input-trigger',
  'dsh-client-ui-model-selection', 'dsh-client-ui-primitives',
  'dsh-client-ui-slots', 'dsh-client-ui-theme', 'dsh-client-ui-tool',
  'dsh-client-ui-chat', 'dsh-credentials', 'dsh-launch-environment',
  'dsh-llm', 'dsh-settings', 'dsh-tools', 'dsh-web', 'dsh-invariants',
  'dsh-fs', 'dsh-sandbox-policy', 'dsh-session', 'dsh-skill', 'dsh-host-webserver',
].map(name => prefix + name));

const stages = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function fingerprint(files) {
  return sha(JSON.stringify([...files].sort(([a], [b]) => compare(a, b))
    .map(([name, bytes]) => [name, sha(bytes)])));
}

function plainPath(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Staging must not contain symlink/junction ancestors');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync(target);
}

/**
 * Allocate an exclusive, disposable staging capability. Extract ONE reviewed
 * archive to stage.root/package, without running package scripts. Arbitrary
 * user-supplied paths/markers cannot authorize an installed tree. The caller
 * owns cleanup; do not share this directory with installers or other writers.
 */
export function createMigrationStaging() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-migration-'));
  const realRoot = plainPath(root);
  const stage = Object.freeze({ root: realRoot });
  stages.set(stage, { root: realRoot, stat: fs.statSync(realRoot), applied: undefined });
  return stage;
}

function assertStage(packageDirectory, stage) {
  const state = stages.get(stage);
  if (!state) throw new Error('A fresh createMigrationStaging capability is required');
  const expected = path.join(state.root, 'package');
  if (path.resolve(packageDirectory) !== expected) {
    throw new Error('Only the staging root/package directory is allowed; never an installed/live tree');
  }
  const root = plainPath(state.root);
  const stat = fs.statSync(root);
  if (root !== state.root || stat.ino !== state.stat.ino || stat.dev !== state.stat.dev) {
    throw new Error('Staging root was replaced');
  }
  if (plainPath(expected) !== expected) throw new Error('Staging package path changed');
  return state;
}

function readTree(root) {
  const files = new Map();
  let total = 0;
  function visit(directory, relative = '', depth = 0) {
    if (depth > 24) throw new Error('Staging depth exceeds review bounds');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name.toLowerCase())) {
        throw new Error('Installed/live trees are forbidden in migration staging');
      }
      const absolute = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic link in staging: ${name}`);
      if (stat.isDirectory()) visit(absolute, name, depth + 1);
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Non-plain or hardlinked file: ${name}`);
        total += stat.size;
        if (files.size >= 1000 || total > 128 * 1024 * 1024) throw new Error('Staging exceeds review bounds');
        files.set(name, fs.readFileSync(absolute));
      }
    }
  }
  visit(root);
  return files;
}

const typeOwners = {
  ClientContext: ['@deepseek-ai/cordis', 'Context as ClientContext'],
  IWorkspaces: [prefix + workspaces + '/client', 'IWorkspaces'],
  SettingsScope: [prefix + 'dsh-client-ui-settings/client', 'SettingsScope'],
  SnapshotStore: [store, 'SnapshotStore'],
  SessionListState: [prefix + sessions + '/client', 'SessionListState'],
  ChatSnapshot: [prefix + 'dsh-client-ui-chat/client', 'ChatSnapshot'],
};

// Exact reviewed bytes are checked BEFORE these bounded textual substitutions.
// No regex-based discovery is used to approve unknown source/API variants.
function migrateTypes(text, providers, changes, file) {
  return text.replace(
    /import (type )?\{([^}]+)\} from (['"])@deepseek-ai\/dsh-client-runtime\/client\3;?/g,
    (statement, allType, members) => {
      const imports = members.split(',').map(member => {
        const token = member.trim();
        if (!allType && !token.startsWith('type ')) throw new Error(`Unknown runtime value import in ${file}`);
        const symbol = token.replace(/^type /, '');
        const mapped = typeOwners[symbol];
        if (!mapped) throw new Error(`Unknown runtime type ${symbol} in ${file}`);
        return { symbol, module: mapped[0], binding: mapped[1] };
      });
      const lines = imports.map(item => `import type { ${item.binding} } from '${item.module}';`);
      // Context's services are supplied by declaration merging in the new owners.
      if (imports.some(item => item.symbol === 'ClientContext')) {
        lines.push(...providers.map(owner => `import type {} from '${prefix}${owner}/client';`));
      }
      changes.push({ file, kind: 'type-import', symbols: imports.map(item => item.symbol),
        to: imports.map(item => item.module) });
      return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
    });
}

// The reviewed WebUI bundle keeps its markdown parser and math nodes, but the
// public extraction replaces the browser KaTeX module with a throwing stub.
// KaTeX is still a declared runtime dependency, so restore the same lazy
// renderer fallback used by the upstream markstream worker path.
export function migrateWebuiKatexFallback(text) {
  // The public WebUI bundle has its KaTeX runtime stripped. The staging patch
  // inlines the audited KaTeX distribution into these two lazy initializers;
  // keep the renderer independent from native ESM and the host module table.
  const newLoader = 'return er = await Promise.resolve().then(() => (init_katex_stub(), init__webui_katex_mhchem_stub(), katex_stub_exports)), er;';
  const previousLoader = 'return er = await import("katex"), await import("katex/contrib/mhchem"), er;';
  const previousRequireLoader = 'return er = await Promise.resolve().then(() => { const runtime = require("katex"); require("katex/contrib/mhchem"); return runtime?.default ?? runtime; }), er;';
  if (text.includes(newLoader) && !text.includes('katex disabled in webui')) {
    return migrateWebuiMathDelimiters(text);
  }
  if (text.includes(previousLoader) && !text.includes('katex disabled in webui')) {
    return migrateWebuiMathDelimiters(text.replace(previousLoader, newLoader));
  }
  if (text.includes(previousRequireLoader) && !text.includes('katex disabled in webui')) {
    return migrateWebuiMathDelimiters(text.replace(previousRequireLoader, newLoader));
  }
  const marker = '//#region src/client/markdown/katex-stub.ts';
  const start = text.indexOf(marker);
  const end = text.indexOf('//#endregion', start);
  if (start < 0 || end < start || text.indexOf(marker, start + marker.length) >= 0) {
    throw new Error('Unknown reviewed WebUI KaTeX stub region');
  }
  const regionEnd = end + '//#endregion'.length;
  const original = text.slice(start, regionEnd);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const replacement = [
    marker,
    'var katex_stub_exports = /* @__PURE__ */ __exportAll({});',
    'var init_katex_stub = __esmMin((() => {}));',
    '//#endregion',
  ].join('\n');
  let output = text.slice(0, start) + replacement.replaceAll('\n', newline) + text.slice(regionEnd);
  const oldLoader = 'return er = await Promise.resolve().then(() => (init_katex_stub(), katex_stub_exports)), await Promise.resolve().then(() => (init__webui_katex_mhchem_stub(), _webui_katex_mhchem_stub_exports)), er;';
  if (output.split(oldLoader).length !== 2) {
    throw new Error('Unknown reviewed WebUI KaTeX loader');
  }
  output = output.replace(oldLoader, newLoader);
  return migrateWebuiMathDelimiters(output);
}

export function migrateWebuiMathDelimiters(text) {
  const idempotenceMarker = 'const mathFence = (state, startLine, endLine, silent) => {';
  if (text.includes(idempotenceMarker)) return text;
  const anchor = 'const explicitMathBlockBeforeSetext = (state, startLine, endLine, silent) => {';
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex < 0 || text.indexOf(anchor, anchorIndex + anchor.length) >= 0) {
    throw new Error('Unknown reviewed WebUI math block boundary');
  }
  const injected = `const mathFence = (state, startLine, endLine, silent) => {
				const s = state;
				const startPos = s.bMarks[startLine] + s.tShift[startLine];
				const lineText = s.src.slice(startPos, s.eMarks[startLine]).trim();
				const opener = lineText.match(/^(?:\\x60{3,}|~{3,})\\s*(?:math|latex|tex)(?:\\s+.*)?$/i);
				if (!opener) return false;
				const marker = opener[1][0];
				const markerLength = opener[1].length;
				let nextLine = startLine + 1;
				let content = '';
				let found = false;
				for (; nextLine < endLine; nextLine++) {
					const lineStart = s.bMarks[nextLine] + s.tShift[nextLine];
					const current = s.src.slice(lineStart, s.eMarks[nextLine]);
					if (new RegExp('^\\\\s*' + marker + '{' + markerLength + ',}\\\\s*$').test(current)) {
						found = true;
						break;
					}
					content += (content ? '\\n' : '') + current;
				}
				if (!found) return false;
				if (silent) return true;
				const token = s.push('math_block', 'math', 0);
				token.content = normalizeStandaloneBackslashT(content);
				token.markup = 'fence';
				token.raw = s.src.slice(startPos, s.eMarks[nextLine] || s.eMarks[startLine]);
				token.map = [startLine, nextLine + 1];
				token.block = true;
				token.loading = false;
				s.line = nextLine + 1;
				return true;
			};
			const mathEnvironmentBlock = (state, startLine, endLine, silent) => {
				const s = state;
				const startPos = s.bMarks[startLine] + s.tShift[startLine];
				const firstLine = s.src.slice(startPos, s.eMarks[startLine]);
				const opener = firstLine.match(/^\\\\begin\\{([^{}\\n]+)\\}/);
				if (!opener) return false;
				const environment = opener[1];
				const closeRe = new RegExp('^\\\\s*\\\\end\\\\{' + environment.replace(/[.*+?^()|[\\]\\\\]/g, '\\\\$&') + '\\\\}\\\\s*$');
				let nextLine = startLine;
				let content = '';
				let found = false;
				for (; nextLine < endLine; nextLine++) {
					const lineStart = s.bMarks[nextLine] + s.tShift[nextLine];
					const current = s.src.slice(lineStart, s.eMarks[nextLine]);
					if (nextLine > startLine && closeRe.test(current)) {
						found = true;
						break;
					}
					content += (content ? '\\n' : '') + current;
				}
				if (!found) return false;
				if (silent) return true;
				const token = s.push('math_block', 'math', 0);
				token.content = normalizeStandaloneBackslashT(content);
				token.markup = 'environment';
				token.raw = s.src.slice(startPos, s.eMarks[nextLine]);
				token.map = [startLine, nextLine + 1];
				token.block = true;
				token.loading = false;
				s.line = nextLine + 1;
				return true;
			};
			`;
  const next = text.slice(0, anchorIndex) + injected.replaceAll('\n', text.includes('\r\n') ? '\r\n' : '\n') + text.slice(anchorIndex);
  const registration = 'md.inline.ruler.before("escape", "math", mathInline);';
  const registrationIndex = next.indexOf(registration);
  if (registrationIndex < 0 || next.indexOf(registration, registrationIndex + registration.length) >= 0) {
    throw new Error('Unknown reviewed WebUI math plugin registration');
  }
  return next.replace(registration,
    `${registration}\n\t\t\tmd.block.ruler.before("fence", "math_fence", mathFence);\n\t\t\tmd.block.ruler.before("paragraph", "math_environment", mathEnvironmentBlock);`);
}

/**
 * Plan, or apply with { write: true }, interface-only changes to a reviewed
 * extraction. Unknown identities/content throw before writes. Known unresolved
 * interfaces return status "blocked", with proposedFiles but NO writes, even
 * when write is requested. Never deploy a blocked plan.
 *
 * Repeated calls on the same capability are idempotent. Reopening modified
 * packages with a new capability is intentionally rejected: re-extract originals.
 * A successful result covers these interface mappings, not end-to-end UI/API
 * compatibility. No plugin code, install hook, or private profile is executed/read.
 */
export function transformPluginInterfaces(packageDirectory, { stage, write = false, useUiCompat = false } = {}) {
  if (useUiCompat) {
    const compat = fileURLToPath(new URL('../assets/plugins/dsh-aio-ui-compat/', import.meta.url));
    const metadata = JSON.parse(fs.readFileSync(path.join(compat, 'PROVENANCE.json'), 'utf8'));
    if (metadata.commit !== 'c389f96bf3a9b6807cb71ed6bdad5849be0df6d8' ||
        metadata.session.version !== officialVersion ||
        sha(fs.readFileSync(path.join(compat, 'lib/client.js'))) !== metadata.clientSha256) {
      throw new Error('UI compatibility artifact is not the qualified build');
    }
  }
  const state = assertStage(packageDirectory, stage);
  const files = readTree(packageDirectory);
  const digest = fingerprint(files);
  if (state.applied?.digest === digest) {
    return { ...structuredClone(state.applied.report), status: 'unchanged', written: [],
      changes: [], proposedFiles: {} };
  }
  const manifestBytes = files.get('package.json');
  if (!manifestBytes) throw new Error('Missing package.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const spec = reviewed.find(([name, version]) => name === manifest.name && version === manifest.version);
  if (!spec) throw new Error('Unknown package identity/version; review required');
  if (digest !== spec[3]) throw new Error('Unreviewed package content/API usage; refusing all writes');

  const changes = [];
  const unresolved = [];
  const next = new Map(files);
  const providers = spec[4];
  const custom = manifest.name === '@ha-na-bi/dsh-client-ui-custom';
  const webui = manifest.name === '@dsh-external/dsh-webui';
  if ((custom || webui) && !useUiCompat) {
    unresolved.push({
      file: 'lib/client.js', symbol: 'ImageGallery',
      module: prefix + 'dsh-client-ui-attachment',
      reason: 'c389f96 exports only plugin apply/inject, not ImageGallery. Preserve the gallery; a source-level slot migration/rebuild is required.',
    }, {
      file: 'lib/client.js', symbol: 'MessageText',
      module: prefix + 'dsh-client-ui-primitives',
      reason: 'MessageText is no longer exported. MarkdownText is not an established equivalent contract; preserve existing rendering pending source-level review.',
    });
  }
  if (webui && !useUiCompat) {
    unresolved.push({
      file: 'lib/client.js', symbols: ['isAppendSurfaceEvent', 'isReplacementSurfaceEvent'],
      module: runtime + '/client', owner: prefix + 'dsh-session/surface',
      reason: 'Equivalent pure exports exist, but are not in the browser seed. Rebuild with these functions inlined; a require-ID swap would fail.',
    });
  }
  for (const [file, bytes] of files) {
    if (!/\.(?:[cm]?js|tsx?)$/.test(file)) continue;
    let text = bytes.toString('utf8');
    if (custom || webui) {
      let needsSettingsAdapter = false;
      let needsNamespaceAdapter = false;
      text = text.replace(/import\s*\{([^}]+)\}\s*from\s*(['"])@deepseek-ai\/dsh-settings\2;?/g,
        (original, members, quote) => {
          const names = members.split(',').map(value => value.trim());
          if (!names.includes('settingsNamespace') && !names.includes('installSettingsSection')) return original;
          needsSettingsAdapter ||= names.includes('installSettingsSection');
          needsNamespaceAdapter ||= names.includes('settingsNamespace');
          const migrated = names.filter(name => !['installSettingsSection', 'settingsNamespace'].includes(name));
          changes.push({ file, kind: 'settings-service-api' });
          return migrated.length ? `import { ${migrated.join(', ')} } from ${quote}@deepseek-ai/dsh-settings${quote};` : '';
        });
      if (needsNamespaceAdapter) {
        text += '\nfunction settingsNamespace(value) {\n'
          + '  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new TypeError("Invalid settings namespace");\n'
          + '  return value;\n}\n';
      }
      if (needsSettingsAdapter) {
        text += '\nfunction installSettingsSection(ctx, ns, schema, entry, hooks) {\n'
          + '  ctx.inject(["settings"], (scope) => scope.settings.installSection(ctx, ns, schema, entry, hooks));\n'
          + '}\n';
      }
    }
    if (webui && /(?:^|\/)task-done-sound\.(?:js|ts)$/.test(file)) {
      const authorFallback = String.raw`['C:\\Users\\Anti\\.hanako\\plugins\\voice-announcer\\assets\\task-done.wav']`;
      if (text.includes(authorFallback)) {
        text = text.replaceAll(authorFallback, '[]');
        changes.push({ file, kind: 'remove-author-machine-fallback' });
      }
    }
    if (file === 'lib/client.js' && custom) {
      text = text.replace(`require("${runtime}/client")`, `require("${store}")`);
      changes.push({ file, kind: 'module-id', symbols: ['createSnapshotStore'], from: runtime + '/client', to: store });
    }
    // Split only the equivalent member; the unresolved old namespace stays
    // visible and blocks writes until the surface predicates can be rebuilt.
    if (file === 'lib/client.js' && webui) {
      text = migrateProviderSettingsClient(text);
      text = migrateWebuiChatRenderers(text);
      text = migrateWebuiPromptOptimize(text);
      text = migrateWebuiNativeModelSelection(text);
      text = migrateWebuiContinue(text);
      text = migrateWebuiInputChatToolShapes(text);
      text = migrateWebuiKatexFallback(text);
      changes.push({ file, kind: 'slot-props', from: 'session chat/input snapshots',
        to: 'useChat/useInput' });
      changes.push({ file, kind: 'provider-settings-api', from: 'connection.api',
        to: 'remote.llm/settings/credentials' });
      text = text.replaceAll('.conversationEvents', '.uiConversation.events')
        .replaceAll('"conversationEvents"', '"uiConversation"');
      changes.push({ file, kind: 'service-owner', from: 'conversationEvents', to: 'uiConversation.events' });
      const declaration = `let _deepseek_ai_dsh_client_runtime_client = require("${runtime}/client");`;
      text = text.replace(declaration, `${declaration}\r\n\t\tlet _dsh_migration_store = require("${store}");`)
        .replaceAll('_deepseek_ai_dsh_client_runtime_client.createSnapshotStore',
          '_dsh_migration_store.createSnapshotStore');
      changes.push({ file, kind: 'split-module', symbols: ['createSnapshotStore'],
        from: runtime + '/client', to: store });
    }
    if (file === 'lib/client.js' && (custom || webui) && useUiCompat) {
      const anchor = 'var module = { exports: {} };';
      if (text.split(anchor).length !== 2) throw new Error('Unknown client module wrapper');
      text = text.replace(anchor, `${anchor}\n\t\tconst _dsh_aio_ui_compat = require("dsh-aio-ui-compat");`)
        .replaceAll('_deepseek_ai_dsh_client_ui_attachment.ImageGallery', '_dsh_aio_ui_compat.ImageGallery')
        .replaceAll('_deepseek_ai_dsh_client_ui_primitives.MessageText', '_dsh_aio_ui_compat.MessageText');
      if (webui) {
        text = text.replace(`let _deepseek_ai_dsh_client_runtime_client = require("${runtime}/client");`, '')
          .replaceAll('_deepseek_ai_dsh_client_runtime_client.isAppendSurfaceEvent',
            '_dsh_aio_ui_compat.isAppendSurfaceEvent')
          .replaceAll('_deepseek_ai_dsh_client_runtime_client.isReplacementSurfaceEvent',
            '_dsh_aio_ui_compat.isReplacementSurfaceEvent');
        if (text.includes('_deepseek_ai_dsh_client_runtime_client.')) throw new Error('Unmapped runtime member');
      }
      changes.push({ file, kind: 'compatibility-module', to: 'dsh-aio-ui-compat' });
    }
    if (/\.tsx?$/.test(file)) text = migrateTypes(text, providers, changes, file);
    for (const removed of [runtime, prefix + 'dsh-client-web-react']) {
      if (text.includes(removed) && !(webui && file === 'lib/client.js' && removed === runtime)) {
        unresolved.push({ file, module: removed,
          reason: 'Unmapped legacy reference retained; further interface review is required.' });
      }
    }
    if (text !== bytes.toString('utf8')) next.set(file, Buffer.from(text));
  }

  const beforeInject = manifest.dsh?.client?.inject;
  if (beforeInject?.includes(runtime)) {
    manifest.dsh.client.inject = [...new Set(beforeInject.flatMap(id =>
      id === runtime ? providers.map(owner => prefix + owner)
        : webui && id === prefix + 'dsh-client-schema-form' ? []
        : id === prefix + 'dsh-client-ui-locale' ? [prefix + locale] : [id]))];
    changes.push({ file: 'package.json', kind: 'providers', from: beforeInject,
      to: manifest.dsh.client.inject });
  }
  const peers = manifest.peerDependencies ?? {};
  if (webui && Object.hasOwn(peers, 'cordis')) {
    const importsCordis = [...files].some(([file, bytes]) =>
      /\.[cm]?js$/.test(file) && /(?:require\(|from\s+)["']cordis["']/.test(bytes.toString('utf8')));
    if (importsCordis) throw new Error('Unmapped unscoped Cordis import');
    delete peers.cordis;
    changes.push({ file: 'package.json', kind: 'remove-unused-peer', from: 'cordis' });
  }
  if ((custom || webui) && useUiCompat) {
    manifest.dsh.client.inject = [...new Set([...(manifest.dsh.client.inject || []), 'dsh-aio-ui-compat'])];
    peers['dsh-aio-ui-compat'] = '1.0.0';
    changes.push({ file: 'package.json', kind: 'compatibility-provider', to: 'dsh-aio-ui-compat' });
  }
  // The reviewed webui bundle contains schema-form's implementation inline.
  // Its only module-ID occurrences are source-region/doc comments, not loads;
  // there is no schema-form service in its exported inject list either.
  if (webui && Object.hasOwn(peers, prefix + 'dsh-client-schema-form')) {
    delete peers[prefix + 'dsh-client-schema-form'];
    if (manifest.peerDependenciesMeta) delete manifest.peerDependenciesMeta[prefix + 'dsh-client-schema-form'];
    changes.push({ file: 'package.json', kind: 'remove-unused-peer',
      from: prefix + 'dsh-client-schema-form', reason: 'Implementation already inlined; no runtime import or service usage.' });
  }
  for (const removed of [runtime, prefix + 'dsh-client-web-react']) {
    if (!Object.hasOwn(peers, removed)) continue;
    const used = [...next].some(([file, bytes]) =>
      /\.(?:[cm]?js|tsx?)$/.test(file) && bytes.toString('utf8').includes(removed));
    if (!used) {
      delete peers[removed];
      if (manifest.peerDependenciesMeta) delete manifest.peerDependenciesMeta[removed];
      changes.push({ file: 'package.json', kind: 'remove-unused-peer', from: removed });
    }
  }
  if (Object.hasOwn(peers, prefix + 'dsh-client-ui-locale')) {
    delete peers[prefix + 'dsh-client-ui-locale'];
    peers[prefix + locale] = officialVersion;
    if (manifest.peerDependenciesMeta?.[prefix + 'dsh-client-ui-locale']) {
      manifest.peerDependenciesMeta[prefix + locale] = manifest.peerDependenciesMeta[prefix + 'dsh-client-ui-locale'];
      delete manifest.peerDependenciesMeta[prefix + 'dsh-client-ui-locale'];
    }
    changes.push({ file: 'package.json', kind: 'peer-owner', from: prefix + 'dsh-client-ui-locale', to: prefix + locale });
  }
  const requiredPeers = providers.map(owner => prefix + owner);
  if (custom || webui) requiredPeers.push(store);
  if (custom) requiredPeers.push(prefix + 'dsh-client-ui-chat');
  for (const id of requiredPeers) peers[id] = officialVersion;
  for (const id of Object.keys(peers)) {
    if (officialPeers.has(id)) peers[id] = officialVersion;
    else if (id.startsWith(prefix + 'dsh-')) {
      unresolved.push({ file: 'package.json', module: id,
        reason: 'Obsolete or unreviewed official peer retained; cannot pin a nonexistent/unverified owner.' });
    }
  }
  if (Object.keys(peers).length) manifest.peerDependencies = peers;
  const originalPeers = JSON.parse(manifestBytes).peerDependencies ?? {};
  for (const [id, version] of Object.entries(peers)) {
    const original = originalPeers[id];
    if (original !== version) changes.push({ file: 'package.json', kind: 'pin-peer', module: id, from: original, to: version });
  }
  // Build-only dependencies and sourcemaps are intentionally not rewritten.
  // They do not authorize an obsolete installed runtime peer.
  const notes = ['Interface-only review; host RPC, slot contracts and visual behavior still require runtime testing.'];
  if (Object.keys(manifest.devDependencies ?? {}).some(id => id === runtime || id === prefix + 'dsh-client-web-react')) {
    notes.push('Historical devDependencies remain unchanged; rebuilding requires a separately reviewed build-toolchain migration.');
  }
  if (changes.some(change => change.file === 'package.json')) {
    const newline = manifestBytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
    next.set('package.json', Buffer.from(JSON.stringify(manifest, null, 2).replace(/\n/g, newline) + newline));
  }
  const proposedFiles = Object.fromEntries([...next]
    .filter(([file, bytes]) => !bytes.equals(files.get(file)))
    .map(([file, bytes]) => [file, bytes.toString('utf8')]));
  const report = { name: manifest.name, version: manifest.version, upstream: 'c389f96',
    status: unresolved.length ? 'blocked' : Object.keys(proposedFiles).length ? 'planned' : 'unchanged',
    changes, unresolved, notes, proposedFiles, written: [] };
  if (!write || unresolved.length) return report;

  // Validate the entire package again before the first mutation. Staging must
  // remain exclusive. On I/O failure restore original bytes and discard staging.
  assertStage(packageDirectory, stage);
  if (fingerprint(readTree(packageDirectory)) !== digest) throw new Error('Staging changed during planning');
  const attempted = [];
  try {
    for (const file of Object.keys(proposedFiles)) {
      attempted.push(file);
      fs.writeFileSync(path.join(packageDirectory, file), next.get(file));
    }
  } catch (error) {
    const failures = [];
    for (const file of attempted) {
      try { fs.writeFileSync(path.join(packageDirectory, file), files.get(file)); }
      catch (failure) { failures.push(failure); }
    }
    throw new AggregateError([error, ...failures], 'Migration write failed; discard staging');
  }
  report.written = attempted;
  report.status = attempted.length ? 'migrated' : 'unchanged';
  state.applied = { digest: fingerprint(next), report: structuredClone(report) };
  return report;
}
