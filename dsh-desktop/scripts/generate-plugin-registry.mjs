#!/usr/bin/env node

/*
 * Generate the runtime plugin registry from the checked-in sync manifest.
 * The validation and deterministic serialization live in plugin-sync.mjs so
 * the compatibility command and this focused entry point cannot drift.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRegistry } from './plugin-sync.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '../..');

function parseArgs(argv) {
  let check = false;
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--root' || arg.startsWith('--root=')) {
      const value = arg === '--root' ? argv[++index] : arg.slice('--root='.length);
      if (!value || value.startsWith('--')) throw new Error('missing value for --root');
      root = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { check, root };
}

function relativePosix(from, to) {
  return path.relative(from, to).replaceAll('\\', '/');
}

try {
  const { check, root } = parseArgs(process.argv.slice(2));
  const result = generateRegistry(root, { check });
  console.log(`${result.checked ? 'generated registry valid' : 'generated registry written'}: ${relativePosix(root, result.file)}`);
} catch (error) {
  console.error(`generate-plugin-registry: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
