/**
 * analyze_dependencies 工具：Python 模块 import 关系、疑似循环依赖与 Mermaid 架构图。
 *
 * 与 scan_project 一样：只读、必须经过 WorkspaceGuard、错误带稳定错误码。
 * 结论分层：import 边与强连通分量是"静态可确认"的结构；外部依赖统计与"不可解析"清单是启发式的。
 */
import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createWorkspaceGuard } from '../security/workspace-guard.js'
import { analyzeProjectDependencies } from '../services/dependency-service.js'
import { renderDependencyGraph } from '../services/mermaid-renderer.js'
import { ErrorCode, ProjectOpsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'

export const ANALYZE_DEPENDENCIES_TOOL_NAME = 'analyze_dependencies'

export interface AnalyzeDependenciesDefaults {
  allowedRoots: readonly string[]
  maxFiles: number
  maxFileBytes: number
}

export interface AnalyzeDependenciesDeps {
  defaults: AnalyzeDependenciesDefaults
  logger: Logger
}

const FENCE = '```'

const EDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['absolute', 'relative'] },
    scope: { type: 'string', required: true, enum: ['module', 'nested'] },
    line: { type: 'integer', required: true },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    root: { type: 'string', required: true },
    authorizedRoots: { type: 'array', required: true, items: { type: 'string' } },
    language: { type: 'string', required: true, enum: ['python', 'javascript'] },
    detected: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        python: { type: 'integer', required: true },
        javascript: { type: 'integer', required: true },
      },
    },
    mixedProject: { type: 'boolean', required: true },
    stats: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        files: { type: 'integer', required: true },
        modules: { type: 'integer', required: true },
        edges: { type: 'integer', required: true },
        cycles: { type: 'integer', required: true },
        bytesRead: { type: 'integer', required: true },
      },
    },
    modules: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          module: { type: 'string', required: true },
          path: { type: 'string', required: true },
          imports: { type: 'integer', required: true },
        },
      },
    },
    edges: { type: 'array', required: true, items: EDGE_SCHEMA },
    cycles: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modules: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
    },
    external: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          files: { type: 'integer', required: true },
        },
      },
    },
    unresolved: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          specifier: { type: 'string', required: true },
          line: { type: 'integer', required: true },
        },
      },
    },
    mermaid: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    durationMs: { type: 'integer', required: true },
  },
}

