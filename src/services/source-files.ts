/** 源码文件收集（依赖分析共用）：排除缓存/隐藏/敏感目录，不跟随符号链接，受 maxFiles 限制。 */
import { join } from 'node:path'
import type { FsEntry, FsPort } from '../adapters/fs-adapter.js'
import { isExcludedDir, isSensitiveFile } from '../security/excludes.js'
import { describeError, mapFsError } from '../util/errors.js'

export interface CollectOptions {
  extensions: readonly string[]
  maxFiles: number
  warnings: string[]
  maxWarnings?: number
}

export async function collectSourceFiles(
  root: string,
  port: FsPort,
  options: CollectOptions,
): Promise<string[]> {
  const files: string[] = []
  const maxWarnings = options.maxWarnings ?? 20
  const warn = (message: string): void => {
    if (options.warnings.length < maxWarnings) options.warnings.push(message)
  }

  const wanted = (name: string): boolean => options.extensions.some((extension) => name.endsWith(extension))

  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    let entries: FsEntry[]
    try {
      entries = await port.listDirectory(dir)
    } catch (error) {
      warn('跳过无法读取的目录 ' + (relativeDir === '' ? '.' : relativeDir) + '：' + describeError(mapFsError(error, dir)))
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return
      const relativePath = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name
      if (entry.kind === 'directory') {
        if (isExcludedDir(entry.name) || entry.name.startsWith('.')) continue
        await walk(join(dir, entry.name), relativePath)
        continue
      }
      if (entry.kind !== 'file') continue
      if (isSensitiveFile(entry.name)) continue
      if (!wanted(entry.name)) continue
      files.push(relativePath)
    }
  }

  await walk(root, '')
  return files
}
