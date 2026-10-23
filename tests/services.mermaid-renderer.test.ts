import test from 'node:test'
import assert from 'node:assert/strict'
import { renderDependencyGraph } from '../lib/services/mermaid-renderer.js'
import type { DependencyReport } from '../lib/services/dependency-analyzer.js'

function report(edges: DependencyReport['edges']): DependencyReport {
  return {
    language: 'python',
    root: '/tmp/demo',
    modules: [],
    edges,
    cycles: [{ modules: ['a', 'b'] }],
    external: [],
    unresolved: [],
    stats: { files: 2, modules: 2, edges: edges.length, cycles: 1, bytesRead: 10 },
    truncated: false,
    warnings: [],
    durationMs: 1,
  }
}

test('Mermaid：顶层依赖用实线，函数内/条件导入用虚线', () => {
  const { mermaid } = renderDependencyGraph(
    report([
      { from: 'a', to: 'b', kind: 'absolute', scope: 'module', line: 1 },
      { from: 'b', to: 'a', kind: 'relative', scope: 'nested', line: 2 },
    ]),
  )
  assert.ok(mermaid.startsWith('graph TD'))
  assert.ok(mermaid.includes(' --> '), '顶层依赖用实线')
  assert.ok(mermaid.includes(' -.-> '), 'nested 依赖用虚线')
  assert.ok(mermaid.includes('classDef cycle'), '循环节点要高亮')
  assert.ok(mermaid.includes('Python'), '注释里应标明语言')
})

test('Mermaid：边数上限生效并给出省略说明', () => {
  const edges = Array.from({ length: 5 }, (_, index) => ({
    from: 'm' + index,
    to: 'm' + (index + 1),
    kind: 'absolute' as const,
    scope: 'module' as const,
    line: index + 1,
  }))
  const rendered = renderDependencyGraph(report(edges), { maxEdges: 2 })
  assert.equal(rendered.omittedEdges, 3)
  assert.ok(rendered.mermaid.includes('省略 3 条边'))
})
