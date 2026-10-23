/**
 * 项目结构扫描服务。
 *
 * 设计要点：
 * - 单个目录读取失败只会产生一条 warning，不中断整体扫描；
 * - 不跟随符号链接，避免指向工作区之外的链接把扫描带出边界；
 * - 用 maxDepth / maxEntries 做硬限制，保证在超大仓库上也可预期地返回；
 * - 过滤规则（排除目录、隐藏文件、敏感文件）集中在 security/excludes.ts。
 */
import { basename, join } from 'node:path'
import type { FsEntry, FsPort } from '../adapters/fs-adapter.js'
import { createNodeFsPort } from '../adapters/fs-adapter.js'
import { isExcludedDir, isSensitiveFile } from '../security/excludes.js'
import type { DirectorySummary, ExtensionCount, ScanFilterOptions, ScanLimits, ScanResult } from '../types.js'
import { describeError, mapFsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'
import { detectProject, extensionOf } from './language-detect.js'

const MAX_WARNINGS = 20
const DEPTH_CEILING = 32
const ENTRY_CEILING = 200000

export interface ScanRequest {
  root: string
  limits: ScanLimits
  filters?: ScanFilterOptions
  port?: FsPort
  logger?: Logger
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function normalizeLimits(limits: ScanLimits): ScanLimits {
  return {
    maxDepth: clamp(limits.maxDepth, 1, DEPTH_CEILING),
    maxEntries: clamp(limits.maxEntries, 1, ENTRY_CEILING),
  }
}

function compareEntries(left: FsEntry, right: FsEntry): number {
  const leftRank = left.kind === 'directory' ? 0 : 1
  const rightRank = right.kind === 'directory' ? 0 : 1
  if (leftRank !== rightRank) return leftRank - rightRank
  return left.name.toLowerCase().localeCompare(right.name.toLowerCase())
}

export async function scanProject(request: ScanRequest): Promise<ScanResult> {
  const started = Date.now()
  const port = request.port ?? createNodeFsPort()
  const limits = normalizeLimits(request.limits)
  const includeHidden = request.filters?.includeHidden === true
  const excludedDirs = new Set((request.filters?.extraExcludes ?? []).map((name) => name.toLowerCase()))
  const warnings: string[] = []
  const tree: string[] = []
  const relativeFiles: string[] = []
  const extensionCounter = new Map<string, number>()
  const directoryTotals = new Map<string, { files: number; bytes: number }>()
  const stats = {
    files: 0,
    directories: 0,
    symlinks: 0,
    bytes: 0,
    skippedSensitive: 0,
    skippedHidden: 0,
  }
  let budget = limits.maxEntries
  let truncated = false

  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message)
  }

  tree.push(basename(request.root) + '/')

  const walk = async (dir: string, relativeDir: string, depth: number, prefix: string): Promise<void> => {
    let entries: FsEntry[]
    try {
      entries = await port.listDirectory(dir)
    } catch (error) {
      // 适配层之外的失败也统一成 ProjectOpsError，保证告警里带稳定的错误码。
      warn('跳过无法读取的目录 ' + (relativeDir === '' ? '.' : relativeDir) + '：' + describeError(mapFsError(error, dir)))
      return
    }

    const visible = entries.filter((entry) => {
      if (entry.kind === 'other') return false
      if (entry.kind === 'directory') {
        if (isExcludedDir(entry.name) || excludedDirs.has(entry.name.toLowerCase())) return false
        if (!includeHidden && entry.name.startsWith('.')) {
          stats.skippedHidden += 1
          return false
        }
        return true
      }
      if (isSensitiveFile(entry.name)) {
        stats.skippedSensitive += 1
        return false
      }
      if (!includeHidden && entry.name.startsWith('.')) {
        stats.skippedHidden += 1
        return false
      }
      return true
    })
    visible.sort(compareEntries)

    for (let index = 0; index < visible.length; index += 1) {
      if (budget <= 0) {
        truncated = true
        warn('条目数达到上限 ' + limits.maxEntries + '，后续内容未扫描')
        return
      }
      budget -= 1
      const entry = visible[index] as FsEntry
      const isLast = index === visible.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = prefix + (isLast ? '    ' : '│   ')
      const relativePath = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name

      if (entry.kind === 'directory') {
        stats.directories += 1
        tree.push(prefix + connector + entry.name + '/')
        if (depth + 1 >= limits.maxDepth) {
          warn('目录深度达到上限 ' + limits.maxDepth + '，未展开: ' + relativePath)
          continue
        }
        await walk(join(dir, entry.name), relativePath, depth + 1, childPrefix)
        continue
      }

      if (entry.kind === 'symlink') {
        stats.symlinks += 1
        tree.push(prefix + connector + entry.name + ' (symbolic link)')
        continue
      }

      stats.files += 1
      stats.bytes += entry.size
      const extension = extensionOf(entry.name)
      if (extension !== '') extensionCounter.set(extension, (extensionCounter.get(extension) ?? 0) + 1)
      relativeFiles.push(relativePath)

      const slash = relativePath.indexOf('/')
      if (slash > 0) {
        const top = relativePath.slice(0, slash)
        const total = directoryTotals.get(top) ?? { files: 0, bytes: 0 }
        total.files += 1
        total.bytes += entry.size
        directoryTotals.set(top, total)
      }

      tree.push(prefix + connector + entry.name)
    }
  }

  await walk(request.root, '', 0, '')

  const byExtension: ExtensionCount[] = [...extensionCounter.entries()]
    .map(([extension, count]) => ({ extension, count }))
    .sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension))
    .slice(0, 12)

  const directorySummary: DirectorySummary[] = [...directoryTotals.entries()]
    .map(([path, total]) => ({ path, files: total.files, bytes: total.bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
    .slice(0, 20)

  const detection = detectProject({ files: relativeFiles })
  const durationMs = Date.now() - started

  request.logger?.debug('scan/complete', '项目扫描完成', {
    root: request.root,
    files: stats.files,
    directories: stats.directories,
    skippedHidden: stats.skippedHidden,
    truncated,
    durationMs,
  })

  return {
    root: request.root,
    detection,
    stats: { ...stats, byExtension },
    directorySummary,
    tree,
    truncated,
    warnings,
    durationMs,
  }
}
