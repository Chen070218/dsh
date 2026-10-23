/**
 * scan_project 工具：把扫描服务暴露给 DSH 的工具注册表。
 *
 * 安全边界：参数里的路径必须经过 WorkspaceGuard 校验；工具本身只读，不写任何文件。
 * 第二阶段增强：隐藏文件开关、额外排除项、目录汇总、扫描缓存（cached 标记）。
 */
import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createWorkspaceGuard } from '../security/workspace-guard.js'
import type { CachedScanResult, ScanCache } from '../services/scan-cache.js'
import { ErrorCode, ProjectOpsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'
import { formatBytes, truncateList } from '../util/text.js'

export const SCAN_PROJECT_TOOL_NAME = 'scan_project'

export interface ScanProjectDefaults {
  allowedRoots: readonly string[]
  maxDepth: number
  maxEntries: number
  includeHidden: boolean
  extraExcludes: readonly string[]
}

export interface ScanProjectDeps {
  defaults: ScanProjectDefaults
  cache: ScanCache
  logger: Logger
}

export interface ScanProjectOutput {
  root: string
  authorizedRoots: string[]
  detection: {
    languages: string[]
    primaryLanguage: string
    entryPoints: string[]
    configFiles: string[]
    packageManagers: string[]
  }
  stats: {
    files: number
    directories: number
    symlinks: number
    bytes: number
    skippedSensitive: number
    skippedHidden: number
    byExtension: Array<{ extension: string; count: number }>
  }
  directorySummary: Array<{ path: string; files: number; bytes: number }>
  tree: string[]
  truncated: boolean
  cached: boolean
  warnings: string[]
  durationMs: number
}

/** 输出 schema 使用 dsh-tools 受支持的 JSON Schema 子集：显式 additionalProperties + 逐属性 required。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    root: { type: 'string', required: true, description: '被扫描目录的绝对路径（已通过工作区校验）' },
    authorizedRoots: { type: 'array', required: true, items: { type: 'string' } },
    detection: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        languages: { type: 'array', required: true, items: { type: 'string' } },
        primaryLanguage: { type: 'string', required: true },
        entryPoints: { type: 'array', required: true, items: { type: 'string' } },
        configFiles: { type: 'array', required: true, items: { type: 'string' } },
        packageManagers: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
    stats: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        files: { type: 'integer', required: true },
        directories: { type: 'integer', required: true },
        symlinks: { type: 'integer', required: true },
        bytes: { type: 'integer', required: true },
        skippedSensitive: { type: 'integer', required: true },
        skippedHidden: { type: 'integer', required: true },
        byExtension: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              extension: { type: 'string', required: true },
              count: { type: 'integer', required: true },
            },
          },
        },
      },
    },
    directorySummary: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          files: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
    },
    tree: { type: 'array', required: true, items: { type: 'string' } },
    truncated: { type: 'boolean', required: true },
    cached: { type: 'boolean', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    durationMs: { type: 'integer', required: true },
  },
}

const TOOL_DESCRIPTION = [
  '扫描一个已授权工作区内的项目目录，返回目录树、文件类型统计、目录汇总，',
  '并启发式识别语言、入口文件、配置文件与包管理器。',
  '只读操作：不修改、不创建任何文件，也不读取 .env 等敏感文件的内容。',
  '参数 path 必须是当前工作区（或插件配置的 allowedRoots）之内的路径；越界会被拒绝。',
  '识别结果是启发式的，不代表确定的工程结论；cached=true 表示命中了本次会话的扫描缓存。',
].join('')

function readSessionCwd(exec: unknown): string | undefined {
  const candidate = exec as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined
  const cwd = candidate?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 配置里的根目录可能已失效（目录被删/改名）；过滤掉并保留至少一个可用根目录。 */
function collectAuthorizedRoots(configured: readonly string[], sessionCwd: string | undefined): string[] {
  const candidates = [...configured, ...(sessionCwd === undefined ? [] : [sessionCwd])]
  const usable: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim()
    if (normalized === '') continue
    if (usable.some((existing) => existing === normalized)) continue
    if (isDirectory(normalized)) usable.push(normalized)
  }
  if (usable.length > 0) return usable
  if (isDirectory(process.cwd())) return [process.cwd()]
  throw new ProjectOpsError(ErrorCode.INVALID_PATH, '没有可用的授权工作区根目录')
}

const FENCE = '```'

