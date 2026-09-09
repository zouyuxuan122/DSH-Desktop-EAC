import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installWebuiUsageHost } from './webui-usage-host-compat.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repo, 'package.json'));
const yaml = require('js-yaml');

const profile = path.resolve(process.argv[2] || '');
if (!profile || !fs.existsSync(path.join(profile, 'package.json'))) {
  throw new Error('staged web profile is required');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
const modules = path.join(profile, 'node_modules');
const patchFile = path.join(profile, 'cordis.patch.yml');
const patch = yaml.load(fs.readFileSync(patchFile, 'utf8')) || [];
const builtinNames = new Set(fs.readdirSync(path.join(repo, 'assets', 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name));
const dependencies = new Set(Object.keys(packageJson.dependencies || {}));
const packageDirectory = name => path.join(modules, ...name.split('/'));
const hasPackage = name => dependencies.has(name) || fs.existsSync(packageDirectory(name));

let removed = [];
const filtered = patch.flatMap(entry => {
  if (!entry || !Array.isArray(entry.insert)) return [entry];
  const insert = entry.insert.filter(item => {
    if (!item || typeof item.name !== 'string') return true;
    const shortName = item.name.startsWith('@') ? item.name.split('/')[1] : item.name;
    const known = hasPackage(item.name) || builtinNames.has(shortName);
    if (!known) removed.push(`${item.id || '(anonymous)'}:${item.name}`);
    return known;
  });
  return insert.length ? [{ ...entry, insert }] : [];
});

if (removed.length) {
  fs.writeFileSync(patchFile, yaml.dump(filtered, {
    noRefs: true,
    lineWidth: -1,
    noCompatMode: true,
  }), 'utf8');
}

const webui = path.join(modules, '@dsh-external', 'dsh-webui');
const usageHost = await installWebuiUsageHost(webui);
console.log(JSON.stringify({
  patchFile,
  removed,
  usageHost: usageHost.directory,
  usageHostChanged: usageHost.changed,
}));
