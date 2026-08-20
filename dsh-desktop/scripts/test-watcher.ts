'use strict';
// 单元演练：真实数据词表 + 两种模式的回合结束检测。
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { SessionWatcher, type TurnEndInfo } from '../session-watcher.js';

interface Scenario {
  tmpDir: string;
  file: string;
  frame: (records: Record<string, unknown>[]) => Buffer;
}

function makeScenario(name: string): Scenario {
  const tmpDir = path.join(os.tmpdir(), 'dsh-watch-' + name);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, '--proj--', 'session-' + name), { recursive: true });
  const file = path.join(tmpDir, '--proj--', 'session-' + name, 'session.jsonl.zstd');
  const frame = (records: Record<string, unknown>[]) =>
    zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  const header = { type: 'session', version: 0, id: 'session-' + name, createdAt: 1, cwd: 'C:\\proj', delegationDepth: 0 };
  fs.writeFileSync(file, Buffer.concat([frame([header])]));
  return { tmpDir, file, frame };
}

(async () => {
  // 场景 A：现行格式会话（turn 事件）—— 只有 turn/end 触发通知。
  {
    const { tmpDir, file, frame } = makeScenario('turnmode');
    const seen: TurnEndInfo[] = [];
    const w = new SessionWatcher({ sessionsDir: tmpDir, onTurnEnd: (i) => seen.push(i), log: console.log });
    fs.appendFileSync(file, frame([{ type: 'turn/start', seq: 0 }, { type: 'assistant/message', seq: 1 }, { type: 'turn/end', seq: 2 }, { type: 'session/title', seq: 3, data: { title: '标题A' } }]));
    w.scan(); // 基线
    console.log('A baseline seen:', seen.length);
    fs.appendFileSync(file, frame([{ type: 'turn/start', seq: 4 }, { type: 'assistant/message', seq: 5 }, { type: 'assistant/message', seq: 6 }, { type: 'turn/end', seq: 7 }]));
    w.scan();
    console.log('A after:', JSON.stringify(seen));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  // 场景 B：旧版会话（无 turn 事件）—— assistant/message 触发通知。
  {
    const { tmpDir, file, frame } = makeScenario('legacymode');
    const seen: TurnEndInfo[] = [];
    const w = new SessionWatcher({ sessionsDir: tmpDir, onTurnEnd: (i) => seen.push(i), log: console.log });
    fs.appendFileSync(file, frame([{ type: 'assistant/message', seq: 0 }]));
    w.scan();
    console.log('B baseline seen:', seen.length);
    fs.appendFileSync(file, frame([{ type: 'assistant/message', seq: 1 }]));
    w.scan();
    console.log('B after:', JSON.stringify(seen));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((e: Error) => { console.error('ERR', e.message); process.exit(1); });
