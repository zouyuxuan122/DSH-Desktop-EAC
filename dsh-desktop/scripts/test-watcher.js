'use strict';
// Unit test: real-data vocabulary + live completion detection (both modes).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { SessionWatcher } = require('../session-watcher');

function makeScenario(name, mkExtraFrame) {
  const tmpDir = path.join(os.tmpdir(), 'dsh-watch-' + name);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, '--proj--', 'session-' + name), { recursive: true });
  const file = path.join(tmpDir, '--proj--', 'session-' + name, 'session.jsonl.zstd');
  const frame = (records) => zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  const header = { type: 'session', version: 0, id: 'session-' + name, createdAt: 1, cwd: 'C:\\proj', delegationDepth: 0 };
  fs.writeFileSync(file, Buffer.concat([frame([header])]));
  return { tmpDir, file, frame };
}

(async () => {
  // Scenario A: current-format session (turn events) — only turn/end notifies.
  {
    const { tmpDir, file, frame } = makeScenario('turnmode');
    const seen = [];
    const w = new SessionWatcher({ sessionsDir: tmpDir, onTurnEnd: (i) => seen.push(i), log: console.log });
    fs.appendFileSync(file, frame([{ type: 'turn/start', seq: 0 }, { type: 'assistant/message', seq: 1 }, { type: 'turn/end', seq: 2 }, { type: 'session/title', seq: 3, data: { title: '标题A' } }]));
    w.scan(); // baseline
    console.log('A baseline seen:', seen.length);
    fs.appendFileSync(file, frame([{ type: 'turn/start', seq: 4 }, { type: 'assistant/message', seq: 5 }, { type: 'assistant/message', seq: 6 }, { type: 'turn/end', seq: 7 }]));
    w.scan();
    console.log('A after:', JSON.stringify(seen));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // Scenario B: legacy session (no turn events) — assistant/message notifies.
  {
    const { tmpDir, file, frame } = makeScenario('legacymode');
    const seen = [];
    const w = new SessionWatcher({ sessionsDir: tmpDir, onTurnEnd: (i) => seen.push(i), log: console.log });
    fs.appendFileSync(file, frame([{ type: 'assistant/message', seq: 0 }]));
    w.scan();
    console.log('B baseline seen:', seen.length);
    fs.appendFileSync(file, frame([{ type: 'assistant/message', seq: 1 }]));
    w.scan();
    console.log('B after:', JSON.stringify(seen));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
