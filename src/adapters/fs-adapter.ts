/** 文件系统适配层：业务代码只依赖 FsPort 接口，方便测试替身与将来替换实现。 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { FileKind } from '../types.js'
import { mapFsError } from '../util/errors.js'

export interface FsEntry {
  name: string
  kind: FileKind
  /** 目录固定为 0；文件取 lstat 的字节数。 */
  size: number
}

export interface FsPort {
  listDirectory(dir: string): Promise<FsEntry[]>
}

function kindOf(dirent: Dirent): FileKind {
  if (dirent.isDirectory()) return 'directory'
  if (dirent.isSymbolicLink()) return 'symlink'
  if (dirent.isFile()) return 'file'
  return 'other'
}

export function createNodeFsPort(): FsPort {
  return {
    async listDirectory(dir) {
      let dirents: Dirent[]
      try {
        dirents = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        throw mapFsError(error, dir)
      }

      const entries: FsEntry[] = []
      for (const dirent of dirents) {
        const kind = kindOf(dirent)
        let size = 0
        if (kind === 'file' || kind === 'symlink') {
          try {
            size = (await lstat(join(dir, dirent.name))).size
          } catch {
            // 单个条目的元数据读取失败不应中断整个目录扫描。
            size = 0
          }
        }
        entries.push({ name: dirent.name, kind, size })
      }
      return entries
    },
  }
}
