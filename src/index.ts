/**
 * dsh-projectops 插件入口。
 *
 * DSH（cordis 体系）插件契约：
 * - name：插件标识；
 * - inject：声明依赖的服务，这里只依赖 tools 注册表；
 * - Config：schemastery 配置 schema，加载时校验；
 * - apply(ctx, config)：挂载时执行，ctx.effect 注册卸载时的清理逻辑。
 *
 * 当前注册的工具：
 * - scan_project：项目结构扫描（第一/二阶段）
 * - analyze_dependencies：Python 依赖分析与 Mermaid 架构图（第三阶段）
 *
 * 注意：这里用结构化端口类型描述宿主，避免把 cordis 的具体类型固化进业务代码。
 */
import Schema from '@deepseek-ai/schemastery'
import { createScanCache } from './services/scan-cache.js'
import { createTaskService } from './services/task-service.js'
import type { ScanCache } from './services/scan-cache.js'
import { createAnalyzeDependenciesTool } from './tools/analyze-dependencies.js'
import { createScanProjectTool } from './tools/scan-project.js'
import { createDocTools } from './tools/doc-tools.js'
import { instrumentTools } from './tools/instrument.js'
import { createTaskTools } from './tools/task-tools.js'
import { createLogger, noopSink, redactFields, stderrSink } from './util/logger.js'
import { createBufferedLogger, createLogBuffer } from './util/log-buffer.js'
import { PLUGIN_TOOL_NAMES, createPluginInfoTools } from './tools/plugin-info.js'
import { createTranslator, localizeTools, resolveLocale } from './i18n/index.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from './version.js'
import type { LogLevel, Logger } from './util/logger.js'

export const name = 'dsh-projectops'
export const inject = ['tools']

export const Config = Schema.object({
  allowedRoots: Schema.array(Schema.string())
    .default([])
    .description('额外授权的工作区根目录（绝对路径）。留空时只允许当前会话工作区。'),
  maxDepth: Schema.natural().min(1).max(32).default(6).description('目录树最大深度。'),
  maxEntries: Schema.natural().min(1).max(200000).default(5000).description('单次扫描最多遍历的条目数。'),
  includeHidden: Schema.boolean().default(false).description('是否默认把隐藏文件/目录计入扫描结果。'),
  extraExcludes: Schema.array(Schema.string())
    .default([])
    .description('额外排除的目录名（大小写不敏感），例如 .projectops、fixtures。'),
  cacheTtlMs: Schema.natural().min(0).max(600000).default(30000).description('扫描缓存有效期（毫秒），0 表示不缓存。'),
  maxFiles: Schema.natural().min(1).max(20000).default(2000).description('依赖分析最多读取的 Python 文件数。'),
  maxFileBytes: Schema.natural().min(1024).max(4194304).default(262144).description('依赖分析单文件读取上限（字节）。'),
  taskMaxAttempts: Schema.natural().min(1).max(20).default(3).description('单个任务允许的最大尝试次数（失败后重试上限）。'),
  tasksDirectory: Schema.string()
    .default('.projectops')
    .description('工作区内存放任务数据库的目录名（相对路径）。'),
  locale: Schema.union(['auto', 'zh', 'en']).default('auto').description('工具文案语言：auto（按系统语言）/ zh / en。'),
  logLevel: Schema.union(['debug', 'info', 'warn', 'error']).default('info').description('日志级别（只影响环形缓冲；写 stderr 需另开 logToConsole）。'),
  logToConsole: Schema.boolean().default(false).description('是否把日志写到 stderr（默认关闭）。'),
})

export interface ProjectOpsConfig {
  allowedRoots?: string[]
  maxDepth?: number
  maxEntries?: number
  includeHidden?: boolean
  extraExcludes?: string[]
  cacheTtlMs?: number
  maxFiles?: number
  maxFileBytes?: number
  taskMaxAttempts?: number
  tasksDirectory?: string
  locale?: 'auto' | 'zh' | 'en'
  logLevel?: LogLevel
  logToConsole?: boolean
}

export interface ToolRegistryPort {
  register(definition: unknown): void
}

export interface PluginContextPort {
  tools: ToolRegistryPort
  effect?(callback: () => () => void, label?: string): unknown
}

export interface ResolvedConfig {
  allowedRoots: string[]
  maxDepth: number
  maxEntries: number
  includeHidden: boolean
  extraExcludes: string[]
  cacheTtlMs: number
  maxFiles: number
  maxFileBytes: number
  taskMaxAttempts: number
  tasksDirectory: string
  locale: 'auto' | 'zh' | 'en'
  logLevel: LogLevel
  logToConsole: boolean
}