const TOOL_DESCRIPTION = [
  '分析一个已授权工作区内 Python 项目的模块 import 依赖：返回模块清单、依赖边、疑似循环依赖（强连通分量）、',
  '外部依赖统计、无法解析的相对导入，以及可直接粘进文档的 Mermaid 架构图。',
  '只读操作，不修改任何文件。解析是静态词法级（不执行代码、不构建 AST）：动态导入识别不到，',
  '因此 import 边与循环依赖是"静态可确认"的结构，外部依赖与不可解析清单是启发式结果。',
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

interface AnalyzeOutput {
  root: string
  authorizedRoots: string[]
  language: 'python' | 'javascript'
  detected: { python: number; javascript: number }
  mixedProject: boolean
  stats: { files: number; modules: number; edges: number; cycles: number; bytesRead: number }
  modules: Array<{ module: string; path: string; imports: number }>
  edges: Array<{ from: string; to: string; kind: 'absolute' | 'relative'; scope: 'module' | 'nested'; line: number }>
  cycles: Array<{ modules: string[] }>
  external: Array<{ name: string; files: number }>
  unresolved: Array<{ from: string; specifier: string; line: number }>
  mermaid: string
  truncated: boolean
  warnings: string[]
  durationMs: number
}

function renderReport(output: AnalyzeOutput): string {
  const lines: string[] = []
  lines.push('## 依赖分析结果（Python）')
  lines.push('')
  lines.push('- 项目根目录：' + output.root)
  lines.push(
    '- 分析语言：' +
      (output.language === 'python' ? 'Python' : 'TypeScript / JavaScript') +
      '（探测到 Python ' +
      output.detected.python +
      ' 个、JS/TS ' +
      output.detected.javascript +
      ' 个源文件' +
      (output.mixedProject ? '，混合仓库本次只分析了一种语言' : '') +
      '）',
  )
  lines.push(
    '- 规模：' +
      output.stats.files +
      ' 个 Python 文件 / ' +
      output.stats.modules +
      ' 个模块 / ' +
      output.stats.edges +
      ' 条项目内依赖边（耗时 ' +
      output.durationMs +
      ' ms）',
  )
  lines.push('- 已确认的循环依赖（强连通分量）：' + (output.cycles.length === 0 ? '未发现' : output.cycles.length + ' 处'))
  for (const cycle of output.cycles) {
    lines.push('  - ' + cycle.modules.join(' <-> '))
  }
  if (output.external.length > 0) {
    lines.push(
      '- 外部依赖（启发式，按引用文件数排序）：' +
        output.external
          .slice(0, 8)
          .map((item) => item.name + '(' + item.files + ')')
          .join('、'),
    )
  }
  if (output.unresolved.length > 0) {
    lines.push('- 无法解析的导入：' + output.unresolved.length + ' 处（例如 ' + output.unresolved[0]?.specifier + '）')
  }
  if (output.truncated) lines.push('- 注意：文件数达到上限，分析结果不完整')
  if (output.mermaid !== '') {
    lines.push('')
    lines.push('### 架构图（Mermaid）')
    lines.push('')
    lines.push(FENCE + 'mermaid')
    for (const line of output.mermaid.split('\n')) lines.push(line)
    lines.push(FENCE)
  }
  if (output.warnings.length > 0) {
    lines.push('')
    lines.push('### 告警')
    for (const warning of output.warnings) lines.push('- ' + warning)
  }
  return lines.join('\n')
}

export function createAnalyzeDependenciesTool(deps: AnalyzeDependenciesDeps) {
  const logger = deps.logger.child({ tool: ANALYZE_DEPENDENCIES_TOOL_NAME })

  return defineTool({
    name: ANALYZE_DEPENDENCIES_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    isConcurrencySafe: () => true,
    parameters: {
      path: {
        type: 'string',
        description: '要分析的 Python 项目目录；相对路径按当前工作区解析。省略则用工作区根目录。',
      },
      maxFiles: { type: 'integer', description: '最多分析的 .py 文件数（1-20000，默认取插件配置）' },
      maxFileBytes: { type: 'integer', description: '单文件最多读取字节数（默认取插件配置）' },
      language: {
        type: 'string',
        enum: ['auto', 'python', 'javascript'],
        description: '分析哪种语言：auto（默认，按文件数自动选择）/ python / javascript',
      },
      includeMermaid: { type: 'boolean', description: '是否返回 Mermaid 架构图文本（默认 true）' },
      includeExternal: { type: 'boolean', description: '是否返回外部依赖统计（默认 true）' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    async execute(args, exec) {
      const sessionCwd = readSessionCwd(exec)
      const roots = collectAuthorizedRoots(deps.defaults.allowedRoots, sessionCwd)
      const guard = createWorkspaceGuard({ roots })
      const target = guard.resolve(args.path ?? '.', {
        baseDir: sessionCwd ?? guard.roots[0],
        expect: 'directory',
      })

      logger.info('tool/analyze_dependencies', '开始依赖分析', { target: target.absolutePath })
      const analyzed = await analyzeProjectDependencies({
        root: target.absolutePath,
        limits: {
          maxFiles: args.maxFiles ?? deps.defaults.maxFiles,
          maxFileBytes: args.maxFileBytes ?? deps.defaults.maxFileBytes,
        },
        language: (args.language as 'auto' | 'python' | 'javascript' | undefined) ?? 'auto',
        logger,
      })
      const report = analyzed.report
      const rendered = args.includeMermaid === false ? { mermaid: '', omittedEdges: 0 } : renderDependencyGraph(report)
      logger.info('tool/analyze_dependencies', '依赖分析完成', {
        modules: report.stats.modules,
        edges: report.stats.edges,
        cycles: report.stats.cycles,
      })

      return {
        root: report.root,
        authorizedRoots: [...guard.roots],
        language: report.language,
        detected: analyzed.detected,
        mixedProject: analyzed.mixedProject,
        stats: report.stats,
        modules: report.modules,
        edges: report.edges,
        cycles: report.cycles,
        external: args.includeExternal === false ? [] : report.external,
        unresolved: report.unresolved,
        mermaid: rendered.mermaid,
        truncated: report.truncated,
        warnings: report.warnings,
        durationMs: report.durationMs,
      }
    },
  })
}
