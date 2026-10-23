import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { createTaskTools, TASK_TOOL_NAMES } from '../lib/tools/task-tools.js'
import { createTaskService } from '../lib/services/task-service.js'
import { createLogger } from '../lib/util/logger.js'
import { existsSync } from 'node:fs'
import { createTempProject } from './support/temp-project.ts'

function buildTools(allowedRoots: string[]) {
  const service = createTaskService({ directory: '.projectops' })
  const tools = createTaskTools({
    defaults: { allowedRoots, maxAttempts: 3 },
    service,
    logger: createLogger({ sink: () => {}, level: 'error' }),
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { tools, byName, service }
}

function fakeExec(cwd?: string) {
  return {
    signal: new AbortController().signal,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

test('任务工具：四个工具都注册且 schema 合法', () => {
  const { tools } = buildTools([])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [TASK_TOOL_NAMES.create, TASK_TOOL_NAMES.list, TASK_TOOL_NAMES.get, TASK_TOOL_NAMES.update],
  )
  for (const tool of tools) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), tool.name + ' 的输出 schema 非法')
  }
})

test('任务工具：创建 -> 列表 -> 更新 -> 详情（含执行记录）', async () => {
  const project = createTempProject({ 'main.py': 'print(1)' })
  const { byName, service } = buildTools([project.root])
  const exec = fakeExec(project.root)
  try {
    const created = await byName.get(TASK_TOOL_NAMES.create)!.execute(
      { title: '接入依赖分析', description: '把 Mermaid 图接进报告', priority: 3 },
      exec,
    )
    assert.equal(created.root, project.root)
    assert.equal(created.task.state, 'pending')
    const id = created.task.id

    const listed = await byName.get(TASK_TOOL_NAMES.list)!.execute({}, exec)
    assert.equal(listed.tasks.length, 1)
    assert.equal(listed.counts.pending, 1)

    const started = await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'in_progress', message: '开始' }, exec)
    assert.equal(started.task.state, 'in_progress')
    assert.equal(started.task.attempts, 1)
    assert.equal(started.execution.state, 'in_progress')

    const failed = await byName.get(TASK_TOOL_NAMES.update)!.execute(
      { id, state: 'failed', message: 'token=sk-secret 无效', errorCode: 'PERMISSION_DENIED' },
      exec,
    )
    assert.equal(failed.task.state, 'failed')
    assert.ok(failed.task.lastError.includes('[redacted]'), '失败原因必须脱敏')
    assert.ok(!JSON.stringify(failed).includes('sk-secret'))

    const detail = await byName.get(TASK_TOOL_NAMES.get)!.execute({ id }, exec)
    assert.equal(detail.task.id, id)
    assert.equal(detail.executions.length, 2, '两次状态变更应各留一条执行记录')

    const filtered = await byName.get(TASK_TOOL_NAMES.list)!.execute({ state: 'failed' }, exec)
    assert.equal(filtered.tasks.length, 1)
    assert.equal(filtered.counts.failed, 1)
  } finally {
    service.closeAll()
    project.cleanup()
  }
})

test('任务工具：数据库落在工作区的 .projectops 下', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  const { byName, service } = buildTools([project.root])
  try {
    await byName.get(TASK_TOOL_NAMES.create)!.execute({ title: 'X' }, fakeExec(project.root))
    const dbPath = project.path('.projectops/tasks.db')
    assert.equal((await import('node:fs')).existsSync(dbPath), true, '任务库应落在工作区 .projectops/tasks.db')
  } finally {
    service.closeAll()
    project.cleanup()
  }
})

test('任务工具：不存在的任务返回 NOT_FOUND', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  const { byName, service } = buildTools([project.root])
  try {
    await assert.rejects(
      () => byName.get(TASK_TOOL_NAMES.get)!.execute({ id: 'task_missing' }, fakeExec(project.root)),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'NOT_FOUND')
        return true
      },
    )
  } finally {
    service.closeAll()
    project.cleanup()
  }
})

