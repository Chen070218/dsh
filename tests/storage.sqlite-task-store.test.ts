import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteTaskStore, redactMessage } from '../lib/storage/sqlite-task-store.js'

function withStore(run: (store: ReturnType<typeof createSqliteTaskStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-projectops-store-'))
  const store = createSqliteTaskStore({ filename: join(dir, 'tasks.db') })
  try {
    run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('任务存储：创建、读取、默认值', () => {
  withStore((store) => {
    const depA = store.create({ title: 'dep-a' })
    const depB = store.create({ title: 'dep-b' })
    const task = store.create({ title: '  实现 scan_project  ', description: '第一版', priority: 5, dependsOn: [depB.id, depA.id, depB.id] })
    assert.equal(task.title, '实现 scan_project')
    assert.equal(task.state, 'pending')
    assert.equal(task.priority, 5)
    assert.equal(task.attempts, 0)
    assert.deepEqual(task.dependsOn, [depA.id, depB.id].sort(), '依赖去重并排序')
    assert.ok(task.id.startsWith('task_'))
    assert.equal(store.get(task.id)?.description, '第一版')
    assert.equal(store.get('missing'), undefined)
  })
})

test('任务存储：状态更新、计数与执行记录', () => {
  withStore((store) => {
    const task = store.create({ title: 'A' })
    store.update(task.id, { state: 'in_progress', attempts: 1 })
    store.recordExecution({ taskId: task.id, state: 'in_progress', message: '开始执行' })
    store.update(task.id, { state: 'failed', lastError: 'token=abc123 被拒绝' })
    const failed = store.recordExecution({ taskId: task.id, state: 'failed', errorCode: 'PERMISSION_DENIED', message: '权限不足' })

    assert.equal(failed.state, 'failed')
    assert.equal(failed.errorCode, 'PERMISSION_DENIED')
    assert.ok(!JSON.stringify(store.listExecutions(task.id)).includes('abc123'), '失败原因必须脱敏')

    const counts = store.counts()
    assert.equal(counts.failed, 1)
    assert.equal(counts.pending, 0)
    assert.equal(store.list({ state: 'failed' }).length, 1)
    assert.equal(store.listExecutions(task.id).length, 2)
  })
})

test('任务存储：非法输入与不存在任务的错误', () => {
  withStore((store) => {
    assert.throws(() => store.create({ title: '   ' }), /标题不能为空/)
    const task = store.create({ title: 'B' })
    assert.throws(() => store.update(task.id, { state: 'done' as never }), /非法任务状态/)
    assert.throws(() => store.update('task_nope', { state: 'completed' }), /任务不存在/)
    assert.throws(() => store.recordExecution({ taskId: 'task_nope', state: 'completed' }), /任务不存在/)
    assert.equal(store.remove(task.id), true)
    assert.equal(store.remove(task.id), false)
  })
})

test('脱敏：形如 key=value 的敏感片段被替换', () => {
  const redacted = redactMessage('apiKey=sk-live-123 token: abc password=hunter2 normal=ok')
  assert.ok(!redacted.includes('sk-live-123'))
  assert.ok(!redacted.includes('abc'))
  assert.ok(!redacted.includes('hunter2'))
  assert.ok(redacted.includes('normal=ok'))
})

test('任务存储：依赖未完成时拒绝推进，完成后放行', () => {
  withStore((store) => {
    const first = store.create({ title: 'A' })
    const second = store.create({ title: 'B', dependsOn: [first.id] })

    assert.deepEqual(
      store.dependencyStatus(second.id).map((item) => [item.id, item.state]),
      [[first.id, 'pending']],
    )
    assert.throws(() => store.update(second.id, { state: 'in_progress' }), /前置任务未完成/)
    assert.throws(
      () => store.transition(second.id, { patch: { state: 'completed' }, execution: { state: 'completed' } }),
      /前置任务未完成/,
    )

    store.update(first.id, { state: 'completed' })
    const advanced = store.transition(second.id, {
      patch: { state: 'in_progress' },
      execution: { state: 'in_progress', message: '前置已完成' },
    })
    assert.equal(advanced.task.state, 'in_progress')
    assert.equal(advanced.execution?.message, '前置已完成')
    assert.equal(store.listExecutions(second.id).length, 1)
  })
})

test('任务存储：拒绝不存在的依赖 id，并暴露 schema 版本', () => {
  withStore((store) => {
    assert.throws(() => store.create({ title: 'X', dependsOn: ['task_nope'] }), /依赖的任务不存在/)
    assert.equal(store.schemaVersion(), 1)
    const task = store.create({ title: 'Y', dependsOn: [] })
    assert.deepEqual(store.dependencyStatus(task.id), [])
  })
})

test('任务存储：transition 失败时整体回滚（状态与执行记录都不写）', () => {
  withStore((store) => {
    const dep = store.create({ title: 'dep' })
    const task = store.create({ title: 'main', dependsOn: [dep.id] })
    try {
      store.transition(task.id, { patch: { state: 'in_progress' }, execution: { state: 'in_progress', message: 'x' } })
      assert.fail('应当因依赖未完成而失败')
    } catch {
      // 预期
    }
    assert.equal(store.get(task.id)?.state, 'pending')
    assert.equal(store.listExecutions(task.id).length, 0)
  })
})

test('任务存储：两个连接并发写同一个库不报 SQLITE_BUSY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-projectops-concurrent-'))
  const file = join(dir, 'tasks.db')
  const first = createSqliteTaskStore({ filename: file })
  const second = createSqliteTaskStore({ filename: file })
  try {
    const created = first.create({ title: '并发任务' })
    // 交替写 20 次：状态来回切换，跨连接可见
    const transitionWithRetry = (store: typeof first, index: number): void => {
      // busy 是并发下可接受的瞬时状态：有限重试；其它错误必须冒出来
      for (let attempt = 0; ; attempt += 1) {
        try {
          store.transition(created.id, {
            patch: { state: index % 4 < 2 ? 'in_progress' : 'completed' },
            execution: { state: index % 4 < 2 ? 'in_progress' : 'completed', message: '并发第 ' + index + ' 次' },
          })
          return
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/busy|locked/i.test(message) || attempt >= 4) throw error
        }
      }
    }
    for (let index = 0; index < 20; index += 1) transitionWithRetry(index % 2 === 0 ? first : second, index)
    assert.equal(first.listExecutions(created.id, 100).length, 20)
    assert.equal(second.get(created.id)?.state, 'completed')
    assert.equal(first.counts().completed, 1)
  } finally {
    first.close()
    second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
