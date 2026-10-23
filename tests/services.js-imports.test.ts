import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsImports } from '../lib/services/js-imports.js'

test('JS 解析：静态导入、副作用导入、export from、import type', () => {
  const source = [
    "import { a, b } from './util'",
    "import type { T } from './types'",
    "import './polyfill'",
    "export { x } from './reexport'",
    "export * from './all'",
  ].join('\n')
  const imports = parseJsImports(source)
  assert.deepEqual(
    imports.map((item) => item.specifier),
    ['./util', './types', './polyfill', './reexport', './all'],
  )
  assert.ok(imports.every((item) => item.kind === 'static'))
})

test('JS 解析：动态 import() 与 require() 分开标记', () => {
  const source = ["const mod = await import('./lazy')", "const fs = require('node:fs')"].join('\n')
  const imports = parseJsImports(source)
  assert.deepEqual(
    imports.map((item) => [item.kind, item.specifier]),
    [
      ['dynamic', './lazy'],
      ['require', 'node:fs'],
    ],
  )
})

test('JS 解析：注释与字符串里的假导入不算依赖', () => {
  const source = [
    '// import fake from "./commented"',
    '/* import alsoFake from "./blocked" */',
    'const text = "import nope from ./string"',
    'import real from "./real"',
  ].join('\n')
  const imports = parseJsImports(source)
  assert.deepEqual(
    imports.map((item) => item.specifier),
    ['./real'],
  )
})

test('JS 解析：同一行重复匹配不会产生重复记录', () => {
  const imports = parseJsImports("import './only'\n")
  assert.equal(imports.length, 1)
})
