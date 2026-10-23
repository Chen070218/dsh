/**
 * 自证型工具：plugin_info / plugin_logs。
 *
 * 为什么需要：插件以热加载方式生效，模型看到的行为可能来自上一版构建。
 * plugin_info 直接返回版本号、构建产物 mtime、生效配置与已注册工具，
 * 把「我现在到底在跟哪一版打交道」变成可查询的事实。
 */
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LogRecord } from '../util/logger.js'
import type { LogBuffer } from '../util/log-buffer.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../version.js'

export const PLUGIN_TOOL_NAMES = {
  info: 'plugin_info',
  logs: 'plugin_logs',
} as const

export interface PluginInfoDeps {
  buffer: LogBuffer
  /** 已注册的工具名（由 apply 注入，避免依赖宿主内部 API）。 */
  registeredTools: readonly string[]
  config: Record<string, unknown>
  startedAt: string
}

/** 构建产物的 mtime 就是「这份代码是什么时候构建的」，比手写时间戳可靠。 */
function readBuildTime(): string {
  try {
    const entry = fileURLToPath(new URL('../index.js', import.meta.url))
    return new Date(statSync(entry).mtimeMs).toISOString()
  } catch {
    return 'unknown'
  }
}

/** 当前模块的 file URL —— 配合构建时间，可判断宿主到底加载的是哪一份产物。 */
function readLoadedFrom(): string {
  try {
    return import.meta.url
  } catch {
    return 'unknown'
  }
}

/** 磁盘上的构建比本次挂载更新 -> 宿主很可能仍在跑旧代码。 */
function isStale(buildTime: string, registeredAt: string): boolean {
  const built = Date.parse(buildTime)
  const mounted = Date.parse(registeredAt)
  return Number.isFinite(built) && Number.isFinite(mounted) && built > mounted + 1000
}

function renderInfo(value: {
  name: string
  version: string
  buildTime: string
  registeredAt: string
  loadedFrom: string
  staleBuild: boolean
  node: string
  platform: string
  config: Record<string, unknown>
  tools: string[]
}): string {
  const lines: string[] = []
  lines.push('## 插件状态')
  lines.push('')
  lines.push('- 名称：' + value.name)
  lines.push('- 版本：' + value.version)
  lines.push('- 加载自：' + value.loadedFrom)
  lines.push('- 构建产物时间：' + value.buildTime)
  lines.push('- 本次挂载时间：' + value.registeredAt)
  lines.push('- 加载自：' + value.loadedFrom)
  lines.push('- 运行环境：Node ' + value.node + ' / ' + value.platform)
  if (value.staleBuild) {
    lines.push('')
    lines.push('> ⚠️ 磁盘上的构建比本次挂载更新：宿主很可能仍在运行旧代码。请完全重启 DSH，或改动 cordis.patch.yml 触发该条目重新加载。')
  }
  lines.push('- 已注册工具（' + value.tools.length + '）：' + value.tools.join(', '))
  lines.push('')
  lines.push('### 生效配置（密钥类字段已脱敏）')
  lines.push('')
  for (const [key, raw] of Object.entries(value.config)) {
    const text = Array.isArray(raw) ? (raw.length === 0 ? '[]' : raw.join(', ')) : String(raw)
    lines.push('- ' + key + ' = ' + text)
  }
  return lines.join('\n')
}

function renderLogs(value: { records: LogRecord[] }): string {
  if (value.records.length === 0) return '_环形缓冲为空：本次挂载后还没有达到 logLevel 的事件（默认级别 info；调低 logLevel 或触发一次扫描后再看）_'
  const lines: string[] = ['## 最近日志（已脱敏）', '']
  for (const record of value.records) {
    const fields = Object.keys(record.fields).length > 0 ? ' ' + JSON.stringify(record.fields) : ''
    lines.push(
      '- ' +
        record.time +
        ' [' +
        record.level +
        '] ' +
        record.event +
        (record.message === '' ? '' : ' ' + record.message) +
        fields,
    )
  }
  return lines.join('\n')
}

export function createPluginInfoTools(deps: PluginInfoDeps) {
  const info = defineTool({
    name: PLUGIN_TOOL_NAMES.info,
    description:
      '返回 dsh-projectops 的版本、构建产物时间、本次挂载时间、运行环境、生效配置与已注册工具清单。' +
      '用于确认当前宿主里生效的到底是哪一版插件——升级或热加载后应先调用它自证。只读。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          version: { type: 'string', required: true },
          buildTime: { type: 'string', required: true },
          registeredAt: { type: 'string', required: true },
          loadedFrom: { type: 'string', required: true },
          staleBuild: { type: 'boolean', required: true },
          node: { type: 'string', required: true },
          platform: { type: 'string', required: true },
          tools: { type: 'array', required: true, items: { type: 'string' } },
          config: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderInfo(value as never) }],
    },
    async execute() {
      const buildTime = readBuildTime()
      return {
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        buildTime,
        registeredAt: deps.startedAt,
        loadedFrom: readLoadedFrom(),
        staleBuild: isStale(buildTime, deps.startedAt),
        node: process.version,
        platform: process.platform + '-' + process.arch,
        tools: [...deps.registeredTools],
        config: deps.config,
      }
    },
  })

  const logs = defineTool({
    name: PLUGIN_TOOL_NAMES.logs,
    description:
      '返回插件最近的运行日志（环形缓冲，最多 200 条，密钥类字段已脱敏）。插件默认不写 stderr，排查问题时用它。只读。',
    parameters: {
      limit: { type: 'integer', description: '返回多少条（默认 30，最大 200）' },
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: '只看某个级别' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'string', required: true },
                level: { type: 'string', required: true, enum: ['debug', 'info', 'warn', 'error'] },
                event: { type: 'string', required: true },
                message: { type: 'string', required: true },
                fields: { type: 'json', required: true },
              },
            },
          },
          size: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderLogs(value as never) }],
    },
    async execute(args) {
      const limit = Math.min(200, Math.max(1, args.limit ?? 30))
      const level = args.level
      let records = deps.buffer.recent(limit)
      if (level !== undefined) records = records.filter((record) => record.level === level)
      return { records, size: deps.buffer.size }
    },
  })

  return [info, logs]
}
