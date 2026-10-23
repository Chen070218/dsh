/**
 * TypeScript / JavaScript 依赖分析（第三阶段能力的语言扩展）。
 *
 * 解析策略：
 * - 说明符以 '.' 开头 -> 相对导入，按扩展名候选表解析到项目内文件（含 /index.*）；
 * - 其它说明符 -> 外部依赖（node:fs、react、@scope/pkg），按包名归并计数；
 * - 解析不到的相对导入 -> unresolved（不猜路径）。
 *
 * 复用 Python 版本同一套报告结构与 Tarjan 找环，保证两个语言的输出可以互换消费。
 */
import type { FsPort } from '../adapters/fs-adapter.js'
import { createNodeFsPort } from '../adapters/fs-adapter.js'
import type { SourceReader } from '../adapters/source-reader.js'
import { createNodeSourceReader } from '../adapters/source-reader.js'
import { describeError, mapFsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'
import type {
  AnalyzerLimits,
  DependencyEdge,
  DependencyReport,
  ExternalImport,
  ModuleNode,
  UnresolvedImport,
} from './dependency-analyzer.js'
import { findCycles } from './dependency-analyzer.js'
import { parseJsImports } from './js-imports.js'
import { collectSourceFiles } from './source-files.js'
import { loadWorkspaceIndex } from './workspace-packages.js'

const MAX_FILES_CEILING = 20000
const MAX_FILE_BYTES_CEILING = 4 * 1024 * 1024

export const JS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

export interface PathAliasRule {
  /** 允许一个 * 通配符，例如 '@app/*'。 */
  pattern: string
  /** 已按 baseUrl 归一化的目标（不含扩展名），例如 'src/*'。 */
  targets: string[]
}

/** 容错解析 tsconfig.json（去注释与尾逗号），失败返回 undefined。 */
export function parseJsonc(text: string): unknown {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLine = withoutBlock
    .split('\n')
    .map((line) => {
      let quote: string | null = null
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (quote !== null) {
          if (char === '\\') {
            index += 1
            continue
          }
          if (char === quote) quote = null
          continue
        }
        if (char === '"') {
          quote = char
          continue
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index)
      }
      return line
    })
    .join('\n')
  const withoutTrailingCommas = withoutLine.replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(withoutTrailingCommas)
  } catch {
    return undefined
  }
}

/** 从 tsconfig 取 paths 别名；baseUrl 参与归一化。 */
export function extractPathAliases(config: unknown): PathAliasRule[] {
  if (typeof config !== 'object' || config === null) return []
  const options = (config as { compilerOptions?: unknown }).compilerOptions
  if (typeof options !== 'object' || options === null) return []
  const baseUrlRaw = (options as { baseUrl?: unknown }).baseUrl
  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.replace(/^\.\//, '').replace(/\/$/, '') : ''
  const pathsRaw = (options as { paths?: unknown }).paths
  if (typeof pathsRaw !== 'object' || pathsRaw === null) return []
  const rules: PathAliasRule[] = []
  for (const [pattern, targetsRaw] of Object.entries(pathsRaw as Record<string, unknown>)) {
    if (!Array.isArray(targetsRaw)) continue
    const targets = targetsRaw
      .filter((target): target is string => typeof target === 'string')
      .map((target) => normalizeRelativePath(baseUrl === '' ? target : baseUrl + '/' + target))
    if (targets.length > 0) rules.push({ pattern: normalizeRelativePath(pattern), targets })
  }
  // 更具体的别名优先（'@app/lib' 先于 '@app/*'）
  return rules.sort((left, right) => Number(left.pattern.includes('*')) - Number(right.pattern.includes('*')) || right.pattern.length - left.pattern.length)
}

/** 别名匹配：返回替换后的候选路径（未加扩展名）。 */
export function matchAlias(rules: readonly PathAliasRule[], specifier: string): string[] {
  const normalized = normalizeRelativePath(specifier)
  for (const rule of rules) {
    const star = rule.pattern.indexOf('*')
    if (star === -1) {
      if (rule.pattern !== normalized) continue
      return rule.targets.map((target) => normalizeRelativePath(target))
    }
    const prefix = rule.pattern.slice(0, star)
    const suffix = rule.pattern.slice(star + 1)
    if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) continue
    const middle = normalized.slice(prefix.length, normalized.length - suffix.length)
    return rule.targets.map((target) => normalizeRelativePath(target.replace('*', middle)))
  }
  return []
}

