'use strict';
// ---------------------------------------------------------------------------
// zstd 帧扫描器（scripts/analyze-session-log.ts 与 scripts/repair-session-log.ts
// 的共享提取，原两份重复实现合一）。
//
// dsh 会话日志（session.jsonl.zstd）是「zstd 帧拼接」格式：每帧一条独立压缩
// 的 NDJSON 段。本模块只做字节级帧边界扫描（不解压），供诊断/修复工具复用，
// 逻辑镜像 dsh 自带 reader 的帧切分规则。
// ---------------------------------------------------------------------------

/** 一个完整 zstd 帧在缓冲区内的字节区间（end 为独占下界）。 */
export interface ZstdFrame {
  start: number;
  end: number;
}

/** 扫描结果：完整帧列表 + 首个「撕裂/无法识别」位置（无则为 undefined）。 */
export interface ZstdScanResult {
  frames: ZstdFrame[];
  tornStart?: number;
}

/** zstd 魔数（小端 UINT32: 0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216;

/**
 * 顺序扫描拼接 zstd 帧：按帧头描述符（字典位/内容长度的/单段标志/校验和）
 * 与块头（last-block / block-type / block-size）推进偏移。任何无法解析的
 * 位置立即返回 —— tornStart 即撕裂尾部的起点（半截帧或非 zstd 字节）。
 */
export function scanZstdFrames(buffer: Buffer): ZstdScanResult {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    // 预留位非零 = 未定义格式（帧头描述符 bit3/4），保守判撕裂
    if ((descriptor & 24) !== 0) return { frames, tornStart: start };
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    // 块序列：3 字节小端块头（bit0=last、bit1-2=type、bit3+=size）
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, tornStart: start }; // reserved 块类型
      const payloadBytes = blockType === 1 ? 1 : blockSize; // RLE 块载荷恒 1 字节
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}
