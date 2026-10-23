import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { analyzeDependenciesToolFixture } from './support/analyze-fixture.ts'
import { createTempProject } from './support/temp-project.ts'
import { ErrorCode, ProjectOpsError } from '../lib/util/errors.js'

test('工具定义：参数与输出 schema 合法', () => {
  const tool = analyzeDependenciesToolFixture()
  assert.equal(tool.name, 'analyze_dependencies')
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties
  for (const key of ['path', 'maxFiles', 'maxFileBytes', 'includeMermaid', 'includeExternal']) {
    assert.ok(key in properties, '缺少参数 ' + key)
  }
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema))
})

test('工具执行：返回依赖边、循环与 Mermaid', async () => {
  const project = createTempProject({
    'main.py': 'from pkg import a\n',
    'pkg/__init__.py': '',
    'pkg/a.py': 'from . import b\n',
    'pkg/b.py': 'from .a import thing\n',
  })
  try {
    const tool = analyzeDependenciesToolFixture([project.root])
    const output = await tool.execute({}, { signal: new AbortController().signal, agent: undefined })
    assert.equal(output.root, project.root)
    assert.equal(output.stats.files, 4)
    assert.equal(output.cycles.length, 1)
    assert.deepEqual(output.cycles[0]?.modules, ['pkg.a', 'pkg.b'])
    assert.equal(output.language, 'python')
    assert.deepEqual(output.detected, { python: 4, javascript: 0 })
    assert.ok(output.mermaid.includes('graph TD'))
    assert.ok(output.edges.length >= 2)
  } finally {
    project.cleanup()
  }
})

test('工具执行：includeMermaid / includeExternal 可关闭', async () => {
  const project = createTempProject({ 'a.py': 'import os\n' })
  try {
    const tool = analyzeDependenciesToolFixture([project.root])
    const output = await tool.execute(
      { includeMermaid: false, includeExternal: false },
      { signal: new AbortController().signal, agent: undefined },
    )
    assert.equal(output.mermaid, '')
    assert.deepEqual(output.external, [])
    assert.equal(output.stats.files, 1)
  } finally {
    project.cleanup()
  }
})

test('工具执行：越界路径被拒绝', async () => {
  const project = createTempProject({ 'a.py': 'x = 1\n' })
  const outside = createTempProject({ 'b.py': 'y = 1\n' })
  try {
    const tool = analyzeDependenciesToolFixture([project.root])
    await assert.rejects(
      () => tool.execute({ path: outside.root }, { signal: new AbortController().signal, agent: undefined }),
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
