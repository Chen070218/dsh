import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { createScanProjectTool, SCAN_PROJECT_TOOL_NAME } from '../lib/tools/scan-project.js'
import { createScanCache } from '../lib/services/scan-cache.js'
import { resolveConfig } from '../lib/index.js'
import { ErrorCode, ProjectOpsError } from '../lib/util/errors.js'
import { createTempProject } from './support/temp-project.ts'
import { createCapturingLogger } from './support/test-logger.ts'

interface ToolOverrides {
  maxDepth?: number
  maxEntries?: number
  includeHidden?: boolean
  extraExcludes?: string[]
}

function createTool(allowedRoots: string[], overrides: ToolOverrides = {}) {
  const logger = createCapturingLogger().logger
  const cache = createScanCache({ ttlMs: 30000 })
  return createScanProjectTool({
    defaults: {
      allowedRoots,
      maxDepth: overrides.maxDepth ?? 4,
      maxEntries: overrides.maxEntries ?? 5000,
      includeHidden: overrides.includeHidden ?? false,
      extraExcludes: overrides.extraExcludes ?? [],
    },
    cache,
    logger,
  })
}

function fakeExec(cwd?: string) {
  return {
    signal: new AbortController().signal,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

test('工具定义：名称、参数与输出 schema 合法', () => {
  const tool = createTool([])
  assert.equal(tool.name, SCAN_PROJECT_TOOL_NAME)
  assert.equal(tool.parameters.type, 'object')
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
  for (const key of ['path', 'maxDepth', 'maxEntries', 'includeHidden', 'includeTree']) {
    assert.ok(key in properties, '缺少参数 ' + key)
  }
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema))
})

test('工具执行：扫描会话工作区并返回结构化结果', async () => {
  const project = createTempProject({ 'app/main.py': 'print(1)', 'pyproject.toml': '[project]' })
  try {
    const tool = createTool([project.root])
    const output = await tool.execute({ path: '.' }, fakeExec(project.root))
    assert.equal(output.root, project.root)
    assert.equal(output.detection.primaryLanguage, 'Python')
    assert.equal(output.stats.files, 2)
    assert.ok(output.tree.length > 0)
    assert.ok(output.authorizedRoots.includes(project.root))
    assert.equal(output.truncated, false)
    assert.equal(output.cached, false)
    const appSummary = output.directorySummary.find((item) => item.path === 'app')
    assert.equal(appSummary?.files, 1)
  } finally {
    project.cleanup()
  }
})

test('工具执行：相同参数第二次命中扫描缓存', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  try {
    const tool = createTool([project.root])
    const first = await tool.execute({ path: '.' }, fakeExec(project.root))
    const second = await tool.execute({ path: '.' }, fakeExec(project.root))
    assert.equal(first.cached, false)
    assert.equal(second.cached, true, '相同参数的重复扫描应命中缓存')
    assert.equal(second.stats.files, first.stats.files)
  } finally {
    project.cleanup()
  }
})

test('工具执行：includeTree=false 时不返回目录树', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  try {
    const tool = createTool([project.root])
    const output = await tool.execute({ includeTree: false }, fakeExec(project.root))
    assert.deepEqual(output.tree, [])
    assert.equal(output.stats.files, 1)
  } finally {
    project.cleanup()
  }
})

test('工具执行：includeHidden 与 extraExcludes 生效', async () => {
  const project = createTempProject({
    '.github/workflows/ci.yml': 'name: ci',
    'fixtures/data.py': 'x = 1',
    'src/a.py': 'print(1)',
  })
  try {
    const defaults = await createTool([project.root]).execute({}, fakeExec(project.root))
    assert.equal(defaults.stats.files, 2, '默认跳过隐藏目录，只统计 fixtures 与 src')
    assert.equal(defaults.stats.skippedHidden, 1)

    const hidden = await createTool([project.root], { includeHidden: true }).execute({}, fakeExec(project.root))
    assert.equal(hidden.stats.files, 3)
    assert.equal(hidden.stats.skippedHidden, 0)

    const excluded = await createTool([project.root], { extraExcludes: ['fixtures'] }).execute({}, fakeExec(project.root))
    assert.equal(excluded.stats.files, 1)
    assert.ok(!excluded.tree.join('\n').includes('fixtures'))
  } finally {
    project.cleanup()
  }
})

test('工具执行：拒绝工作区之外的路径', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  const outside = createTempProject({ 'secret.txt': 'x' })
  try {
    const tool = createTool([project.root])
    await assert.rejects(
      () => tool.execute({ path: outside.root }, fakeExec(project.root)),
      (error: unknown) => {
        assert.ok(error instanceof ProjectOpsError)
        assert.equal(error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE)
        return true
      },
    )
    await assert.rejects(
      () => tool.execute({ path: '..' }, fakeExec(project.root)),
      (error: unknown) => {
        assert.ok(error instanceof ProjectOpsError)
        assert.equal(error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE)
        return true
      },
    )
  } finally {
    project.cleanup()
    outside.cleanup()
  }
})

test('插件配置：缺省值、过滤项与非法值', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.maxDepth, 6)
  assert.equal(resolved.maxEntries, 5000)
  assert.equal(resolved.includeHidden, false)
  assert.deepEqual(resolved.extraExcludes, [])
  assert.equal(resolved.cacheTtlMs, 30000)
  assert.equal(resolved.logLevel, 'info')
  assert.equal(resolved.logToConsole, false)
  assert.deepEqual(resolved.allowedRoots, [])

  const custom = resolveConfig({
    allowedRoots: ['  ', 'C:/work'],
    maxDepth: 3,
    includeHidden: true,
    extraExcludes: ['', 'fixtures'],
    cacheTtlMs: 0,
    logLevel: 'debug',
  })
  assert.deepEqual(custom.allowedRoots, ['C:/work'])
  assert.equal(custom.maxDepth, 3)
  assert.equal(custom.includeHidden, true)
  assert.deepEqual(custom.extraExcludes, ['fixtures'])
  assert.equal(custom.cacheTtlMs, 0)

  assert.throws(() => resolveConfig({ maxDepth: 0 }))
})
