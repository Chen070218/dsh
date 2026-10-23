import test from 'node:test'
import assert from 'node:assert/strict'
import { scanProject } from '../lib/services/project-scanner.js'
import { analyzeDependencies } from '../lib/services/dependency-analyzer.js'
import { generateArchitectureReport, generateReadmeDraft } from '../lib/services/report-generator.js'
import { createTempProject } from './support/temp-project.ts'

const FIXTURE = {
  'package.json': '{"name":"demo"}',
  'pyproject.toml': '[project]',
  'src/a.py': 'from src import b\n',
  'src/b.py': 'from src import a\n',
  'src/c.py': 'from ..nowhere import thing\n',
}

test('报告：包含全部章节，并区分确认结论与启发式观察', async () => {
  const project = createTempProject(FIXTURE)
  try {
    const scan = await scanProject({ root: project.root, limits: { maxDepth: 5, maxEntries: 500 } })
    const dependencies = await analyzeDependencies({ root: project.root, limits: { maxFiles: 100, maxFileBytes: 65536 } })
    const report = generateArchitectureReport({ scan, dependencies, projectName: 'demo', generatedAt: '2026-01-01T00:00:00.000Z' })

    for (const section of ['项目概览', '目录结构', '模块与职责', '依赖关系', '已确认的问题', '启发式观察', '改进建议', '附录']) {
      assert.ok(report.sections.includes(section), '缺少章节: ' + section)
      assert.ok(report.markdown.includes(section), '正文缺少章节: ' + section)
    }
    assert.ok(report.markdown.startsWith('# demo 架构说明'))
    assert.ok(report.markdown.includes('2026-01-01T00:00:00.000Z'), '应写入生成时间')
    assert.ok(report.markdown.includes('src/a'), '依赖表应包含模块名')

    const confirmed = report.findings.filter((finding) => finding.kind === 'confirmed').map((finding) => finding.message)
    assert.ok(confirmed.some((message) => message.includes('循环依赖')), '循环依赖应作为确认结论')

    const heuristic = report.findings.filter((finding) => finding.kind === 'heuristic').map((finding) => finding.message)
    assert.ok(Array.isArray(heuristic), '启发式观察是独立列表')

    assert.ok(report.markdown.includes(String.fromCharCode(96, 96, 96) + 'mermaid'), '应包含 Mermaid 代码块')
    assert.ok(report.markdown.includes('graph TD'))
  } finally {
    project.cleanup()
  }
})

test('报告：没有依赖分析时明确说明而不是编结论', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  try {
    const scan = await scanProject({ root: project.root, limits: { maxDepth: 3, maxEntries: 100 } })
    const report = generateArchitectureReport({ scan, projectName: 'solo' })
    assert.ok(report.markdown.includes('未执行依赖分析'))
    assert.equal(report.findings.filter((finding) => finding.kind === 'confirmed').length, 0)
  } finally {
    project.cleanup()
  }
})

test('README 初稿：包含标题、结构与入口信息', async () => {
  const project = createTempProject({ 'package.json': '{}', 'src/index.ts': 'export {}', 'src/util.ts': 'export {}' })
  try {
    const scan = await scanProject({ root: project.root, limits: { maxDepth: 4, maxEntries: 200 } })
    const markdown = generateReadmeDraft({ scan, projectName: 'demo-app', description: '示例项目' })
    assert.ok(markdown.startsWith('# demo-app'))
    assert.ok(markdown.includes('示例项目'))
    assert.ok(markdown.includes('## 项目结构'))
    assert.ok(markdown.includes('src/index.ts'))
    assert.ok(markdown.includes('## License'))
  } finally {
    project.cleanup()
  }
})

test('启发式：极小项目不因两个外部依赖各被引用一次就报「集中度高」', async () => {
  const project = createTempProject({ 'a.py': 'import os\nimport json\n', 'b.py': 'import os\n' })
  try {
    const scan = await scanProject({ root: project.root, limits: { maxDepth: 3, maxEntries: 100 } })
    const dependencies = await analyzeDependencies({ root: project.root, limits: { maxFiles: 50, maxFileBytes: 4096 } })
    const report = generateArchitectureReport({ scan, dependencies, projectName: 'tiny' })
    const heuristic = report.findings.filter((finding) => finding.kind === 'heuristic').map((finding) => finding.message)
    assert.ok(
      !heuristic.some((message) => message.includes('集中度')),
      '引用文件数不足 3 时不应报集中度：' + JSON.stringify(heuristic),
    )
  } finally {
    project.cleanup()
  }
})

test('建议：由命中的事实驱动（有循环依赖才给拆循环建议）', async () => {
  const cyclic = createTempProject({ 'a.py': 'from b import x\n', 'b.py': 'from a import y\n' })
  const clean = createTempProject({ 'main.py': 'import os\n', 'pyproject.toml': '[project]', 'tests/test_main.py': 'def test(): pass\n' })
  try {
    const cyclicScan = await scanProject({ root: cyclic.root, limits: { maxDepth: 4, maxEntries: 200 } })
    const cyclicDeps = await analyzeDependencies({ root: cyclic.root, limits: { maxFiles: 50, maxFileBytes: 8192 } })
    const cyclicReport = generateArchitectureReport({ scan: cyclicScan, dependencies: cyclicDeps, projectName: 'cyclic' })
    assert.ok(cyclicReport.markdown.includes('优先拆循环'), '有循环依赖时应给出拆循环建议')

    const cleanScan = await scanProject({ root: clean.root, limits: { maxDepth: 4, maxEntries: 200 } })
    const cleanDeps = await analyzeDependencies({ root: clean.root, limits: { maxFiles: 50, maxFileBytes: 8192 } })
    const cleanReport = generateArchitectureReport({ scan: cleanScan, dependencies: cleanDeps, projectName: 'clean' })
    assert.ok(!cleanReport.markdown.includes('优先拆循环'), '无循环依赖时不应出现拆循环建议')
    assert.ok(!cleanReport.markdown.includes('补一份项目清单'), '已有 pyproject.toml 时不应再要求补清单')
    assert.ok(!cleanReport.markdown.includes('建一个 tests/'), '已有 tests/ 时不应再建测试目录')
  } finally {
    cyclic.cleanup()
    clean.cleanup()
  }
})
