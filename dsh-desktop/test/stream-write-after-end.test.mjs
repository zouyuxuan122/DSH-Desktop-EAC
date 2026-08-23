import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createStreamWriteGuard } = require(join(root, 'stream-write-guard.js'));

function recordingWritable() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, chunks };
}

test('guard ignores a data chunk that arrives after end', async () => {
  const { stream, chunks } = recordingWritable();
  const errors = [];
  const guard = createStreamWriteGuard(stream, { onError: (err) => errors.push(err) });

  assert.equal(guard.write('before-close'), true);
  assert.equal(guard.end(), true);
  assert.equal(guard.write('late-data'), false);
  await once(stream, 'finish');

  assert.deepEqual(chunks, ['before-close']);
  assert.deepEqual(errors, []);
});

test('child close ordering keeps output emitted after exit and closes once', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const { stream, chunks } = recordingWritable();
  const guard = createStreamWriteGuard(stream);
  let endCalls = 0;

  child.stdout.on('data', (chunk) => guard.write(chunk));
  child.stderr.on('data', (chunk) => guard.write(chunk));
  child.once('close', () => {
    endCalls++;
    guard.end();
  });

  child.emit('exit', 1, null);
  child.stdout.emit('data', 'stdout-tail');
  child.stderr.emit('data', 'stderr-tail');
  child.emit('close', 1, null);
  child.emit('close', 1, null);
  await once(stream, 'finish');

  assert.deepEqual(chunks, ['stdout-tail', 'stderr-tail']);
  assert.equal(endCalls, 1);
  assert.equal(guard.write('too-late'), false);
});

test('unprotected Writable reproduces ERR_STREAM_WRITE_AFTER_END', async () => {
  const { stream } = recordingWritable();
  stream.end();
  const errorPromise = once(stream, 'error');
  stream.write('late-data');
  const [err] = await errorPromise;

  assert.equal(err.code, 'ERR_STREAM_WRITE_AFTER_END');
});
