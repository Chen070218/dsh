#!/usr/bin/env node
/**
 * 手工冒烟：对示例项目生成架构说明。
 *   node scripts/demo-report.mjs [目标项目] [输出路径]
 * 默认：examples/sample-python-app -> examples/sample-python-app/docs/architecture.md
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanProject } from '../lib/services/project-scanner.js'
import { analyzeDependencies } from '../lib/services/dependency-analyzer.js'
import { generateArchitectureReport } from '../lib/services/report-generator.js'

const root = process.argv[2] ?? fileURLToPath(new URL('../examples/sample-python-app/', import.meta.url))
const relativeOutput = process.argv[3] ?? 'docs/architecture.md'
const target = join(root, relativeOutput)

const scan = await scanProject({ root, limits: { maxDepth: 5, maxEntries: 2000 } })
const dependencies = await analyzeDependencies({ root, limits: { maxFiles: 500, maxFileBytes: 262144 } })
const report = generateArchitectureReport({ scan, dependencies, projectName: 'sample-python-app' })

if (existsSync(target)) {
  console.log('skip: 目标已存在，不覆盖：' + target)
} else {
  const dir = join(root, 'docs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(target, report.markdown, 'utf8')
  console.log('written:', target, '(' + Buffer.byteLength(report.markdown) + ' bytes)')
}
console.log('sections:', report.sections.join(' / '))
console.log('confirmed findings:', report.findings.filter((f) => f.kind === 'confirmed').length)
console.log('heuristic findings:', report.findings.filter((f) => f.kind === 'heuristic').length)
console.log('--- preview ---')
console.log(report.markdown.split('\n').slice(0, 24).join('\n'))

