/**
 * 工具调用埋点：给每个工具包一层计时 + 计数日志。
 *
 * 隐私红线：只记录工具名、耗时、成功/失败、错误码和**少量计数字段**（files/modules/edges/cycles/bytes/written…），
 * 绝不记录参数值、文件内容或输出正文。
 */
import type { ToolDefinition, ToolExecutionContext } from '@deepseek-ai/dsh-tools'
import type { Logger } from '../util/logger.js'

const COUNT_FIELDS: readonly string[] = [
  'files',
  'directories',
  'bytes',
  'modules',
  'edges',
  'cycles',
  'bytesRead',
  'written',
  'findings',
  'createdTasks',
  'tasks',
  'executions',
  'size',
]

/** 只抽取白名单里的数字/布尔/长度，避免把业务内容写进日志。 */
export function summarizeOutput(value: unknown): Record<string, number | boolean> {
  const summary: Record<string, number | boolean> = {}
  if (typeof value !== 'object' || value === null) return summary
  const record = value as Record<string, unknown>
  const stats = (record.stats ?? {}) as Record<string, unknown>
  for (const field of COUNT_FIELDS) {
    for (const source of [record, stats]) {
      const raw = source[field]
      if (typeof raw === 'number' && Number.isFinite(raw)) summary[field] = raw
      else if (typeof raw === 'boolean') summary[field] = raw
      else if (Array.isArray(raw)) summary[field + 'Count'] = raw.length
    }
  }
  return summary
}

export function instrumentTools<A, R>(
  tools: readonly ToolDefinition<A, R>[],
  logger: Logger,
): ToolDefinition<A, R>[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(args: A, exec: ToolExecutionContext) {
      const started = Date.now()
      try {
        const value = await tool.execute(args, exec)
        logger.info('tool/' + tool.name, '调用成功', { durationMs: Date.now() - started, ...summarizeOutput(value) })
        return value
      } catch (error) {
        const code =
          typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'UNKNOWN'
        logger.warn('tool/' + tool.name, '调用失败', { durationMs: Date.now() - started, errorCode: code })
        throw error
      }
    },
  }))
}
