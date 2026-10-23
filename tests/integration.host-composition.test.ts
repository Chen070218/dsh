/**
 * 集成测试：把插件挂载到真实的 cordis + dsh-tools 运行时上。
 *
 * 这里用的 @deepseek-ai/cordis 与 @deepseek-ai/dsh-tools 就是 DSH 宿主加载插件时使用的同一份实现
 * （由 tests/support/runtime-hooks.mjs 把 bare specifier 指向本机运行时包）。
 * 覆盖：插件 apply 是否注册工具、工具是否出现在模型可见 schema 列表里、
 * 以及通过 ToolRuntime 的完整执行管线（参数校验 -> 执行 -> 输出校验 -> 渲染）调用是否成功。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as projectops from '../lib/index.js'
import { createTempProject } from './support/temp-project.ts'

/** dsh-tools 的 ToolRuntime 依赖 systemPrompt 服务，这里给一个最小替身。 */
class StubSystemPrompt extends Service {
  constructor(ctx: any) {
    super(ctx, 'systemPrompt')
  }

  tools() {
    return () => {}
  }

  section() {
    return () => {}
  }
}

interface Mounted {
  ctx: any
  tools: any
}

async function mountPlugin(config: Record<string, unknown>): Promise<Mounted> {
  const ctx: any = new Context()
  ctx.plugin({
    name: 'stub-system-prompt',
    apply(inner: any) {
      inner.plugin(StubSystemPrompt)
    },
  })
  ctx.plugin({
    name: 'dsh-tools-runtime',
    apply(inner: any) {
      inner.plugin(ToolRuntime, {})
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(typeof ctx.tools, 'object', 'ToolRuntime 服务应已就绪')

  ctx.plugin(
    {
      name: projectops.name,
      inject: projectops.inject,
      Config: projectops.Config,
      apply: projectops.apply,
    },
    config,
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { ctx, tools: ctx.tools }
}

test('宿主组合：插件挂载后 scan_project 出现在工具注册表与 schema 列表', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  try {
    const { tools } = await mountPlugin({ allowedRoots: [project.root] })
    const definition = tools.get('scan_project')
    assert.ok(definition, '工具应已注册')
    assert.equal(definition.name, 'scan_project')
    assert.ok(typeof definition.description === 'string' && definition.description.length > 20)

    const names = tools.schemas().map((schema: { name: string }) => schema.name)
    assert.ok(names.includes('scan_project'), '模型可见 schema 中应包含 scan_project')
    assert.ok(names.includes('analyze_dependencies'), '模型可见 schema 中应包含 analyze_dependencies')
    assert.ok(names.includes('generate_architecture_report'), '模型可见 schema 中应包含文档生成工具')
  } finally {
    project.cleanup()
  }
})

test('宿主组合：通过 ToolRuntime 执行工具，输出通过 schema 校验并渲染', async () => {
  const project = createTempProject({
    'app/main.py': 'print(1)',
    'app/util.py': 'x = 1',
    'README.md': '# demo',
    'pyproject.toml': '[project]',
    '.env': 'SECRET=1',
    'node_modules/dep/index.js': 'x',
  })
  try {
    const { tools } = await mountPlugin({ allowedRoots: [project.root] })
    const result = await tools.execute({
      callId: 'call-1',
      name: 'scan_project',
      arguments: { path: project.root },
      signal: new AbortController().signal,
    })

    assert.equal(result.isError, false, '执行不应失败: ' + JSON.stringify(result).slice(0, 400))
    const text = result.content[0]?.text ?? ''
    assert.ok(text.includes('项目扫描结果'), '渲染结果应包含报告标题')
    assert.ok(text.includes('main.py'))
    assert.ok(!text.includes('node_modules'))
    assert.ok(!text.includes('SECRET=1'), '输出中不能出现敏感文件内容')

    assert.equal(result.value.root, project.root)
    assert.equal(result.value.detection.primaryLanguage, 'Python')
    assert.equal(result.value.stats.skippedSensitive, 1)
  } finally {
    project.cleanup()
  }
})

test('宿主组合：参数校验与越界路径都转成明确的错误结果', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  const outside = createTempProject({ 'secret.txt': 'x' })
  try {
    const { tools } = await mountPlugin({ allowedRoots: [project.root] })

    const invalid = await tools.execute({
      callId: 'call-2',
      name: 'scan_project',
      arguments: { maxDepth: 'deep' },
      signal: new AbortController().signal,
    })
    assert.equal(invalid.isError, true)
    assert.ok(String(invalid.content[0]?.text).includes('invalid arguments'))

    const escape = await tools.execute({
      callId: 'call-3',
      name: 'scan_project',
      arguments: { path: outside.root },
      signal: new AbortController().signal,
    })
    assert.equal(escape.isError, true, '越界路径必须是错误结果，而不是静默成功')
    assert.ok(String(escape.content[0]?.text).includes('授权工作区'))
  } finally {
    project.cleanup()
    outside.cleanup()
  }
})

test('宿主组合：插件卸载时不抛异常（生命周期清理生效）', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  try {
    const { ctx } = await mountPlugin({ allowedRoots: [project.root] })
    assert.doesNotThrow(() => ctx.dispose?.())
  } finally {
    project.cleanup()
  }
})
