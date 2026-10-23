import test from 'node:test'
import assert from 'node:assert/strict'
import { parseImports } from '../lib/services/python-imports.js'

test('解析：普通 import 与 from-import', () => {
  const imports = parseImports('import os, sys\nfrom pkg.sub import (a, b as c)\n')
  assert.equal(imports.length, 3)
  assert.deepEqual(
    imports.map((item) => [item.kind, item.level, item.module, item.names.join('|')]),
    [
      ['import', 0, 'os', ''],
      ['import', 0, 'sys', ''],
      ['from', 0, 'pkg.sub', 'a|b'],
    ],
  )
})

test('解析：相对导入的层级', () => {
  const imports = parseImports('from . import sibling\nfrom ..pkg import thing\nfrom .a import helper\n')
  assert.deepEqual(
    imports.map((item) => [item.level, item.module, item.names.join('|')]),
    [
      [1, '', 'sibling'],
      [2, 'pkg', 'thing'],
      [1, 'a', 'helper'],
    ],
  )
})

test('解析：注释、字符串与三引号块里的假 import 不算依赖', () => {
  const source = [
    '# import notreal',
    'DOC = """',
    'import alsofake',
    '"""',
    'text = "import nope"',
    'from real.module import keeper  # trailing comment',
  ].join('\n')
  const imports = parseImports(source)
  assert.equal(imports.length, 1)
  assert.equal(imports[0]?.module, 'real.module')
  assert.deepEqual(imports[0]?.names, ['keeper'])
})

test('解析：括号跨行的 from-import 会被合并', () => {
  const source = ['from big.pkg import (', '    first,', '    second,', ')'].join('\n')
  const imports = parseImports(source)
  assert.equal(imports.length, 1)
  assert.equal(imports[0]?.module, 'big.pkg')
  assert.deepEqual(imports[0]?.names, ['first', 'second'])
})

test('解析：记录行号且忽略非导入语句', () => {
  const imports = parseImports('x = 1\nimport late\nprint(x)\n')
  assert.equal(imports.length, 1)
  assert.equal(imports[0]?.line, 2)
})

test('解析：顶层导入记 module，函数/条件体内导入记 nested', () => {
  const source = [
    'import top_module',
    '',
    'def load():',
    '    import inside_function',
    '',
    'try:',
    '    from optional.pkg import thing',
    'except ImportError:',
    '    thing = None',
  ].join('\n')
  const imports = parseImports(source)
  assert.deepEqual(
    imports.map((item) => [item.module, item.scope]),
    [
      ['top_module', 'module'],
      ['inside_function', 'nested'],
      ['optional.pkg', 'nested'],
    ],
  )
})