function renderScanReport(output: ScanProjectOutput): string {
  const lines: string[] = []
  const detection = output.detection
  lines.push('## 项目扫描结果')
  lines.push('')
  lines.push('- 项目根目录：' + output.root)
  lines.push('- 主导语言：' + (detection.primaryLanguage === '' ? '未识别' : detection.primaryLanguage))
  lines.push('- 语言分布：' + truncateList(detection.languages, 6))
  lines.push('- 入口文件：' + truncateList(detection.entryPoints, 5))
  lines.push('- 配置文件：' + truncateList(detection.configFiles, 8))
  lines.push('- 包管理器：' + truncateList(detection.packageManagers, 4))
  lines.push(
    '- 规模：' +
      output.stats.files +
      ' 个文件 / ' +
      output.stats.directories +
      ' 个目录 / ' +
      formatBytes(output.stats.bytes) +
      '（耗时 ' +
      output.durationMs +
      ' ms' +
      (output.cached ? '，命中缓存' : '') +
      '）',
  )
  if (output.stats.byExtension.length > 0) {
    lines.push('- 主要类型：' + output.stats.byExtension.map((item) => item.extension + ' × ' + item.count).join('、'))
  }
  if (output.directorySummary.length > 0) {
    lines.push(
      '- 目录分布：' +
        output.directorySummary
          .slice(0, 6)
          .map((item) => item.path + '（' + item.files + ' 文件 / ' + formatBytes(item.bytes) + '）')
          .join('、'),
    )
  }
  if (output.stats.skippedSensitive > 0) {
    lines.push('- 已跳过敏感文件：' + output.stats.skippedSensitive + ' 个（不读取、不展示）')
  }
  if (output.stats.skippedHidden > 0) {
    lines.push('- 已跳过隐藏项：' + output.stats.skippedHidden + ' 个（可用 includeHidden 打开）')
  }
  if (output.truncated) lines.push('- 注意：结果因条目上限被截断')
  lines.push('')
  if (output.tree.length > 0) {
    lines.push('### 目录树')
    lines.push('')
    lines.push(FENCE + 'text')
    for (const line of output.tree) lines.push(line)
    lines.push(FENCE)
  }
  if (output.warnings.length > 0) {
    lines.push('')
    lines.push('### 告警')
    for (const warning of output.warnings) lines.push('- ' + warning)
  }
  return lines.join('\n')
}

export function createScanProjectTool(deps: ScanProjectDeps) {
  const logger = deps.logger.child({ tool: SCAN_PROJECT_TOOL_NAME })

  return defineTool({
    name: SCAN_PROJECT_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    isConcurrencySafe: () => true,
    parameters: {
      path: {
        type: 'string',
        description: '要扫描的项目目录；相对路径按当前工作区解析。省略则扫描工作区根目录。必须在授权工作区内。',
      },
      maxDepth: { type: 'integer', description: '目录树最大深度（1-32，默认取插件配置）' },
      maxEntries: { type: 'integer', description: '最多遍历的条目数（1-200000，默认取插件配置）' },
      includeHidden: { type: 'boolean', description: '是否把点开头的隐藏文件/目录计入结果（默认取插件配置）' },
      includeTree: { type: 'boolean', description: '是否返回目录树文本（默认 true）' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderScanReport(value) }],
    },
    async execute(args, exec) {
      const sessionCwd = readSessionCwd(exec)
      const roots = collectAuthorizedRoots(deps.defaults.allowedRoots, sessionCwd)
      const guard = createWorkspaceGuard({ roots })
      const target = guard.resolve(args.path ?? '.', {
        baseDir: sessionCwd ?? guard.roots[0],
        expect: 'directory',
      })

      logger.info('tool/scan_project', '开始扫描项目', { target: target.absolutePath })
      const result: CachedScanResult = await deps.cache.scan({
        root: target.absolutePath,
        limits: {
          maxDepth: args.maxDepth ?? deps.defaults.maxDepth,
          maxEntries: args.maxEntries ?? deps.defaults.maxEntries,
        },
        filters: {
          includeHidden: args.includeHidden ?? deps.defaults.includeHidden,
          extraExcludes: deps.defaults.extraExcludes,
        },
        logger,
      })
      logger.info('tool/scan_project', '扫描完成', {
        files: result.stats.files,
        warnings: result.warnings.length,
        truncated: result.truncated,
        cached: result.cached,
      })

      return {
        root: result.root,
        authorizedRoots: [...guard.roots],
        detection: result.detection,
        stats: result.stats,
        directorySummary: result.directorySummary,
        tree: args.includeTree === false ? [] : result.tree,
        truncated: result.truncated,
        cached: result.cached,
        warnings: result.warnings,
        durationMs: result.durationMs,
      }
    },
  })
}
