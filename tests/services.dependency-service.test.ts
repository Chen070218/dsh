import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeProjectDependencies } from '../lib/services/dependency-service.js'
import { createTempProject } from './support/temp-project.ts'

test('语言探测：纯 Python 项目走 Python 分析器', async () => {
  const project = createTempProject({ 'a.py': 'import b\n', 'b.py': 'x = 1\n' })
  try {
    const result = await analyzeProjectDependencies({ root: project.root, limits: { maxFiles: 20, maxFileBytes: 4096 } })
    assert.equal(result.report.language, 'python')
    assert.equal(result.detected.python, 2)
    assert.equal(result.detected.javascript, 0)
    assert.equal(result.mixedProject, false)
  } finally {
    project.cleanup()
  }
})

test('语言探测：纯 TS 项目走 JS 分析器', async () => {
  const project = createTempProject({ 'a.ts': "import './b'\n", 'b.ts': 'export const x = 1\n' })
  try {
    const result = await analyzeProjectDependencies({ root: project.root, limits: { maxFiles: 20, maxFileBytes: 4096 } })
    assert.equal(result.report.language, 'javascript')
    assert.equal(result.detected.javascript, 2)
  } finally {
    project.cleanup()
  }
})

test('语言探测：混合仓库取文件数多的一方，并标记 mixedProject', async () => {
  const project = createTempProject({
    'py/a.py': 'x = 1\n',
    'web/a.ts': 'export const a = 1\n',
    'web/b.ts': "import './a'\n",
    'web/c.ts': 'export const c = 1\n',
  })
  try {
    const result = await analyzeProjectDependencies({ root: project.root, limits: { maxFiles: 50, maxFileBytes: 4096 } })
    assert.equal(result.report.language, 'javascript')
    assert.equal(result.mixedProject, true)
    assert.deepEqual(result.detected, { python: 1, javascript: 3 })
  } finally {
    project.cleanup()
  }
})

test('语言探测：显式指定优先；该语言没有文件时退回另一方', async () => {
  const project = createTempProject({ 'a.py': 'x = 1\n' })
  try {
    const explicit = await analyzeProjectDependencies({
      root: project.root,
      limits: { maxFiles: 20, maxFileBytes: 4096 },
      language: 'python',
    })
    assert.equal(explicit.report.language, 'python')

    const fallback = await analyzeProjectDependencies({
      root: project.root,
      limits: { maxFiles: 20, maxFileBytes: 4096 },
      language: 'javascript',
    })
    assert.equal(fallback.report.language, 'python', 'JS 没有文件应退回 Python，而不是返回空报告')
  } finally {
    project.cleanup()
  }
})
