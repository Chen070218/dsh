import test from 'node:test'
import assert from 'node:assert/strict'
import { createScanCache } from '../lib/services/scan-cache.js'
import type { FsPort } from '../lib/adapters/fs-adapter.js'
import { createNodeFsPort } from '../lib/adapters/fs-adapter.js'
import { createTempProject } from './support/temp-project.ts'

/** 统计真实文件系统调用次数，用来证明缓存真的没有再遍历磁盘。 */
function countingPort(counter: { calls: number }): FsPort {
  const real = createNodeFsPort()
  return {
    async listDirectory(dir) {
      counter.calls += 1
      return real.listDirectory(dir)
    },
  }
}

test('扫描缓存：相同参数命中且不重复读盘', async () => {
  const project = createTempProject({ 'src/a.py': 'x', 'src/b.py': 'y' })
  const counter = { calls: 0 }
  try {
    let clock = 1000
    const cache = createScanCache({ ttlMs: 10000, now: () => clock })
    const request = {
      root: project.root,
      limits: { maxDepth: 4, maxEntries: 100 },
      port: countingPort(counter),
    }
    const first = await cache.scan(request)
    assert.equal(first.cached, false)
    const callsAfterFirst = counter.calls
    assert.ok(callsAfterFirst >= 2)

    clock += 100
    const second = await cache.scan(request)
    assert.equal(second.cached, true)
    assert.equal(counter.calls, callsAfterFirst, '命中缓存时不应再访问文件系统')
    assert.equal(cache.size, 1)
  } finally {
    project.cleanup()
  }
})

test('扫描缓存：TTL 过期后重新扫描', async () => {
  const project = createTempProject({ 'a.py': 'x' })
  try {
    let clock = 0
    const cache = createScanCache({ ttlMs: 1000, now: () => clock })
    const request = { root: project.root, limits: { maxDepth: 2, maxEntries: 50 } }
    assert.equal((await cache.scan(request)).cached, false)
    clock += 999
    assert.equal((await cache.scan(request)).cached, true)
    clock += 2
    assert.equal((await cache.scan(request)).cached, false)
  } finally {
    project.cleanup()
  }
})

test('扫描缓存：根目录内容变化后失效', async () => {
  const project = createTempProject({ 'a.py': 'x' })
  try {
    const cache = createScanCache({ ttlMs: 60000 })
    const request = { root: project.root, limits: { maxDepth: 2, maxEntries: 50 } }
    const first = await cache.scan(request)
    assert.equal(first.stats.files, 1)

    project.write('b.py', 'y')
    const second = await cache.scan(request)
    assert.equal(second.cached, false, '根目录 mtime 变化后必须重新扫描')
    assert.equal(second.stats.files, 2)
  } finally {
    project.cleanup()
  }
})

test('扫描缓存：参数不同不共用条目', async () => {
  const project = createTempProject({ 'a.py': 'x' })
  try {
    const cache = createScanCache({ ttlMs: 60000 })
    const base = { root: project.root, limits: { maxDepth: 2, maxEntries: 50 } }
    assert.equal((await cache.scan(base)).cached, false)
    assert.equal((await cache.scan(base)).cached, true)
    assert.equal((await cache.scan({ ...base, filters: { includeHidden: true } })).cached, false)
    assert.equal((await cache.scan({ ...base, limits: { maxDepth: 3, maxEntries: 50 } })).cached, false)
    assert.equal(cache.size, 3)
  } finally {
    project.cleanup()
  }
})
