'use strict';

function createStreamWriteGuard(stream, opts = {}) {
  if (!stream || typeof stream.write !== 'function' || typeof stream.end !== 'function') {
    throw new TypeError('createStreamWriteGuard: writable stream is required');
  }

  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  let closing = false;
  let ended = false;

  const report = (err) => {
    try { onError(err); } catch {}
  };

  // Writable failures, including write-after-end, are commonly emitted
  // asynchronously and cannot be contained by a try/catch around write().
  stream.on('error', report);

  return {
    write(chunk) {
      if (closing || ended || stream.destroyed || stream.writableEnded || stream.writable === false) {
        return false;
      }
      try {
        return stream.write(chunk);
      } catch (err) {
        report(err);
        return false;
      }
    },

    end() {
      if (closing || ended) return false;
      closing = true;
      if (stream.destroyed || stream.writableEnded) {
        ended = true;
        return false;
      }
      try {
        stream.end(() => { ended = true; });
        return true;
      } catch (err) {
        ended = true;
        report(err);
        return false;
      }
    },

    get closing() { return closing; },
    get ended() { return ended || stream.writableEnded || stream.destroyed; },
  };
}

module.exports = { createStreamWriteGuard };