test('任务工具：数据库跟随会话工作区，不会写到其它授权目录', async () => {
  // 说明：任务工具没有 path 参数，数据库只会落在"被解析出的工作区"里。
  // 当 allowedRoots 与会话 cwd 指向不同目录时，应以会话 cwd 为准。
  const project = createTempProject({ 'a.py': 'x = 1' })
  const session = createTempProject({ 'b.py': 'y = 1' })
  const { byName, service } = buildTools([project.root])
  try {
    await byName.get(TASK_TOOL_NAMES.create)!.execute({ title: 'X' }, fakeExec(session.root))
    assert.equal(existsSync(session.path('.projectops/tasks.db')), true, '任务库应落在会话工作区')
    assert.equal(existsSync(project.path('.projectops/tasks.db')), false, '不应写到别的授权目录')
  } finally {
    service.closeAll()
    project.cleanup()
    session.cleanup()
  }
})

test('任务工具：依赖管理（创建校验、阻塞推进、完成后放行、get 展示依赖）', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  const { byName, service } = buildTools([project.root])
  const exec = fakeExec(project.root)
  try {
    await assert.rejects(
      () => byName.get(TASK_TOOL_NAMES.create)!.execute({ title: 'X', dependsOn: ['task_missing'] }, exec),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'TASK_DEPENDENCY_UNMET')
        return true
      },
    )

    const first = await byName.get(TASK_TOOL_NAMES.create)!.execute({ title: '前置' }, exec)
    const second = await byName.get(TASK_TOOL_NAMES.create)!.execute({ title: '后继', dependsOn: [first.task.id] }, exec)

    await assert.rejects(
      () => byName.get(TASK_TOOL_NAMES.update)!.execute({ id: second.task.id, state: 'in_progress' }, exec),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'TASK_DEPENDENCY_UNMET')
        return true
      },
    )

    await byName.get(TASK_TOOL_NAMES.update)!.execute({ id: first.task.id, state: 'completed' }, exec)
    const advanced = await byName.get(TASK_TOOL_NAMES.update)!.execute({ id: second.task.id, state: 'in_progress' }, exec)
    assert.equal(advanced.task.state, 'in_progress')
    assert.equal(advanced.task.attempts, 1)

    const detail = await byName.get(TASK_TOOL_NAMES.get)!.execute({ id: second.task.id }, exec)
    assert.equal(detail.dependencies.length, 1)
    assert.equal(detail.dependencies[0]?.state, 'completed')
  } finally {
    service.closeAll()
    project.cleanup()
  }
})

test('任务工具：失败重试受上限约束（TASK_RETRY_EXHAUSTED）', async () => {
  const project = createTempProject({ 'a.py': 'x = 1' })
  const { byName, service } = buildTools([project.root])
  const exec = fakeExec(project.root)
  try {
    const created = await byName.get(TASK_TOOL_NAMES.create)!.execute({ title: '会失败的任务' }, exec)
    const id = created.task.id
    // 第 1 次尝试 -> 失败
    await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'in_progress' }, exec)
    const first = await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'failed', message: '第一次失败' }, exec)
    assert.equal(first.task.attempts, 1)
    assert.ok(!first.task.lastError.includes('已达重试上限'), '第 1 次失败还没到上限')

    // 第 2 次尝试 -> 失败（attempts=2）
    await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'in_progress' }, exec)
    const second = await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'failed', message: '第二次失败' }, exec)
    assert.equal(second.task.attempts, 2)

    // 第 3 次尝试 -> 失败：此时 attempts=3 达到上限
    await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'in_progress' }, exec)
    const third = await byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'failed', message: '第三次失败' }, exec)
    assert.equal(third.task.attempts, 3)
    assert.ok(third.task.lastError.startsWith('[已达重试上限]'), '达到上限后应打标记')

    // 再想重试 -> 直接拒绝
    await assert.rejects(
      () => byName.get(TASK_TOOL_NAMES.update)!.execute({ id, state: 'in_progress' }, exec),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'TASK_RETRY_EXHAUSTED')
        return true
      },
    )
  } finally {
    service.closeAll()
    project.cleanup()
  }
})
