import Schema from '@deepseek-ai/schemastery'
import * as CompactCommand from '@deepseek-ai/dsh-command-compact'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import DshCompactEngine from './engine.js'

export const name = 'dsh-compact-agent'
export const Config = Schema.object({
  thresholdChars: Schema.number().step(1).min(1).default(8192)
    .description('工具结果超过此字符数时进行头尾裁剪'),
  headChars: Schema.number().step(1).min(0).default(4096)
    .description('工具结果裁剪后保留的头部字符数'),
  tailChars: Schema.number().step(1).min(0).default(1024)
    .description('工具结果裁剪后保留的尾部字符数'),
}).description('dsh-compact Agent 侧复合入口')

export async function apply(ctx, config = {}) {
  const pruner = ctx.plugin(ToolResultPruner, {
    thresholdChars: config.thresholdChars ?? 8192,
    headChars: config.headChars ?? 4096,
    tailChars: config.tailChars ?? 1024,
  })
  const engine = ctx.plugin(DshCompactEngine)
  const command = ctx.plugin(CompactCommand)
  await Promise.all([pruner.await(), engine.await(), command.await()])
}
