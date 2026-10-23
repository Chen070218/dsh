import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeDependencies, findCycles, moduleNameOf } from '../lib/services/dependency-analyzer.js'
import { renderDependencyGraph } from '../lib/services/mermaid-renderer.js'
import { createTempProject } from './support/temp-project.ts'

const PY_FIXTURE = {
  'main.py': 'import os\nfrom pkg import a\n',
  'pkg/__init__.py': '',
  'pkg/a.py': 'from . import b\nimport pkg.c\n',
  'pkg/b.py': 'from .a import helper\n',
  'pkg/c.py': 'from ..outside import nope\n',
  'pkg/util.py': 'import json\nimport os\n',
  'pkg/notes.md': 'not python',
}

test('模块名：__init__.py 归到包，根级记为 __root__', () => {
  assert.equal(moduleNameOf('pkg/__init__.py'), 'pkg')
  assert.equal(moduleNameOf('__init__.py'), '__root__')
  assert.equal(moduleNameOf('pkg/a.py'), 'pkg.a')
  assert.equal(moduleNameOf('a/b/c.pyi'), 'a.b.c')
})

test('循环检测：强连通分量与自环', () => {
  const adjacency = new Map<string, string[]>([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
    ['d', ['d']],
    ['e', []],
  ])
  const cycles = findCycles(['a', 'b', 'c', 'd', 'e'], adjacency)
  assert.deepEqual(cycles, [['a', 'b', 'c'], ['d']])
})

test('分析：识别项目内依赖边、循环依赖、外部依赖与不可解析导入', async () => {
  const project = createTempProject(PY_FIXTURE)
  try {
    const report = await analyzeDependencies({
      root: project.root,
      limits: { maxFiles: 100, maxFileBytes: 65536 },
    })

    assert.equal(report.stats.files, 6, '只统计 .py 文件')
    assert.ok(report.modules.some((item) => item.module === 'pkg.a' && item.path === 'pkg/a.py'))
    assert.ok(report.modules.some((item) => item.module === '__root__' || item.module === 'main'), 'main.py 应进入模块表')

    const edgePairs = report.edges.map((edge) => edge.from + '->' + edge.to)
    assert.ok(edgePairs.includes('pkg.a->pkg.b'), '相对导入 from . import b 应解析到 pkg.b')
    assert.ok(edgePairs.includes('pkg.b->pkg.a'), 'from .a import helper 应解析到 pkg.a')
    assert.ok(edgePairs.includes('pkg.a->pkg.c'), 'import pkg.c 应解析到 pkg.c')
    assert.ok(edgePairs.some((pair) => pair.startsWith('main->pkg.a')), 'from pkg import a 应解析到 pkg.a')

    assert.equal(report.cycles.length, 1)
    assert.deepEqual(report.cycles[0]?.modules, ['pkg.a', 'pkg.b'])

    const externalNames = report.external.map((item) => item.name)
    assert.ok(externalNames.includes('os'))
    assert.ok(externalNames.includes('json'))

    assert.ok(report.unresolved.length >= 1, '越界的相对导入应进入 unresolved')
    assert.ok(report.unresolved.some((item) => item.specifier.includes('outside')))

    const rendered = renderDependencyGraph(report)
    assert.ok(rendered.mermaid.startsWith('graph TD'))
    assert.ok(rendered.mermaid.includes('pkg.a'))
    assert.ok(rendered.mermaid.includes('classDef cycle'))
    assert.ok(rendered.mermaid.includes('-->'))
  } finally {
    project.cleanup()
  }
})

test('分析：文件读取失败只降级为告警', async () => {
  const project = createTempProject({ 'a.py': 'import b\n', 'b.py': 'x = 1\n' })
  try {
    const reader = {
      async readTextFile(path: string) {
        if (path.endsWith('b.py')) {
          const error = new Error('boom') as Error & { code?: string }
          error.code = 'EACCES'
          throw error
        }
        return { text: 'import b\n', bytes: 9, truncated: false }
      },
    }
    const report = await analyzeDependencies({
      root: project.root,
      limits: { maxFiles: 10, maxFileBytes: 4096 },
      reader,
    })
    assert.ok(report.warnings.some((warning) => warning.includes('无法读取文件')))
    assert.equal(report.stats.modules, 2, '模块表仍然包含无法读取的文件')
    const pairs = report.edges.map((edge) => edge.from + '->' + edge.to)
    assert.deepEqual(pairs, ['a->b'], '可读文件照常解析；不可读文件不产生出边')
  } finally {
    project.cleanup()
  }
})

test('分析：文件数上限产生 truncated', async () => {
  const project = createTempProject({ 'a.py': '', 'b.py': '', 'c.py': '' })
  try {
    const report = await analyzeDependencies({ root: project.root, limits: { maxFiles: 2, maxFileBytes: 4096 } })
    assert.equal(report.truncated, true)
    assert.equal(report.stats.files, 2)
  } finally {
    project.cleanup()
  }
})
