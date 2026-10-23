/**
 * 文档生成工具（第五阶段）：generate_architecture_report / generate_readme_draft。
 *
 * 两者共用同一条流水线：
 *   路径校验 -> 结构扫描（可选依赖分析） -> 组装 Markdown -> 落盘策略（默认 dry-run、默认不覆盖）
 *
 * 注意默认值：dryRun 默认 true。模型必须先展示计划，用户确认后才传 dryRun=false 真正写盘。
 */
import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeDocument } from '../adapters/doc-writer.js'
import { createWorkspaceGuard } from '../security/workspace-guard.js'
import { analyzeDependencies } from '../services/dependency-analyzer.js'
import { generateArchitectureReport, generateReadmeDraft } from '../services/report-generator.js'
import { scanProject } from '../services/project-scanner.js'
import { ErrorCode, ProjectOpsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'

export const DOC_TOOL_NAMES = {
  architecture: 'generate_architecture_report',
  readme: 'generate_readme_draft',
} as const

export interface DocToolDefaults {
  allowedRoots: readonly string[]
  maxDepth: number
  maxEntries: number
  includeHidden: boolean
  extraExcludes: readonly string[]
  maxFiles: number
  maxFileBytes: number
}

export interface DocToolDeps {
  defaults: DocToolDefaults
  /** 提供任务库读写：报告里带上任务队列，并可把确认的问题落成任务。 */
  taskStoreFor?: (root: string) => import('../storage/task-store.js').TaskStore
  logger: Logger
}

export interface DocToolContext {
  roots: string[]
  guardRoots: string[]
  root: string
}

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

function resolveContext(deps: DocToolDeps, exec: unknown, requestedPath: string | undefined): DocToolContext {
  const sessionCwd = readSessionCwd(exec)
  const roots = collectAuthorizedRoots(deps.defaults.allowedRoots, sessionCwd)
  const guard = createWorkspaceGuard({ roots })
  const target = guard.resolve(requestedPath ?? '.', {
    baseDir: sessionCwd ?? guard.roots[0],
    expect: 'directory',
  })
  return { roots, guardRoots: [...guard.roots], root: target.absolutePath }
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['confirmed', 'heuristic'] },
    message: { type: 'string', required: true },
  },
}

const BASE_OUTPUT_PROPERTIES = {
  root: { type: 'string', required: true },
  target: { type: 'string', required: true },
  written: { type: 'boolean', required: true },
  dryRun: { type: 'boolean', required: true },
  skippedReason: { type: 'string', required: true },
  bytes: { type: 'integer', required: true },
  preview: { type: 'string', required: true },
  plan: { type: 'array', required: true, items: { type: 'string' } },
}

function renderWriteReport(value: {
  target: string
  written: boolean
  dryRun: boolean
  skippedReason: string
  bytes: number
  preview: string
}) {
  const lines: string[] = []
  lines.push('## 文档生成' + (value.written ? '完成' : '（未写入）'))
  lines.push('')
  lines.push('- 目标文件：' + value.target)
  lines.push('- 状态：' + (value.written ? '已写入' : value.dryRun ? 'dry-run，仅预览' : '已跳过：' + value.skippedReason))
  lines.push('- 大小：' + value.bytes + ' 字节')
  lines.push('')
  lines.push('### 预览（前几行）')
  lines.push('')
  lines.push(String.fromCharCode(96, 96, 96) + 'markdown')
  for (const line of value.preview.split('\n')) lines.push(line)
  lines.push(String.fromCharCode(96, 96, 96))
  return lines.join('\n')
}

