/**
 * Python 模块依赖分析服务（第三阶段）。
 *
 * 流程：收集 .py 文件 -> 建立"模块名 <-> 文件"映射 -> 解析 import -> 解析到项目内模块 -> 建图 -> 找强连通分量。
 *
 * 诚实的边界：
 * - 只认静态 import/from-import；动态导入、字符串拼接模块名不会被识别；
 * - "循环依赖"报告的是**解析出的 import 图**中的强连通分量，属于静态可确认的结构事实；
 * - 解析不到项目内模块的导入归为 external（标准库/第三方）或 unresolved（相对导入越界等）。
 */
import { join } from 'node:path'
import type { FsEntry, FsPort } from '../adapters/fs-adapter.js'
import { createNodeFsPort } from '../adapters/fs-adapter.js'
import type { SourceReader } from '../adapters/source-reader.js'
import { createNodeSourceReader } from '../adapters/source-reader.js'
import { isExcludedDir, isSensitiveFile } from '../security/excludes.js'
import { describeError, mapFsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'
import { basename } from './language-detect.js'
import type { RawImport } from './python-imports.js'
import { parseImports } from './python-imports.js'
import { collectSourceFiles } from './source-files.js'

const MAX_WARNINGS = 20
const MAX_FILES_CEILING = 20000
const MAX_FILE_BYTES_CEILING = 4 * 1024 * 1024

export interface AnalyzerLimits {
  maxFiles: number
  maxFileBytes: number
}

export interface DependencyEdge {
  from: string
  to: string
  kind: 'absolute' | 'relative'
  /** module：顶层导入（确定依赖）；nested：函数/条件体内的导入（运行时不一定成立）。 */
  scope: 'module' | 'nested'
  line: number
}

export interface DependencyCycle {
  modules: string[]
}

export interface ExternalImport {
  name: string
  files: number
}

export interface UnresolvedImport {
  from: string
  specifier: string
  line: number
}

export interface ModuleNode {
  module: string
  path: string
  imports: number
}

export interface DependencyStats {
  files: number
  modules: number
  edges: number
  cycles: number
  bytesRead: number
}

export type DependencyLanguage = 'python' | 'javascript'

export interface DependencyReport {
  language: DependencyLanguage
  root: string
  modules: ModuleNode[]
  edges: DependencyEdge[]
  cycles: DependencyCycle[]
  external: ExternalImport[]
  unresolved: UnresolvedImport[]
  stats: DependencyStats
  truncated: boolean
  warnings: string[]
  durationMs: number
}

export interface AnalyzeRequest {
  root: string
  limits: AnalyzerLimits
  port?: FsPort
  reader?: SourceReader
  logger?: Logger
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 相对路径 -> 模块名；__init__.py 归到包本身，根级 __init__.py 记为 __root__。 */
export function moduleNameOf(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.pyi?$/, '')
  const segments = withoutExtension.split('/')
  if (segments[segments.length - 1] === '__init__') segments.pop()
  const name = segments.join('.')
  return name === '' ? '__root__' : name
}

function packageOf(module: string, isPackage: boolean): string[] {
  if (module === '__root__') return []
  const segments = module.split('.')
  return isPackage ? segments : segments.slice(0, -1)
}

interface ResolutionContext {
  modules: Map<string, string>
  external: Map<string, number>
  unresolved: UnresolvedImport[]
}

function matchModule(context: ResolutionContext, candidate: string): string | undefined {
  if (candidate === '') return undefined
  if (context.modules.has(candidate)) return candidate
  const segments = candidate.split('.')
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const prefix = segments.slice(0, length).join('.')
    if (context.modules.has(prefix)) return prefix
  }
  return undefined
}

function resolveImports(
  context: ResolutionContext,
  fromModule: string,
  isPackage: boolean,
  raw: RawImport,
): { target: string; kind: 'absolute' | 'relative' } | undefined {
  if (raw.level === 0) {
    const base = raw.module
    if (raw.kind === 'from' && raw.names.length > 0) {
      for (const name of raw.names) {
        if (name === '*') continue
        const match = matchModule(context, base === '' ? name : base + '.' + name)
        if (match !== undefined) return { target: match, kind: 'absolute' }
      }
    }
    const match = matchModule(context, base)
    if (match !== undefined) return { target: match, kind: 'absolute' }
    if (base !== '') {
      // 解析不到项目内模块的绝对导入：按顶层包名统计为外部依赖。
      const top = base.split('.')[0] ?? base
      context.external.set(top, (context.external.get(top) ?? 0) + 1)
    }
    return undefined
  }

  const packageSegments = packageOf(fromModule, isPackage)
  const up = raw.level - 1
  if (up > packageSegments.length) {
    context.unresolved.push({
      from: fromModule,
      specifier: '.'.repeat(raw.level) + raw.module,
      line: raw.line,
    })
    return undefined
  }
  const baseSegments = packageSegments.slice(0, packageSegments.length - up)
  const basePath = [...baseSegments, ...(raw.module === '' ? [] : raw.module.split('.'))]

  if (raw.kind === 'from' && raw.names.length > 0) {
    for (const name of raw.names) {
      if (name === '*') continue
      const match = matchModule(context, [...basePath, name].join('.'))
      if (match !== undefined) return { target: match, kind: 'relative' }
    }
  }
  const base = basePath.join('.')
  const match = matchModule(context, base)
  if (match !== undefined) return { target: match, kind: 'relative' }
  context.unresolved.push({
    from: fromModule,
    specifier: '.'.repeat(raw.level) + raw.module + (raw.names.length > 0 ? ' (' + raw.names.join(', ') + ')' : ''),
    line: raw.line,
  })
  return undefined
}

