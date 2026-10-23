import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { createDocTools, DOC_TOOL_NAMES } from '../lib/tools/doc-tools.js'
import { createLogger } from '../lib/util/logger.js'
import { createTempProject } from './support/temp-project.ts'

function buildTools(allowedRoots: string[]) {
  const tools = createDocTools({
    defaults: {
      allowedRoots,
      maxDepth: 5,
      maxEntries: 500,
      includeHidden: false,
      extraExcludes: [],
      maxFiles: 200,
      maxFileBytes: 65536,
    },
    logger: createLogger({ sink: () => {}, level: 'error' }),
  })
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function fakeExec(cwd: string) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } }
}

test('文档工具：两个工具都注册且 schema 合法', () => {
  const tools = buildTools([])
  assert.deepEqual([...tools.keys()], [DOC_TOOL_NAMES.architecture, DOC_TOOL_NAMES.readme])
  for (const tool of tools.values()) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), tool.name + ' 的 schema 非法')
  }
})

test('架构报告工具：默认 dry-run 不写盘，确认后才写入', async () => {
  const project = createTempProject({ 'app/main.py': 'from app import util\n', 'app/util.py': 'x = 1\n' })
  try {
    const tool = buildTools([project.root]).get(DOC_TOOL_NAMES.architecture)!
    const dry = await tool.execute({}, fakeExec(project.root))
    assert.equal(dry.written, false)
    assert.equal(dry.dryRun, true)
    assert.ok(dry.target.includes('docs') && dry.target.includes('architecture.md'))
    assert.equal(existsSync(dry.target), false)

    const real = await tool.execute({ dryRun: false }, fakeExec(project.root))
    assert.equal(real.written, true)
    const content = readFileSync(real.target, 'utf8')
    assert.ok(content.includes('# '))
    assert.ok(content.includes('项目概览'))

    const again = await tool.execute({ dryRun: false }, fakeExec(project.root))
    assert.equal(again.written, false, '已有文件默认不覆盖')
    assert.ok(again.skippedReason.includes('已存在'))
  } finally {
    project.cleanup()
  }
})

test('README 工具：默认产出 README.generated.md，不碰已有 README.md', async () => {
  const project = createTempProject({ 'README.md': '# 用户自己的 README\n', 'main.py': 'x = 1\n' })
  try {
    const tool = buildTools([project.root]).get(DOC_TOOL_NAMES.readme)!
    const result = await tool.execute({ dryRun: false, projectName: 'demo' }, fakeExec(project.root))
    assert.equal(result.written, true)
    assert.ok(result.target.includes('README.generated.md'))
    assert.equal(readFileSync(project.path('README.md'), 'utf8'), '# 用户自己的 README\n', '不能覆盖用户原有 README')
    assert.ok(readFileSync(result.target, 'utf8').includes('# demo'))
  } finally {
    project.cleanup()
  }
})

test('文档工具：输出路径越界被拒绝', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  try {
    const tool = buildTools([project.root]).get(DOC_TOOL_NAMES.architecture)!
    await assert.rejects(
      () => tool.execute({ outputPath: '../outside.md', dryRun: false, overwrite: true }, fakeExec(project.root)),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PATH_OUTSIDE_WORKSPACE')
        return true
      },
    )
  } finally {
    project.cleanup()
  }
})
