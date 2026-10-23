#!/usr/bin/env node
/**
 * 手工冒烟：依赖分析（自动识别 Python / TypeScript-JavaScript）。
 *   node scripts/demo-analyze.mjs [目标目录]
 * 默认分析 examples/sample-python-app（含真实循环依赖）。
 */
import { fileURLToPath } from 'node:url'
import { analyzeProjectDependencies } from '../lib/services/dependency-service.js'
import { renderDependencyGraph } from '../lib/services/mermaid-renderer.js'

const target = process.argv[2] ?? fileURLToPath(new URL('../examples/sample-python-app/', import.meta.url))
const result = await analyzeProjectDependencies({
  root: target,
  limits: { maxFiles: 500, maxFileBytes: 262144 },
})
const report = result.report

console.log('root      :', report.root)
console.log('language  :', report.language, '| detected:', JSON.stringify(result.detected), '| mixed:', result.mixedProject)
console.log('modules   :', report.stats.modules, '| edges:', report.stats.edges, '| cycles:', report.stats.cycles, '| files:', report.stats.files)
console.log('edges     :')
for (const edge of report.edges.slice(0, 12)) console.log('  -', edge.from, '->', edge.to, '[' + edge.kind + '] line', edge.line)
console.log('cycles    :', report.cycles.length === 0 ? '(none)' : '')
for (const cycle of report.cycles) console.log('  !', cycle.modules.join(' <-> '))
console.log('external  :', report.external.map((item) => item.name + '(' + item.files + ')').join(', ') || '(none)')
console.log('unresolved:', report.unresolved.length)
for (const warning of report.warnings) console.log('warning   :', warning)
console.log('--- mermaid ---')
console.log(renderDependencyGraph(report).mermaid)
