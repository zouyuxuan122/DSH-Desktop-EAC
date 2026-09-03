import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] || process.cwd());
const seedRoot = process.env.DSH_PROFILE_SEED_DIR
  ? path.resolve(process.env.DSH_PROFILE_SEED_DIR)
  : path.join(root, 'distribution', 'profile-seed');
const settingsFile = path.join(seedRoot, 'settings.yaml');
const require = createRequire(path.join(root, 'package.json'));
const yaml = require('js-yaml');

const settingsSource = fs.readFileSync(settingsFile, 'utf8');
const input = yaml.load(settingsSource) || {};
const output = {};
for (const key of ['status-rotator', 'webui-modules']) {
  if (!Object.hasOwn(input, key)) throw new Error(`missing public section: ${key}`);
  output[key] = input[key];
}
const eol = settingsSource.includes('\r\n') ? '\r\n' : '\n';
const sanitizedSettings = yaml.dump(output, { noRefs: true, lineWidth: -1, noCompatMode: true }).replaceAll('\n', eol);
if (sanitizedSettings !== settingsSource) fs.writeFileSync(settingsFile, sanitizedSettings, 'utf8');

const forbiddenState = ['.modules.yaml', '.pnpm-workspace-state-v1.json', path.join('.pnpm', 'lock.yaml')];
const profileNodeModules = path.join(seedRoot, 'profiles', 'web-desktop', 'node_modules');
for (const rel of forbiddenState) fs.rmSync(path.join(profileNodeModules, rel), { force: true });

const markers = [/H:[\\/]CODEX/i, /C:[\\/]Users[\\/]32621/i, /\.dsh-v4lite/i, /pnpm[\\/]store/i];
const findings = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile() && /\.(?:ya?ml|json|txt|md|[cm]?js)$/i.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const marker of markers) if (marker.test(text)) findings.push(`${path.relative(seedRoot, file)}: ${marker}`);
    }
  }
}
scan(seedRoot);
if (findings.length) throw new Error(`machine-local seed paths found:\n${findings.slice(0, 20).join('\n')}`);
console.log(`AIO seed privacy scan passed: ${seedRoot}`);