/** 用 schema 做一次归一化：配置缺省值、类型错误都在挂载阶段暴露，而不是等到工具调用时。 */
export function resolveConfig(input: ProjectOpsConfig = {}): ResolvedConfig {
  const parsed = Config(input) as ProjectOpsConfig
  return {
    allowedRoots: (parsed.allowedRoots ?? []).filter(
      (root): root is string => typeof root === 'string' && root.trim() !== '',
    ),
    maxDepth: parsed.maxDepth ?? 6,
    maxEntries: parsed.maxEntries ?? 5000,
    includeHidden: parsed.includeHidden ?? false,
    extraExcludes: (parsed.extraExcludes ?? []).filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    ),
    cacheTtlMs: parsed.cacheTtlMs ?? 30000,
    maxFiles: parsed.maxFiles ?? 2000,
    maxFileBytes: parsed.maxFileBytes ?? 262144,
    taskMaxAttempts: parsed.taskMaxAttempts ?? 3,
    tasksDirectory: typeof parsed.tasksDirectory === 'string' && parsed.tasksDirectory.trim() !== '' ? parsed.tasksDirectory.trim() : '.projectops',
    locale: parsed.locale ?? 'auto',
    logLevel: parsed.logLevel ?? 'info',
    logToConsole: parsed.logToConsole ?? false,
  }
}

export function createLoggerFor(config: ResolvedConfig): Logger {
  return createLogger({
    sink: config.logToConsole ? stderrSink : noopSink,
    level: config.logLevel,
    fields: { plugin: name },
  })
}

export function apply(ctx: PluginContextPort, rawConfig: ProjectOpsConfig = {}): void {
  const config = resolveConfig(rawConfig)
  const buffer = createLogBuffer(200)
  const logger = createBufferedLogger({
    buffer,
    extraSinks: config.logToConsole ? [stderrSink] : [],
    level: config.logLevel,
    fields: { plugin: PLUGIN_NAME },
  })
  const translator = createTranslator(resolveLocale(config.locale))
  const cache = createScanCache({ ttlMs: config.cacheTtlMs })
  const taskService = createTaskService({ directory: config.tasksDirectory, logger })

  const coreTools = [
    createScanProjectTool({
      defaults: {
        allowedRoots: config.allowedRoots,
        maxDepth: config.maxDepth,
        maxEntries: config.maxEntries,
        includeHidden: config.includeHidden,
        extraExcludes: config.extraExcludes,
      },
      cache,
      logger,
    }),
    createAnalyzeDependenciesTool({
      defaults: {
        allowedRoots: config.allowedRoots,
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
      },
      logger,
    }),
    ...createDocTools({
      defaults: {
        allowedRoots: config.allowedRoots,
        maxDepth: config.maxDepth,
        maxEntries: config.maxEntries,
        includeHidden: config.includeHidden,
        extraExcludes: config.extraExcludes,
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
      },
      taskStoreFor: (root: string) => taskService.forWorkspace(root),
      logger,
    }),
    ...createTaskTools({
      defaults: { allowedRoots: config.allowedRoots, maxAttempts: config.taskMaxAttempts },
      service: taskService,
      logger,
    }),
  ]

  const toolNames = [...coreTools.map((tool) => tool.name), PLUGIN_TOOL_NAMES.info, PLUGIN_TOOL_NAMES.logs]
  const pluginTools = createPluginInfoTools({
    buffer,
    registeredTools: toolNames,
    config: redactFields({ ...config }) as Record<string, unknown>,
    startedAt: new Date().toISOString(),
  })

  const localized = localizeTools(coreTools, translator)
  // 每个工具都包一层计时+计数日志（只记数字，不记内容）
  for (const tool of instrumentTools([...localized, ...pluginTools], logger)) ctx.tools.register(tool)

  logger.info('plugin/apply', PLUGIN_NAME + ' 已挂载', {
    version: PLUGIN_VERSION,
    locale: translator.locale,
    tools: toolNames.length,
    allowedRoots: config.allowedRoots,
    cacheTtlMs: config.cacheTtlMs,
  })

  ctx.effect?.(() => {
    return () => {
      taskService.closeAll()
      cache.clear()
      logger.info('plugin/dispose', PLUGIN_NAME + ' 已卸载', { version: PLUGIN_VERSION })
    }
  }, 'dsh-projectops: lifecycle')
}

export type { ScanCache } from './services/scan-cache.js'
export { createScanCache } from './services/scan-cache.js'
export { createScanProjectTool, SCAN_PROJECT_TOOL_NAME } from './tools/scan-project.js'
export { createAnalyzeDependenciesTool, ANALYZE_DEPENDENCIES_TOOL_NAME } from './tools/analyze-dependencies.js'
export { createTaskTools, TASK_TOOL_NAMES } from './tools/task-tools.js'
export { createDocTools, DOC_TOOL_NAMES } from './tools/doc-tools.js'
export { createPluginInfoTools, PLUGIN_TOOL_NAMES } from './tools/plugin-info.js'
export { createLogBuffer, createBufferedLogger } from './util/log-buffer.js'
export { PLUGIN_NAME, PLUGIN_VERSION } from './version.js'
export { generateArchitectureReport, generateReadmeDraft } from './services/report-generator.js'
export { writeDocument } from './adapters/doc-writer.js'
export { createTaskService } from './services/task-service.js'
export { createSqliteTaskStore } from './storage/sqlite-task-store.js'
export { TASK_STATES } from './storage/task-store.js'
export { scanProject } from './services/project-scanner.js'
export { detectProject } from './services/language-detect.js'
export { analyzeDependencies, moduleNameOf, findCycles } from './services/dependency-analyzer.js'
export { renderDependencyGraph } from './services/mermaid-renderer.js'
export { parseImports } from './services/python-imports.js'
export { createWorkspaceGuard } from './security/workspace-guard.js'
export { ProjectOpsError, ErrorCode } from './util/errors.js'
