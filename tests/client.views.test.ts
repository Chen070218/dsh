import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createToolViews, platform } from '../lib/client/index.js'

test('客户端视图：平台为 web，10 个工具都有卡片描述', () => {
  assert.equal(platform, 'web')
  const views = createToolViews()
  assert.equal(views.length, 10)
  const names = views.map((view) => view.tool).sort()
  assert.deepEqual(names, [
    'analyze_dependencies', 'generate_architecture_report', 'generate_readme_draft',
    'plugin_info', 'plugin_logs', 'scan_project', 'task_create', 'task_get', 'task_list', 'task_update',
  ])
  for (const view of views) {
    assert.ok(view.title.length > 0, view.tool + ' 缺标题')
    assert.ok(view.summary.length > 0, view.tool + ' 缺摘要')
    assert.ok(view.fields.length > 0, view.tool + ' 缺字段')
    for (const field of view.fields) {
      assert.ok(['result', 'args', 'literal'].includes(field.from), view.tool + ' 字段来源非法: ' + field.from)
      assert.ok(field.path.length > 0)
    }
  }
})

test('客户端视图：apply 注册到 toolViews 服务，缺服务时静默跳过', () => {
  const registered: unknown[] = []
  apply({ toolViews: { register: (specs) => registered.push(...specs) } })
  assert.equal(registered.length, 10)

  assert.doesNotThrow(() => apply({}))
})
