/**
 * lib/logger/index.ts — 结构化日志器汇总出口（Task 6.2）。
 *
 * 门面契约：与原 logger.js 的 module.exports 逐项一致 ——
 *   - 全部 loggerAPI 方法作为具名导出（`import * as logger from '../logger.js'`
 *     与 `require('./logger')` 两种消费形态零改动）；
 *   - _testExports 附着在导出面上（脱敏引擎/轮转流的测试钩子）；
 *   - _internalState 以函数形式导出（原为属性，函数形态利于 tree-shake
 *     与只读语义；loggerAPI._internalState 保留原属性访问路径）。
 */

import { loggerAPI } from './api.js';
import type { ActionTrace, DiagnosticsZipOpts, LoggerAPI, LoggerInitOpts, LoggerShell, LoggerState } from './api.js';

export const trace = loggerAPI.trace;
export const debug = loggerAPI.debug;
export const info = loggerAPI.info;
export const warn = loggerAPI.warn;
export const error = loggerAPI.error;
export const fatal = loggerAPI.fatal;
export const getBootTraceId = loggerAPI.getBootTraceId;
export const makeActionTrace = loggerAPI.makeActionTrace;
export const child = loggerAPI.child;
export const tag = loggerAPI.tag;
export const withTrace = loggerAPI.withTrace;
export const logCompat = loggerAPI.logCompat;
export const wrapChild = loggerAPI.wrapChild;
export const init = loggerAPI.init;
export const flush = loggerAPI.flush;
export const close = loggerAPI.close;
export const buildDiagnosticsZip = loggerAPI.buildDiagnosticsZip;
export const _internalState = loggerAPI._internalState;
export { loggerAPI } from './api.js';
export type { ActionTrace, DiagnosticsZipOpts, LoggerAPI, LoggerInitOpts, LoggerShell, LoggerState } from './api.js';

// --- 脱敏引擎与轮转流（redact.ts / rotate.ts 直接再导出）---------------------
export {
  RedactTransform,
  _deepRedactInternal,
  _maskPrefixesInString,
  _valueMasked,
  deepRedact,
  isBlackKey,
  normalizeKey,
  PII_KEYS_BLACKLIST,
  PII_PREFIXES_RULES,
  PII_VALUE_PATTERNS,
} from './redact.js';
export type { PrefixRule, RedactOpts, ValuePattern } from './redact.js';
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, RotateWriteStream, _idxName } from './rotate.js';
export type { RotateOpts } from './rotate.js';

/** 测试钩子（与原 module.exports._testExports 逐项一致 + maskStringByPrefix 兼容别名）。 */
import {
  RedactTransform as RT,
  _deepRedactInternal as deepInternal,
  _maskPrefixesInString as maskPrefixes,
  _valueMasked as valueMasked,
  deepRedact as deep,
  isBlackKey as isBlack,
  normalizeKey as normalize,
  PII_KEYS_BLACKLIST as KEYS,
  PII_PREFIXES_RULES as PREFIXES,
  PII_VALUE_PATTERNS as PATTERNS,
} from './redact.js';
import {
  DEFAULT_MAX_BYTES as MAX_BYTES,
  DEFAULT_MAX_FILES as MAX_FILES,
  RotateWriteStream as RWS,
  _idxName as idxName,
} from './rotate.js';

export const _testExports = {
  PII_KEYS_BLACKLIST: KEYS,
  PII_PREFIXES_RULES: PREFIXES,
  PII_VALUE_PATTERNS: PATTERNS,
  normalizeKey: normalize,
  isBlackKey: isBlack,
  maskStringByPrefix: maskPrefixes, // 向后兼容别名
  _maskPrefixesInString: maskPrefixes,
  _valueMasked: valueMasked,
  deepRedact: deep,
  _deepRedactInternal: deepInternal,
  RedactTransform: RT,
  RotateWriteStream: RWS,
  DEFAULT_MAX_BYTES: MAX_BYTES,
  DEFAULT_MAX_FILES: MAX_FILES,
  _idxName: idxName,
};
