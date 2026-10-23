import test from 'node:test'
import assert from 'node:assert/strict'
import { scanProject } from '../lib/services/project-scanner.js'
import { createNodeFsPort } from '../lib/adapters/fs-adapter.js'
import type { FsPort } from '../lib/adapters/fs-adapter.js'
import { createTempProject } from './support/temp-project.ts'
import { createCapturingLogger } from './support/test-logger.ts'

const FIXTURE = {
  'src/main.py': 'print(1)',
  'src/pkg/util.py': 'x = 1',
  'README.md': '# demo',
  '.env': 'SECRET=should-never-leak',
  'config/.env.local': 'TOKEN=should-never-leak',
  'node_modules/dep/index.js': 'module.exports = {}',
  '.git/config': '[core]',
  'dist/bundle.js': 'x',
}

test('扫描：目录树排除缓存/产物，敏感文件不计入也不展示', async () => {
  const project = createTempProject(FIXTURE)
  try {
    const result = await scanProject({ root: project.root, limits: { maxDepth: 6, maxEntries: 5000 } })
    const tree = result.tree.join('\n')
    assert.ok(tree.includes('src/'), '应包含 src 目录')
    assert.ok(tree.includes('main.py'))
    assert.ok(!tree.includes('node_modules'), 'node_modules 必须被排除')
    assert.ok(!tree.includes('.git'), '.git 必须被排除')
    assert.ok(!tree.includes('dist'), 'dist 必须被排除')
    assert.ok(!tree.includes('.env'), '.env 必须完全不出现在输出中')

    assert.equal(result.stats.files, 3)
    assert.equal(result.stats.skippedSensitive, 2)
    assert.equal(result.truncated, false)
    assert.equal(result.detection.primaryLanguage, 'Python')

    const python = result.stats.byExtension.find((item) => item.extension === '.py')
    assert.equal(python?.count, 2)

    const serialized = JSON.stringify(result)
    assert.ok(!serialized.includes('should-never-leak'), '扫描结果不能包含敏感文件内容')
  } finally {
    project.cleanup()
  }
})

test('扫描：maxDepth 限制生效并给出告警', async () => {
  const project = createTempProject({ 'a/b/c/file.txt': 'x' })
  try {
    const result = await scanProject({ root: project.root, limits: { maxDepth: 1, maxEntries: 5000 } })
    assert.equal(result.tree.length, 2, '只应输出根目录和一层子目录')
    assert.ok(result.tree[1]?.includes('a/'))
    assert.ok(result.warnings.some((warning) => warning.includes('深度')))
  } finally {
    project.cleanup()
  }
})

test('扫描：maxEntries 限制生效并标记 truncated', async () => {
  const project = createTempProject({ 'a.txt': 'x', 'b.txt': 'x', 'c.txt': 'x' })
  try {
    const result = await scanProject({ root: project.root, limits: { maxDepth: 4, maxEntries: 1 } })
    assert.equal(result.truncated, true)
    assert.equal(result.stats.files, 1)
    assert.ok(result.warnings.some((warning) => warning.includes('上限')))
  } finally {
    project.cleanup()
  }
})

test('扫描：单个目录读取失败不影响整体结果', async () => {
  const project = createTempProject({ 'ok/keep.py': 'x', 'broken/inside.py': 'x' })
  const realPort = createNodeFsPort()
  const failingPort: FsPort = {
    async listDirectory(dir) {
      if (dir.endsWith('broken')) {
        const error = new Error('denied by test stub') as Error & { code?: string }
        error.code = 'EACCES'
        throw error
      }
      return realPort.listDirectory(dir)
    },
  }
  try {
    const result = await scanProject({
      root: project.root,
      limits: { maxDepth: 4, maxEntries: 5000 },
      port: failingPort,
    })
    assert.equal(result.stats.files, 1, '只有可读目录里的文件被统计')
    assert.ok(result.warnings.some((warning) => warning.includes('broken')))
    assert.ok(result.warnings.some((warning) => warning.includes('权限')))
  } finally {
    project.cleanup()
  }
})

test('扫描：日志记录完成事件且不写入文件内容', async () => {
  const project = createTempProject({ 'a.py': 'print(1)' })
  const capturing = createCapturingLogger()
  try {
    await scanProject({
      root: project.root,
      limits: { maxDepth: 4, maxEntries: 100 },
      logger: capturing.logger,
    })
    const events = capturing.records.map((record) => record.event)
    assert.ok(events.includes('scan/complete'))
    assert.ok(!JSON.stringify(capturing.records).includes('print(1)'))
  } finally {
    project.cleanup()
  }
})

test('扫描：默认跳过隐藏项，includeHidden 打开后计入', async () => {
  const project = createTempProject({
    '.github/workflows/ci.yml': 'name: ci',
    '.eslintrc.json': '{}',
    'src/a.py': 'x = 1',
  })
  try {
    const hiddenOff = await scanProject({ root: project.root, limits: { maxDepth: 4, maxEntries: 500 } })
    assert.equal(hiddenOff.stats.files, 1)
    assert.equal(hiddenOff.stats.skippedHidden, 2)
    assert.ok(!hiddenOff.tree.join('\n').includes('.github'))

    const hiddenOn = await scanProject({
      root: project.root,
      limits: { maxDepth: 4, maxEntries: 500 },
      filters: { includeHidden: true },
    })
    assert.equal(hiddenOn.stats.files, 3)
    assert.equal(hiddenOn.stats.skippedHidden, 0)
    assert.ok(hiddenOn.tree.join('\n').includes('.github/'))
  } finally {
    project.cleanup()
  }
})

test('扫描：extraExcludes 过滤自定义目录（大小写不敏感）', async () => {
  const project = createTempProject({
    'Fixtures/data.py': 'x = 1',
    'src/a.py': 'x = 1',
  })
  try {
    const result = await scanProject({
      root: project.root,
      limits: { maxDepth: 4, maxEntries: 500 },
      filters: { extraExcludes: ['fixtures'] },
    })
    assert.equal(result.stats.files, 1)
    assert.ok(!result.tree.join('\n').includes('Fixtures'))
  } finally {
    project.cleanup()
  }
})

test('扫描：directorySummary 聚合顶层目录的文件数与体积', async () => {
  const project = createTempProject({
    'alpha/a.py': 'x'.repeat(10),
    'alpha/b.py': 'y'.repeat(20),
    'beta/c.py': 'z'.repeat(5),
    'root.py': 'w'.repeat(3),
  })
  try {
    const result = await scanProject({ root: project.root, limits: { maxDepth: 4, maxEntries: 500 } })
    const alpha = result.directorySummary.find((item) => item.path === 'alpha')
    const beta = result.directorySummary.find((item) => item.path === 'beta')
    assert.equal(alpha?.files, 2)
    assert.equal(alpha?.bytes, 30)
    assert.equal(beta?.files, 1)
    assert.equal(result.directorySummary[0]?.path, 'alpha', '按体积倒序')
    assert.ok(!result.directorySummary.some((item) => item.path === 'root.py'), '根目录下的文件不进入目录汇总')
  } finally {
    project.cleanup()
  }
})