export function createDocTools(deps: DocToolDeps) {
  const logger = deps.logger.child({ scope: 'docs' })

  const architectureReport = defineTool({
    name: DOC_TOOL_NAMES.architecture,
    description:
      '生成项目的 Markdown 架构说明：项目概览、目录结构、模块职责、依赖关系（含 Mermaid 图）、已确认的问题、启发式观察与改进建议。' +
      '默认 dryRun=true，只返回计划与预览、不写盘；目标文件已存在时默认拒绝覆盖（需 overwrite=true）。' +
      '输出分两类：「静态可确认」来自 import 解析，「启发式」来自文件名与规模统计。',
    parameters: {
      path: { type: 'string', description: '项目目录（默认工作区根目录），必须在授权工作区内' },
      outputPath: { type: 'string', description: '相对项目根的输出路径（默认 docs/architecture.md）' },
      analyzeDependencies: { type: 'boolean', description: '是否同时跑依赖分析（默认 true）' },
      includeTasks: { type: 'boolean', description: '是否把当前任务队列写进报告（默认 true）' },
      createTasksForFindings: {
        type: 'boolean',
        description: '是否把「已确认的问题」自动落成任务（默认 false；按标题去重）',
      },
      dryRun: { type: 'boolean', description: '只预览不写盘（默认 true；确认后传 false 才写入）' },
      overwrite: { type: 'boolean', description: '允许覆盖已存在的文件（默认 false）' },
      previewLines: { type: 'integer', description: '预览行数（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BASE_OUTPUT_PROPERTIES,
          sections: { type: 'array', required: true, items: { type: 'string' } },
          findings: { type: 'array', required: true, items: FINDING_SCHEMA },
          createdTasks: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderWriteReport(value) }],
    },
    async execute(args, exec) {
      const context = resolveContext(deps, exec, args.path)
      const scan = await scanProject({
        root: context.root,
        limits: { maxDepth: deps.defaults.maxDepth, maxEntries: deps.defaults.maxEntries },
        filters: { includeHidden: deps.defaults.includeHidden, extraExcludes: deps.defaults.extraExcludes },
        logger,
      })
      const dependencies =
        args.analyzeDependencies === false
          ? undefined
          : await analyzeDependencies({
              root: context.root,
              limits: { maxFiles: deps.defaults.maxFiles, maxFileBytes: deps.defaults.maxFileBytes },
              logger,
            })

      const store = deps.taskStoreFor?.(context.root)
      const taskSummary = store === undefined || args.includeTasks === false ? undefined : store.counts()
      const report = generateArchitectureReport({
        scan,
        dependencies,
        tasks: taskSummary,
        projectName: basenameOf(context.root),
      })

      const createdTasks: string[] = []
      if (args.createTasksForFindings === true && store !== undefined) {
        const existing = new Set(store.list({ limit: 200 }).map((task) => task.title))
        for (const finding of report.findings) {
          if (finding.kind !== 'confirmed') continue
          const title = '修复：' + finding.message
          if (existing.has(title)) continue
          createdTasks.push(store.create({ title, description: '由 generate_architecture_report 从确认的问题自动生成', priority: 5 }).id)
        }
      }
      const written = await writeDocument({
        roots: context.guardRoots,
        root: context.root,
        relativePath: args.outputPath ?? 'docs/architecture.md',
        content: report.markdown,
        dryRun: args.dryRun !== false,
        overwrite: args.overwrite === true,
        previewLines: args.previewLines ?? 20,
      })
      logger.info('doc/architecture', '架构说明生成流程结束', { target: written.target, written: written.written })

      return {
        root: context.root,
        target: written.target,
        written: written.written,
        dryRun: args.dryRun !== false,
        skippedReason: written.skippedReason,
        bytes: written.bytes,
        preview: written.preview,
        plan: written.plan,
        sections: report.sections,
        findings: report.findings,
        createdTasks,
      }
    },
  })

  const readmeDraft = defineTool({
    name: DOC_TOOL_NAMES.readme,
    description:
      '生成 README 初稿（项目简介、特性、快速开始、项目结构、入口与配置、License 占位）。' +
      '默认输出到 README.generated.md，不碰你已有的 README.md；默认 dryRun=true 只预览；已存在文件默认不覆盖。',
    parameters: {
      path: { type: 'string', description: '项目目录（默认工作区根目录）' },
      outputPath: { type: 'string', description: '相对项目根的输出路径（默认 README.generated.md）' },
      projectName: { type: 'string', description: '写进标题的项目名（默认取目录名）' },
      description: { type: 'string', description: '一句话项目简介' },
      dryRun: { type: 'boolean', description: '只预览不写盘（默认 true）' },
      overwrite: { type: 'boolean', description: '允许覆盖已存在文件（默认 false）' },
      previewLines: { type: 'integer', description: '预览行数（默认 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...BASE_OUTPUT_PROPERTIES },
      },
      render: (_args, value) => [{ type: 'text', text: renderWriteReport(value) }],
    },
    async execute(args, exec) {
      const context = resolveContext(deps, exec, args.path)
      const scan = await scanProject({
        root: context.root,
        limits: { maxDepth: deps.defaults.maxDepth, maxEntries: deps.defaults.maxEntries },
        filters: { includeHidden: deps.defaults.includeHidden, extraExcludes: deps.defaults.extraExcludes },
        logger,
      })
      const markdown = generateReadmeDraft({
        scan,
        projectName: args.projectName ?? basenameOf(context.root),
        description: args.description,
      })
      const written = await writeDocument({
        roots: context.guardRoots,
        root: context.root,
        relativePath: args.outputPath ?? 'README.generated.md',
        content: markdown,
        dryRun: args.dryRun !== false,
        overwrite: args.overwrite === true,
        previewLines: args.previewLines ?? 20,
      })
      logger.info('doc/readme', 'README 初稿生成流程结束', { target: written.target, written: written.written })
      return {
        root: context.root,
        target: written.target,
        written: written.written,
        dryRun: args.dryRun !== false,
        skippedReason: written.skippedReason,
        bytes: written.bytes,
        preview: written.preview,
        plan: written.plan,
      }
    },
  })

  return [architectureReport, readmeDraft]
}

function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index === -1 ? normalized : normalized.slice(index + 1)
}
