import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { createWorkspaceGuard } from '../lib/security/workspace-guard.js'
import { ErrorCode, ProjectOpsError } from '../lib/util/errors.js'
import { createTempProject } from './support/temp-project.ts'

function expectCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProjectOpsError, '应抛出 ProjectOpsError，实际: ' + String(error))
    assert.equal(error.code, code)
    return true
  }
}

test('工作区守卫：接受根目录内路径，拒绝越界路径', () => {
  const project = createTempProject({ 'src/main.py': 'print(1)' })
  try {
    const guard = createWorkspaceGuard({ roots: [project.root] })
    assert.equal(guard.roots.length, 1)

    const inside = guard.resolve('src', { expect: 'directory' })
    assert.equal(inside.absolutePath, project.path('src'))
    assert.equal(inside.root, project.root)

    const rootTarget = guard.resolve('.', { expect: 'directory' })
    assert.equal(rootTarget.absolutePath, project.root)

    const file = guard.resolve('src/main.py', { expect: 'file' })
    assert.equal(file.absolutePath, project.path('src/main.py'))

    assert.throws(() => guard.resolve('..'), expectCode(ErrorCode.PATH_OUTSIDE_WORKSPACE))
    assert.throws(
      () => guard.resolve('src/../../outside.txt'),
      expectCode(ErrorCode.PATH_OUTSIDE_WORKSPACE),
    )
    const outside = createTempProject({ 'secret.txt': 'x' })
    try {
      assert.throws(
        () => guard.resolve(outside.path('secret.txt')),
        expectCode(ErrorCode.PATH_OUTSIDE_WORKSPACE),
      )
    } finally {
      outside.cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test('工作区守卫：路径类型与存在性给出明确错误', () => {
  const project = createTempProject({ 'readme.md': '# hi' })
  try {
    const guard = createWorkspaceGuard({ roots: [project.root] })
    assert.throws(() => guard.resolve('missing.txt'), expectCode(ErrorCode.NOT_FOUND))
    assert.throws(
      () => guard.resolve('readme.md', { expect: 'directory' }),
      expectCode(ErrorCode.NOT_A_DIRECTORY),
    )
    assert.throws(
      () => guard.resolve('.', { expect: 'file' }),
      expectCode(ErrorCode.NOT_A_FILE),
    )
    assert.throws(() => guard.resolve(''), expectCode(ErrorCode.INVALID_PATH))

    // mustExist=false：允许尚不存在的目标（后续阶段要生成文档），但仍必须留在工作区内
    const future = guard.resolve('docs/architecture.md', { mustExist: false })
    assert.equal(future.absolutePath, project.path('docs/architecture.md'))
    assert.throws(
      () => guard.resolve('../escape.md', { mustExist: false }),
      expectCode(ErrorCode.PATH_OUTSIDE_WORKSPACE),
    )
  } finally {
    project.cleanup()
  }
})

test('工作区守卫：授权根目录本身必须存在且是目录', () => {
  const project = createTempProject({ 'file.txt': 'x' })
  try {
    assert.throws(() => createWorkspaceGuard({ roots: [] }), expectCode(ErrorCode.INVALID_PATH))
    assert.throws(
      () => createWorkspaceGuard({ roots: [project.path('nope')] }),
      expectCode(ErrorCode.NOT_FOUND),
    )
    assert.throws(
      () => createWorkspaceGuard({ roots: [project.path('file.txt')] }),
      expectCode(ErrorCode.NOT_A_DIRECTORY),
    )
  } finally {
    project.cleanup()
  }
})

test('工作区守卫：contains 不会把前缀相同的兄弟目录误判为内部', () => {
  const project = createTempProject({ 'keep.txt': 'x' })
  const sibling = createTempProject({ 'other.txt': 'x' })
  try {
    const guard = createWorkspaceGuard({ roots: [project.root] })
    assert.equal(guard.contains(project.path('keep.txt')), true)
    assert.equal(guard.contains(project.root + '-sibling'), false)
    assert.equal(guard.contains(sibling.root), false)
  } finally {
    project.cleanup()
    sibling.cleanup()
  }
})

test('工作区守卫：拒绝通过符号链接逃逸到工作区之外', (t) => {
  const project = createTempProject({ 'inner/keep.txt': 'x' })
  const outside = createTempProject({ 'secret.txt': 'x' })
  try {
    const linkPath = project.path('escape')
    try {
      symlinkSync(outside.root, linkPath, 'junction')
    } catch {
      t.skip('当前系统不允许创建目录联接，跳过该用例')
      return
    }
    const guard = createWorkspaceGuard({ roots: [project.root] })
    assert.throws(
      () => guard.resolve('escape', { expect: 'directory' }),
      expectCode(ErrorCode.PATH_OUTSIDE_WORKSPACE),
    )
    assert.throws(
      () => guard.resolve('escape/secret.txt'),
      expectCode(ErrorCode.PATH_OUTSIDE_WORKSPACE),
    )
  } finally {
    project.cleanup()
    outside.cleanup()
  }
})

test('工作区守卫：多个授权根目录都可访问', () => {
  const first = createTempProject({ 'a.txt': 'x' })
  const second = createTempProject({ 'b.txt': 'x' })
  try {
    const guard = createWorkspaceGuard({ roots: [first.root, second.root] })
    assert.equal(guard.roots.length, 2)
    assert.equal(guard.resolve(second.path('b.txt')).root, second.root)
    assert.equal(guard.resolve(first.path('a.txt')).root, first.root)
  } finally {
    first.cleanup()
    second.cleanup()
  }
})
