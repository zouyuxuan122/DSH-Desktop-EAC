/**
 * Local install helper: sync this dev checkout over the installed copy in
 * ~/.dsh/profiles/web/node_modules/picturereader (backup first).
 *
 * Usage:
 *   node scripts/install-local.mjs           # backup + sync changed files
 *   PICTUREREADER_INSTALL_DIR=/path node scripts/install-local.mjs
 *
 * After installing, restart DSH so the tool schemas and the settings card
 * (client.js) reload — core.js alone hot-reloads, but schema/UI do not.
 */
import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL = process.env.PICTUREREADER_INSTALL_DIR
  ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'picturereader');

if (!existsSync(INSTALL)) {
  console.error(`!! install target not found: ${INSTALL}`);
  console.error('   Set PICTUREREADER_INSTALL_DIR to the installed plugin directory.');
  process.exit(1);
}

// 1. backup the current install (keep exactly one previous generation)
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
const backup = `${INSTALL}.bak-${stamp}`;
renameSync(INSTALL, backup);
console.log(`[1/3] backed up  → ${backup}`);

// 2. restore runtime deps (they live at the old location's siblings? no — they
//    were inside the plugin folder for this bundled install) then copy sources
mkdirSync(dirname(INSTALL), { recursive: true });
cpSync(HERE, INSTALL, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(HERE.length);
    // skip dev-only noise: docs, tests artifacts, git, our own backups, deps we copy separately
    return !rel.startsWith('/docs') && !rel.startsWith('/.git') && !rel.includes('fixtures-out') && !rel.startsWith('/tests');
  }
});
console.log(`[2/3] installed  → ${INSTALL}`);

// 3. ensure runtime deps exist next to the installed plugin (flat layout)
const nm = join(dirname(INSTALL), 'node_modules');
for (const pkg of ['pngjs', 'jpeg-js', 'omggif']) {
  const from = join(HERE, 'node_modules', pkg);
  const to = join(nm, pkg);
  if (existsSync(from) && !existsSync(to)) {
    cpSync(from, to, { recursive: true });
    console.log(`[3/3] dep copied → ${to}`);
  }
}
console.log('[3/3] deps ok');

console.log('');
console.log('✅ Installed. Now:');
console.log('   1) node scripts/setup-macos.mjs   # build the Vision OCR binary (once)');
console.log('   2) restart DSH                     # tool schema + settings card reload');
console.log(`   (previous version kept at ${backup})`);