const ENTRY_SUFFIXES: readonly string[] = ['/index']

const RESOLVE_SUFFIXES: readonly string[] = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
]

export interface JsAnalyzeRequest {
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

function moduleKeyOf(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '')
}

/** 相对路径规整：消掉 './'、'../' 与重复斜杠，不触碰文件系统。 */
export function normalizeRelativePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

function directoryOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index === -1 ? '' : relativePath.slice(0, index)
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  if (specifier.startsWith('node:')) return specifier
  return specifier.split('/')[0] ?? specifier
}

async function loadAliases(
  root: string,
  reader: SourceReader,
  warnings: string[],
): Promise<PathAliasRule[]> {
  try {
    const chunk = await reader.readTextFile(root.replace(/[\\/]+$/, '') + '/tsconfig.json', 262144)
    const parsed = parseJsonc(chunk.text)
    if (parsed === undefined) {
      if (warnings.length < 20) warnings.push('tsconfig.json 解析失败，已忽略 paths 别名')
      return []
    }
    return extractPathAliases(parsed)
  } catch {
    return []
  }
}

export async function analyzeJavaScriptDependencies(request: JsAnalyzeRequest): Promise<DependencyReport> {
  const started = Date.now()
  const port = request.port ?? createNodeFsPort()
  const reader = request.reader ?? createNodeSourceReader()
  const maxFiles = clamp(request.limits.maxFiles, 1, MAX_FILES_CEILING)
  const maxFileBytes = clamp(request.limits.maxFileBytes, 1024, MAX_FILE_BYTES_CEILING)
  const warnings: string[] = []

  const files = await collectSourceFiles(request.root, port, { extensions: JS_EXTENSIONS, maxFiles, warnings })
  const truncated = files.length >= maxFiles

  // 模块表：'src/util' -> 'src/util.ts'
  const moduleFiles = new Map<string, string>()
  for (const relativePath of files) {
    const key = moduleKeyOf(relativePath)
    if (!moduleFiles.has(key)) moduleFiles.set(key, relativePath)
  }

  // 解析索引：真实模块键映射到自己；目录入口再注册别名 'src/components' -> 'src/components/index'
  const resolveIndex = new Map<string, string>()
  for (const key of moduleFiles.keys()) resolveIndex.set(key, key)
  for (const key of moduleFiles.keys()) {
    const last = key.split('/').pop() ?? ''
    if (last !== 'index') continue
    const directory = key.slice(0, key.length - last.length).replace(/\/$/, '')
    if (directory !== '' && !resolveIndex.has(directory)) resolveIndex.set(directory, key)
  }

  const aliases = await loadAliases(request.root, reader, warnings)
  const workspace = await loadWorkspaceIndex(request.root, port, reader)
  for (const warning of workspace.warnings) if (warnings.length < 20) warnings.push(warning)
  const external = new Map<string, number>()
  const unresolved: UnresolvedImport[] = []
  const edges: DependencyEdge[] = []
  const seen = new Set<string>()
  const adjacency = new Map<string, string[]>()
  const importCounts = new Map<string, number>()
  let bytesRead = 0

  for (const [key, relativePath] of moduleFiles) {
    const absolutePath = request.root.replace(/[\\/]+$/, '') + '/' + relativePath
    let source = ''
    try {
      const chunk = await reader.readTextFile(absolutePath, maxFileBytes)
      source = chunk.text
      bytesRead += chunk.bytes
      if (chunk.truncated && warnings.length < 20) {
        warnings.push('文件超过读取上限，只解析了前 ' + maxFileBytes + ' 字节: ' + relativePath)
      }
    } catch (error) {
      if (warnings.length < 20) {
        warnings.push('无法读取文件 ' + relativePath + '：' + describeError(mapFsError(error, absolutePath)))
      }
      continue
    }

    const imports = parseJsImports(source)
    importCounts.set(key, imports.length)

    for (const raw of imports) {
      if (!raw.specifier.startsWith('.')) {
        const aliasCandidates = matchAlias(aliases, raw.specifier)
        let aliasTarget: string | undefined
        for (const candidate of aliasCandidates) {
          for (const suffix of RESOLVE_SUFFIXES) {
            const resolved = resolveIndex.get(candidate + suffix)
            if (resolved !== undefined) {
              aliasTarget = resolved
              break
            }
          }
          if (aliasTarget !== undefined) break
        }
        if (aliasTarget !== undefined) {
          const aliasKey = key + '->' + aliasTarget
          if (!seen.has(aliasKey)) {
            seen.add(aliasKey)
            edges.push({ from: key, to: aliasTarget, kind: 'absolute', scope: raw.kind === 'static' ? 'module' : 'nested', line: raw.line })
            const outgoing = adjacency.get(key) ?? []
            outgoing.push(aliasTarget)
            adjacency.set(key, outgoing)
          }
          continue
        }
        // monorepo：先按工作区包名解析（workspace:* / 包名引用）
        const workspaceDirectory = workspace.packages.get(raw.specifier.split('/').slice(0, raw.specifier.startsWith('@') ? 2 : 1).join('/'))
        if (workspaceDirectory !== undefined) {
          const suffix = raw.specifier.slice(workspaceDirectory.name.length).replace(/^\//, '')
          const candidates =
            suffix === ''
              ? [workspaceDirectory.entry, ...ENTRY_SUFFIXES.map((extra) => workspaceDirectory.entry + extra)]
              : [normalizeRelativePath(workspaceDirectory.dir + '/' + suffix)]
          let workspaceTarget: string | undefined
          for (const candidate of candidates) {
            for (const extra of RESOLVE_SUFFIXES) {
              const resolved = resolveIndex.get(normalizeRelativePath(candidate + extra))
              if (resolved !== undefined) {
                workspaceTarget = resolved
                break
              }
            }
            if (workspaceTarget !== undefined) break
          }
          if (workspaceTarget !== undefined) {
            const workspaceKey = key + '->' + workspaceTarget
            if (!seen.has(workspaceKey)) {
              seen.add(workspaceKey)
              edges.push({ from: key, to: workspaceTarget, kind: 'absolute', scope: raw.kind === 'static' ? 'module' : 'nested', line: raw.line })
              const outgoing = adjacency.get(key) ?? []
              outgoing.push(workspaceTarget)
              adjacency.set(key, outgoing)
            }
            continue
          }
        }

        if (aliasCandidates.length > 0) {
          // 命中了别名但文件不存在：这是项目内路径问题，不算外部依赖
          unresolved.push({ from: key, specifier: raw.specifier, line: raw.line })
          continue
        }
        const name = packageNameOf(raw.specifier)
        external.set(name, (external.get(name) ?? 0) + 1)
        continue
      }
      // TS ESM 写法会带扩展名（import './util.js' 实际指向 util.ts），先剥掉再按候选表解析。
      const specifierPath = raw.specifier.replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '')
      const base = normalizeRelativePath(directoryOf(relativePath) + '/' + specifierPath)
      let target: string | undefined
      for (const suffix of RESOLVE_SUFFIXES) {
        const resolved = resolveIndex.get(base + suffix)
        if (resolved !== undefined) {
          target = resolved
          break
        }
      }
      if (target === undefined) {
        unresolved.push({ from: key, specifier: raw.specifier, line: raw.line })
        continue
      }
      const edgeKey = key + '->' + target
      if (seen.has(edgeKey)) continue
      seen.add(edgeKey)
      edges.push({ from: key, to: target, kind: 'relative', scope: raw.kind === 'static' ? 'module' : 'nested', line: raw.line })
      const outgoing = adjacency.get(key) ?? []
      outgoing.push(target)
      adjacency.set(key, outgoing)
    }
  }

  const cycles = findCycles([...moduleFiles.keys()], adjacency).map((component) => ({ modules: component }))

  const modules: ModuleNode[] = [...moduleFiles.entries()]
    .map(([key, relativePath]) => ({ module: key, path: relativePath, imports: importCounts.get(key) ?? 0 }))
    .sort((left, right) => left.module.localeCompare(right.module))

  const externalList: ExternalImport[] = [...external.entries()]
    .map(([name, count]) => ({ name, files: count }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name))

  const durationMs = Date.now() - started
  request.logger?.debug('analyze/js-complete', 'TypeScript/JavaScript 依赖分析完成', {
    root: request.root,
    files: files.length,
    edges: edges.length,
    cycles: cycles.length,
    durationMs,
  })

  return {
    language: 'javascript',
    root: request.root,
    modules,
    edges,
    cycles,
    external: externalList,
    unresolved,
    stats: {
      files: files.length,
      modules: moduleFiles.size,
      edges: edges.length,
      cycles: cycles.length,
      bytesRead,
    },
    truncated,
    warnings,
    durationMs,
  }
}
