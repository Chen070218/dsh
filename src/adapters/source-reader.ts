/** 源码读取适配层：把"读文件"从解析逻辑里分离出来，测试可注入替身。 */
import { readFile, stat } from 'node:fs/promises'
import { mapFsError } from '../util/errors.js'

export interface SourceChunk {
  text: string
  /** 实际读取的字节数（用于统计）。 */
  bytes: number
  /** 文件超过 maxBytes，只读了前 maxBytes。 */
  truncated: boolean
}

export interface SourceReader {
  readTextFile(path: string, maxBytes: number): Promise<SourceChunk>
}

export function createNodeSourceReader(): SourceReader {
  return {
    async readTextFile(path, maxBytes) {
      let size = 0
      try {
        size = (await stat(path)).size
      } catch (error) {
        throw mapFsError(error, path)
      }
      try {
        const buffer = await readFile(path)
        const sliced = buffer.subarray(0, Math.max(0, maxBytes))
        return {
          text: sliced.toString('utf8'),
          bytes: sliced.byteLength,
          truncated: size > sliced.byteLength,
        }
      } catch (error) {
        throw mapFsError(error, path)
      }
    },
  }
}
