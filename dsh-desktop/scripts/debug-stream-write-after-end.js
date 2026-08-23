'use strict';

const { once } = require('node:events');
const { Writable } = require('node:stream');
const { createStreamWriteGuard } = require('../stream-write-guard');

function sink() {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

async function reproduceUnsafeWrite() {
  const stream = sink();
  stream.end();
  const errorPromise = once(stream, 'error');
  stream.write('late child output');
  const [err] = await errorPromise;
  return err;
}

async function verifyGuardedWrite() {
  const stream = sink();
  const errors = [];
  const guard = createStreamWriteGuard(stream, { onError: (err) => errors.push(err) });
  guard.end();
  const accepted = guard.write('late child output');
  await once(stream, 'finish');
  return { accepted, errors };
}

(async () => {
  const unsafeError = await reproduceUnsafeWrite();
  console.log(`[repro] unprotected: ${unsafeError.code} (${unsafeError.message})`);

  const guarded = await verifyGuardedWrite();
  if (guarded.accepted || guarded.errors.length > 0) {
    throw new Error('guarded stream accepted a late write or emitted an error');
  }
  console.log('[repro] guarded: late write rejected without stream error');
})().catch((err) => {
  console.error('[repro] FAIL', err);
  process.exitCode = 1;
});
