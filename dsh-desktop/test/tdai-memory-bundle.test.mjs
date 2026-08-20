import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(root, 'assets', 'plugins', 'dsh-tdai-memory');
const dependencyRoot = join(
  pluginRoot,
  'node_modules',
  '@tencentdb-agent-memory',
  'tcvdb-text',
);

test('tdai-memory bundles a loadable AI SDK runtime closure', async () => {
  const runnerEntry = join(
    pluginRoot,
    'vendor',
    'tdai',
    'adapters',
    'standalone',
    'llm-runner.js',
  );
  const runner = await import(pathToFileURL(runnerEntry).href);

  assert.equal(typeof runner.StandaloneLLMRunner, 'function');
  assert.equal(typeof runner.StandaloneLLMRunnerFactory, 'function');
});

test('tdai-memory bundles a loadable tcvdb-text runtime', async () => {
  const pkg = JSON.parse(readFileSync(join(dependencyRoot, 'package.json'), 'utf8'));
  const entry = join(dependencyRoot, pkg.main);

  assert.equal(pkg.version, '0.1.1');
  assert.ok(existsSync(entry), `missing bundled entry: ${pkg.main}`);

  const { BM25Encoder } = await import(pathToFileURL(entry).href);
  const encoder = BM25Encoder.default('zh');
  const vectors = encoder.encodeQueries(['长期记忆检索']);

  assert.equal(vectors.length, 1);
  assert.ok(vectors[0].length > 0, 'BM25 should produce a sparse vector');
});
