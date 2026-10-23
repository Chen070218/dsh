import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeDocument } from '../lib/adapters/doc-writer.js'
import { ErrorCode, ProjectOpsError } from '../lib/util/errors.js'
import { createTempProject } from './support/temp-project.ts'

test('文档写入：dry-run 不落盘但给出计划与预览', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  try {
    const result = await writeDocument({
      roots: [project.root],
      root: project.root,
      relativePath: 'docs/architecture.md',
      content: '# 标题\n\n正文',
      dryRun: true,
      overwrite: false,
    })
    assert.equal(result.written, false)
    assert.ok(result.skippedReason.includes('dry-run'))
    assert.equal(existsSync(result.target), false, 'dry-run 不能创建文件')
    assert.ok(result.plan.some((line) => line.includes('dry-run')))
    assert.ok(result.preview.startsWith('# 标题'))
  } finally {
    project.cleanup()
  }
})

test('文档写入：真正写入会创建目录并用原子替换', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  try {
    const result = await writeDocument({
      roots: [project.root],
      root: project.root,
      relativePath: 'docs/architecture.md',
      content: '# 架构\n',
      dryRun: false,
      overwrite: false,
    })
    assert.equal(result.written, true)
    assert.equal(readFileSync(project.path('docs/architecture.md'), 'utf8'), '# 架构\n')
  } finally {
    project.cleanup()
  }
})

test('文档写入：默认不覆盖已有文件，显式授权后才覆盖', async () => {
  const project = createTempProject({ 'docs/architecture.md': '# 用户原有内容\n' })
  try {
    const refused = await writeDocument({
      roots: [project.root],
      root: project.root,
      relativePath: 'docs/architecture.md',
      content: '# 覆盖尝试\n',
      dryRun: false,
      overwrite: false,
    })
    assert.equal(refused.written, false)
    assert.ok(refused.skippedReason.includes('已存在'))
    assert.equal(readFileSync(project.path('docs/architecture.md'), 'utf8'), '# 用户原有内容\n')

    const replaced = await writeDocument({
      roots: [project.root],
      root: project.root,
      relativePath: 'docs/architecture.md',
      content: '# 覆盖尝试\n',
      dryRun: false,
      overwrite: true,
    })
    assert.equal(replaced.written, true)
    assert.equal(readFileSync(project.path('docs/architecture.md'), 'utf8'), '# 覆盖尝试\n')
  } finally {
    project.cleanup()
  }
})

test('文档写入：越界路径被拒绝', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  try {
    await assert.rejects(
      () =>
        writeDocument({
          roots: [project.root],
          root: project.root,
          relativePath: '../escape.md',
          content: 'x',
          dryRun: false,
          overwrite: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProjectOpsError)
        assert.equal(error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE)
        return true
      },
    )
  } finally {
    project.cleanup()
  }
})
