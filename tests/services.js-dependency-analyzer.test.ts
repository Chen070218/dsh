import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeJavaScriptDependencies,
  extractPathAliases,
  matchAlias,
  normalizeRelativePath,
  parseJsonc,
} from '../lib/services/js-dependency-analyzer.js'
import { createTempProject } from './support/temp-project.ts'

const FIXTURE = {
  'src/a.ts': "import { b } from './b'\nimport { c } from './nested/c'\n",
  'src/b.ts': "import { a } from './a'\n",
  'src/nested/c.ts': "import fs from 'node:fs'\nimport React from 'react'\nimport missing from './missing'\n",
  'src/components/index.ts': 'export const Button = 1\n',
  'src/app.ts': "import { Button } from './components'\nconst lazy = () => import('./nested/c')\n",
  'src/legacy.js': "const path = require('node:path')\n",
  'README.md': '# not code',
}

test('路径规整：消掉 ./ 与 ../', () => {
  assert.equal(normalizeRelativePath('src/./nested/../a.ts'), 'src/a.ts')
  assert.equal(normalizeRelativePath('../../../escape'), 'escape')
})

test('JS 分析：相对导入解析、目录 index、循环、外部依赖与未解析', async () => {
  const project = createTempProject(FIXTURE)
  try {
    const report = await analyzeJavaScriptDependencies({
      root: project.root,
      limits: { maxFiles: 100, maxFileBytes: 65536 },
    })

    assert.equal(report.language, 'javascript')
    assert.equal(report.stats.files, 6, '只统计 JS/TS 源码')

    const pairs = report.edges.map((edge) => edge.from + '->' + edge.to)
    assert.ok(pairs.includes('src/a->src/b'), '相对导入应解析到 src/b')
    assert.ok(pairs.includes('src/a->src/nested/c'))
    assert.ok(pairs.includes('src/app->src/components/index'), '目录导入应解析到 components/index.ts')

    assert.equal(report.cycles.length, 1)
    assert.deepEqual(report.cycles[0]?.modules, ['src/a', 'src/b'])

    const externalNames = report.external.map((item) => item.name)
    assert.ok(externalNames.includes('node:fs'))
    assert.ok(externalNames.includes('react'))
    assert.ok(externalNames.includes('node:path'))

    assert.ok(report.unresolved.some((item) => item.specifier === './missing'))

    assert.ok(report.modules.every((item) => !item.module.endsWith('.ts')), '模块名不带扩展名')
  } finally {
    project.cleanup()
  }
})

test('JS 分析：读取失败降级为告警', async () => {
  const project = createTempProject({ 'a.js': "require('./b')\n", 'b.js': 'module.exports = 1\n' })
  try {
    const reader = {
      async readTextFile(path: string) {
        if (path.endsWith('b.js')) {
          const error = new Error('boom') as Error & { code?: string }
          error.code = 'EACCES'
          throw error
        }
        return { text: "require('./b')\n", bytes: 17, truncated: false }
      },
    }
    const report = await analyzeJavaScriptDependencies({
      root: project.root,
      limits: { maxFiles: 10, maxFileBytes: 4096 },
      reader,
    })
    assert.ok(report.warnings.some((warning) => warning.includes('无法读取文件')))
    assert.equal(report.stats.modules, 2)
  } finally {
    project.cleanup()
  }
})

test('JS 分析：TS ESM 风格（import "./x.js"）能解析到 src/x.ts', async () => {
  const project = createTempProject({
    'src/x.ts': "import { y } from './y.js'\n",
    'src/y.ts': 'export const y = 1\n',
  })
  try {
    const report = await analyzeJavaScriptDependencies({ root: project.root, limits: { maxFiles: 20, maxFileBytes: 4096 } })
    const pairs = report.edges.map((edge) => edge.from + '->' + edge.to)
    assert.deepEqual(pairs, ['src/x->src/y'])
    assert.deepEqual(report.unresolved, [], '带扩展名的相对导入不应进入 unresolved')
  } finally {
    project.cleanup()
  }
})

test('JSONC 与别名：解析 tsconfig paths（含注释、尾逗号、通配符优先级）', () => {
  const config = parseJsonc(`
    {
      // 注释要能容忍
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@app/*": ["src/*"],
          "@app/lib": ["src/lib/index.ts"],
        },
      },
    }
  `)
  const rules = extractPathAliases(config)
  assert.equal(rules.length, 2)
  assert.deepEqual(matchAlias(rules, '@app/lib'), [normalizeRelativePath('src/lib/index.ts')], '精确别名优先')
  assert.deepEqual(matchAlias(rules, '@app/utils'), [normalizeRelativePath('src/utils')])
  assert.deepEqual(matchAlias(rules, 'react'), [])
})

test('JS 分析：tsconfig 别名能解析成项目内依赖（kind=absolute）', async () => {
  const project = createTempProject({
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } } }',
    'src/main.ts': "import { x } from '@app/lib'\nimport { y } from '@app/missing'\nimport React from 'react'\n",
    'src/lib.ts': 'export const x = 1\n',
  })
  try {
    const report = await analyzeJavaScriptDependencies({ root: project.root, limits: { maxFiles: 20, maxFileBytes: 8192 } })
    const aliasEdge = report.edges.find((edge) => edge.from === 'src/main' && edge.to === 'src/lib')
    assert.ok(aliasEdge, '别名应解析到 src/lib')
    assert.equal(aliasEdge?.kind, 'absolute')
    assert.ok(report.unresolved.some((item) => item.specifier === '@app/missing'), '命中别名但文件不存在应记为 unresolved')
    assert.ok(report.external.some((item) => item.name === 'react'))
    assert.ok(!report.external.some((item) => item.name.startsWith('@app/')), '别名不能算外部依赖')
  } finally {
    project.cleanup()
  }
})

test('JS 分析：monorepo 跨包引用解析为项目内依赖（workspace）', async () => {
  const project = createTempProject({
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'packages/app/package.json': JSON.stringify({ name: '@demo/app', main: 'src/index.ts' }),
    'packages/app/src/index.ts': "import { util } from '@demo/lib'\nimport ext from 'left-pad'\n",
    'packages/lib/package.json': JSON.stringify({ name: '@demo/lib', main: 'src/index.ts' }),
    'packages/lib/src/index.ts': 'export const util = 1\n',
  })
  try {
    const report = await analyzeJavaScriptDependencies({ root: project.root, limits: { maxFiles: 50, maxFileBytes: 8192 } })
    const edge = report.edges.find((item) => item.from === 'packages/app/src/index' && item.to === 'packages/lib/src/index')
    assert.ok(edge, '跨包引用应解析为项目内边：' + JSON.stringify(report.edges))
    assert.equal(edge?.kind, 'absolute')
    assert.ok(report.external.some((item) => item.name === 'left-pad'), '真正的外部包仍算 external')
    assert.ok(!report.external.some((item) => item.name === '@demo/lib'), '工作区包不能算外部依赖')
  } finally {
    project.cleanup()
  }
})