/** Tarjan 强连通分量（迭代实现，避免深递归爆栈）。 */
export function findCycles(nodes: readonly string[], adjacency: Map<string, string[]>): string[][] {
  let counter = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  for (const start of nodes) {
    if (indices.has(start)) continue
    const frames: Array<{ node: string; children: string[]; next: number }> = []
    const enter = (node: string): void => {
      indices.set(node, counter)
      low.set(node, counter)
      counter += 1
      stack.push(node)
      onStack.add(node)
      frames.push({ node, children: adjacency.get(node) ?? [], next: 0 })
    }
    enter(start)

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      if (frame.next < frame.children.length) {
        const child = frame.children[frame.next]!
        frame.next += 1
        if (!indices.has(child)) {
          enter(child)
          continue
        }
        if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, indices.get(child) ?? 0))
        }
        continue
      }

      const node = frame.node
      frames.pop()
      const parentFrame = frames[frames.length - 1]
      if (parentFrame !== undefined) {
        low.set(parentFrame.node, Math.min(low.get(parentFrame.node) ?? 0, low.get(node) ?? 0))
      }
      if (low.get(node) === indices.get(node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()
          if (member === undefined) break
          onStack.delete(member)
          component.push(member)
          if (member === node) break
        }
        if (component.length > 1) {
          cycles.push([...component].sort())
        } else {
          const only = component[0] ?? ''
          if ((adjacency.get(only) ?? []).includes(only)) cycles.push([only])
        }
      }
    }
  }

  return cycles.sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''))
}

export async function analyzeDependencies(request: AnalyzeRequest): Promise<DependencyReport> {
  const started = Date.now()
  const port = request.port ?? createNodeFsPort()
  const reader = request.reader ?? createNodeSourceReader()
  const maxFiles = clamp(request.limits.maxFiles, 1, MAX_FILES_CEILING)
  const maxFileBytes = clamp(request.limits.maxFileBytes, 1024, MAX_FILE_BYTES_CEILING)
  const warnings: string[] = []

  const files = await collectSourceFiles(request.root, port, { extensions: ['.py', '.pyi'], maxFiles, warnings })
  const truncated = files.length >= maxFiles

  const modules = new Map<string, string>()
  for (const relativePath of files) {
    const moduleName = moduleNameOf(relativePath)
    if (modules.has(moduleName)) {
      if (warnings.length < MAX_WARNINGS) warnings.push('模块名冲突，保留先出现的文件: ' + moduleName + '（' + relativePath + '）')
      continue
    }
    modules.set(moduleName, relativePath)
  }

  const context: ResolutionContext = { modules, external: new Map(), unresolved: [] }
  const adjacency = new Map<string, string[]>()
  const edges: DependencyEdge[] = []
  const seenEdges = new Set<string>()
  const importCounts = new Map<string, number>()
  let bytesRead = 0

  for (const [moduleName, relativePath] of modules) {
    const absolutePath = join(request.root, relativePath)
    let source = ''
    try {
      const chunk = await reader.readTextFile(absolutePath, maxFileBytes)
      source = chunk.text
      bytesRead += chunk.bytes
      if (chunk.truncated && warnings.length < MAX_WARNINGS) {
        warnings.push('文件超过读取上限，只解析了前 ' + maxFileBytes + ' 字节: ' + relativePath)
      }
    } catch (error) {
      if (warnings.length < MAX_WARNINGS) {
        warnings.push('无法读取文件 ' + relativePath + '：' + describeError(mapFsError(error, absolutePath)))
      }
      continue
    }

    const isPackage = basename(relativePath) === '__init__.py' || basename(relativePath) === '__init__.pyi'
    const imports = parseImports(source)
    importCounts.set(moduleName, imports.length)

    for (const raw of imports) {
      const resolved = resolveImports(context, moduleName, isPackage, raw)
      if (resolved === undefined) continue
      const key = moduleName + '->' + resolved.target
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push({ from: moduleName, to: resolved.target, kind: resolved.kind, scope: raw.scope, line: raw.line })
      const outgoing = adjacency.get(moduleName) ?? []
      outgoing.push(resolved.target)
      adjacency.set(moduleName, outgoing)
    }
  }

  const nodes = [...modules.keys()]
  const cycles = findCycles(nodes, adjacency).map((component) => ({ modules: component }))

  const moduleNodes: ModuleNode[] = [...modules.entries()].map(([moduleName, relativePath]) => ({
    module: moduleName,
    path: relativePath,
    imports: importCounts.get(moduleName) ?? 0,
  }))
  moduleNodes.sort((left, right) => left.module.localeCompare(right.module))

  const external: ExternalImport[] = [...context.external.entries()]
    .map(([name, count]) => ({ name, files: count }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name))

  const durationMs = Date.now() - started
  request.logger?.debug('analyze/complete', 'Python 依赖分析完成', {
    root: request.root,
    files: files.length,
    edges: edges.length,
    cycles: cycles.length,
    durationMs,
  })

  return {
    language: 'python',
    root: request.root,
    modules: moduleNodes,
    edges,
    cycles,
    external,
    unresolved: context.unresolved,
    stats: {
      files: files.length,
      modules: modules.size,
      edges: edges.length,
      cycles: cycles.length,
      bytesRead,
    },
    truncated,
    warnings,
    durationMs,
  }
}
