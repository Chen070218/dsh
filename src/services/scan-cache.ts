/**
 * 扫描结果缓存。
 *
 * 目的：同一个会话里反复 scan_project 不应该重复遍历整棵树。
 * 失效策略保守而可测：
 * 1. 根目录 mtime 变化 -> 失效（顶层有增删即失效）；
 * 2. 超过 TTL -> 失效（深层文件的修改不会被 mtime 捕捉，靠 TTL 兜底）；
 * 3. 过滤条件/上限变化 -> 不命中（键里带了全部参数）。
 */
import { statSync } from 'node:fs'
import { scanProject } from './project-scanner.js'
import type { ScanRequest } from './project-scanner.js'
import type { ScanResult } from '../types.js'

export interface CachedScanResult extends ScanResult {
  cached: boolean
}

export interface ScanCache {
  scan(request: ScanRequest): Promise<CachedScanResult>
  clear(): void
  readonly size: number
}

export interface ScanCacheOptions {
  ttlMs?: number
  now?: () => number
}

interface CacheEntry {
  result: ScanResult
  storedAt: number
  fingerprint: string
}

const DEFAULT_TTL_MS = 30_000

function fingerprintOf(request: ScanRequest): string {
  return JSON.stringify({
    root: request.root,
    maxDepth: request.limits.maxDepth,
    maxEntries: request.limits.maxEntries,
    includeHidden: request.filters?.includeHidden ?? false,
    extraExcludes: [...(request.filters?.extraExcludes ?? [])].sort(),
  })
}

function rootSignature(root: string): string {
  try {
    const stats = statSync(root)
    return String(stats.mtimeMs)
  } catch {
    return 'missing'
  }
}

export function createScanCache(options: ScanCacheOptions = {}): ScanCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  const entries = new Map<string, CacheEntry>()

  return {
    get size() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    async scan(request) {
      const key = fingerprintOf(request)
      const signature = rootSignature(request.root)
      const cached = entries.get(key)
      if (cached !== undefined) {
        const fresh = now() - cached.storedAt <= ttlMs
        const sameTree = cached.fingerprint === signature
        if (fresh && sameTree) {
          request.logger?.debug('scan/cache-hit', '命中扫描缓存', { root: request.root })
          return { ...cached.result, cached: true }
        }
        entries.delete(key)
      }

      const result = await scanProject(request)
      entries.set(key, { result, storedAt: now(), fingerprint: signature })
      return { ...result, cached: false }
    },
  }
}
