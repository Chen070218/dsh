/**
 * monorepo 工作区包索引：把 `workspace:*` 这类跨包引用解析成项目内文件。
 *
 * 数据来源：根 package.json 的 `workspaces`（数组或 { packages: [] }）。
 * 只支持目录通配（`packages/*`）与精确目录两种写法；pnpm-workspace.yaml 暂不支持（不是 JSON）。
 * 解析不到就当作外部依赖——宁可少算，不编造边。
 */
import type { FsPort } from '../adapters/fs-adapter.js'
import type { SourceReader } from '../adapters/source-reader.js'
import { describeError, mapFsError } from '../util/errors.js'
import { normalizeRelativePath, parseJsonc } from './jsonc.js'

export interface WorkspacePackage {
  name: string
  dir: string
  /** package.json 里声明的入口（已归一化，未带扩展名）。 */
  entry: string
}

export interface WorkspaceIndex {
  packages: Map<string, WorkspacePackage>
  warnings: string[]
}

const ENTRY_FALLBACKS = ['index', 'src/index', 'lib/index', 'dist/index']

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'object' && value !== null) {
    const packages = (value as { packages?: unknown }).packages
    if (Array.isArray(packages)) return packages.filter((item): item is string => typeof item === 'string')
  }
  return []
}

function entryOf(manifest: unknown): string {
  if (typeof manifest !== 'object' || manifest === null) return ''
  const record = manifest as Record<string, unknown>
  const exported = record.exports
  let entry = ''
  if (typeof exported === 'string') entry = exported
  else if (typeof exported === 'object' && exported !== null) {
    const root = (exported as Record<string, unknown>)['.'] ?? (exported as Record<string, unknown>).default
    if (typeof root === 'string') entry = root
    else if (typeof root === 'object' && root !== null) {
      const fallback = (root as Record<string, unknown>).default ?? (root as Record<string, unknown>).import
      if (typeof fallback === 'string') entry = fallback
    }
  }
  if (entry === '' && typeof record.main === 'string') entry = record.main
  return entry.replace(/^\.\//, '')
}

export async function loadWorkspaceIndex(
  root: string,
  port: FsPort,
  reader: SourceReader,
): Promise<WorkspaceIndex> {
  const packages = new Map<string, WorkspacePackage>()
  const warnings: string[] = []
  const cleanRoot = root.replace(/[\\/]+$/, '')

  const readManifest = async (relativePath: string): Promise<unknown> => {
    const chunk = await reader.readTextFile(cleanRoot + '/' + relativePath, 262144)
    return parseJsonc(chunk.text)
  }

  let rootManifest: unknown
  try {
    rootManifest = await readManifest('package.json')
  } catch {
    return { packages, warnings }
  }
  if (typeof rootManifest !== 'object' || rootManifest === null) return { packages, warnings }
  const patterns = readStringArray((rootManifest as Record<string, unknown>).workspaces)
  if (patterns.length === 0) return { packages, warnings }

  const directories: string[] = []
  for (const pattern of patterns) {
    const normalized = normalizeRelativePath(pattern)
    if (normalized.endsWith('/*')) {
      const parent = normalized.slice(0, -2)
      try {
        const entries = await port.listDirectory(cleanRoot + '/' + parent)
        for (const entry of entries) {
          if (entry.kind !== 'directory') continue
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          directories.push(parent + '/' + entry.name)
        }
      } catch (error) {
        warnings.push('无法列出工作区目录 ' + parent + '：' + describeError(mapFsError(error, parent)))
      }
      continue
    }
    if (normalized.includes('*')) {
      warnings.push('暂不支持的工作区通配写法，已忽略：' + pattern)
      continue
    }
    directories.push(normalized)
  }

  for (const dir of directories) {
    let manifest: unknown
    try {
      manifest = await readManifest(dir + '/package.json')
    } catch {
      continue
    }
    const name = typeof (manifest as { name?: unknown })?.name === 'string' ? String((manifest as { name: string }).name) : ''
    if (name === '') continue
    const declared = entryOf(manifest)
    // 入口要剥掉扩展名：解析索引里的键是「不带扩展名的模块名」。
    const entry = (declared === '' ? ENTRY_FALLBACKS[0]! : normalizeRelativePath(dir + '/' + declared)).replace(
      /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
      '',
    )
    packages.set(name, { name, dir, entry: normalizeRelativePath(entry) })
  }

  return { packages, warnings }
}
