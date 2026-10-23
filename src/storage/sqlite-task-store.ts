/**
 * SQLite 任务存储实现（node:sqlite，Node 22.5+ 内置，无需 native 依赖）。
 *
 * 两张表：
 * - tasks：任务本身（状态、优先级、依赖、尝试次数、最近失败原因、时间戳）
 * - task_executions：执行记录（每次状态变更一条，便于回溯"什么时候失败过"）
 *
 * 安全：所有值都用参数绑定，不拼 SQL；写入前对 message 再做一次脱敏。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  CreateTaskInput,
  ListTasksFilter,
  RecordExecutionInput,
  TaskExecutionRecord,
  TaskRecord,
  TaskState,
  TaskStore,
  UpdateTaskInput,
} from './task-store.js'
import { TASK_ERROR_CODES, isTaskState } from './task-store.js'

export class TaskStoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TaskStoreError'
    this.code = code
  }
}

interface TaskRow {
  id: string
  title: string
  description: string
  state: string
  priority: number
  depends_on: string
  attempts: number
  created_at: string
  updated_at: string
  last_error: string
}

interface ExecutionRow {
  id: number
  task_id: string
  state: string
  started_at: string
  finished_at: string
  message: string
  error_code: string
}

/** 写库前的最后一道脱敏：形如 token=xxx / apiKey: xxx 的片段一律替换。 */
export function redactMessage(message: string): string {
  return message.replace(
    /([A-Za-z0-9_-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key)[A-Za-z0-9_-]*)\s*[:=]\s*\S+/gi,
    '$1=[redacted]',
  )
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

function normalizeDependsOn(dependsOn: readonly string[] | undefined): string[] {
  if (dependsOn === undefined) return []
  const unique = new Set<string>()
  for (const item of dependsOn) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed !== '') unique.add(trimmed)
  }
  return [...unique].sort()
}

function toTaskRecord(row: TaskRow): TaskRecord {
  let dependsOn: string[] = []
  try {
    const parsed = JSON.parse(row.depends_on)
    if (Array.isArray(parsed)) dependsOn = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    dependsOn = []
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    state: isTaskState(row.state) ? row.state : 'pending',
    priority: row.priority,
    dependsOn,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  }
}

function toExecutionRecord(row: ExecutionRow): TaskExecutionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    state: isTaskState(row.state) ? row.state : 'pending',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    message: row.message,
    errorCode: row.error_code,
  }
}

export interface SqliteTaskStoreOptions {
  /** 数据库文件路径；':memory:' 用于测试。 */
  filename: string
}

export function createSqliteTaskStore(options: SqliteTaskStoreOptions): TaskStore {
  if (options.filename !== ':memory:') mkdirSync(dirname(options.filename), { recursive: true })
  const db = new DatabaseSync(options.filename)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // 多会话可能同时打开同一个库；没有 busy_timeout 时并发写会直接 SQLITE_BUSY。
  db.exec('PRAGMA busy_timeout = 5000')
  const SCHEMA_VERSION = 1
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const currentVersion = Number(versionRow?.user_version ?? 0)
  if (currentVersion < SCHEMA_VERSION) {
    // 迁移入口：以后加字段时在这里按 currentVersion 递增执行 ALTER TABLE。
    db.exec('PRAGMA user_version = ' + SCHEMA_VERSION)
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS tasks (' +
      'id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\',' +
      " state TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0," +
      " depends_on TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0," +
      ' created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT \'\')',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS task_executions (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,' +
      " state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT ''," +
      " message TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '')",
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id)')

  const insertTask = db.prepare(
    'INSERT INTO tasks (id, title, description, state, priority, depends_on, attempts, created_at, updated_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
  const selectAll = db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC')
  const selectByState = db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC')
  const updateTask = db.prepare(
    'UPDATE tasks SET title = ?, description = ?, state = ?, priority = ?, depends_on = ?, attempts = ?, updated_at = ?, last_error = ? WHERE id = ?',
  )
  const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?')
  const insertExecution = db.prepare(
    'INSERT INTO task_executions (task_id, state, started_at, finished_at, message, error_code) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const selectExecutions = db.prepare('SELECT * FROM task_executions WHERE task_id = ? ORDER BY id DESC LIMIT ?')
  const selectLastExecution = db.prepare('SELECT * FROM task_executions WHERE task_id = ? ORDER BY id DESC LIMIT 1')
  const countByState = db.prepare('SELECT state, COUNT(*) AS total FROM tasks GROUP BY state')
  const selectIdAndTitle = db.prepare('SELECT id, title, state FROM tasks WHERE id = ?')

  /** 推进到 in_progress / completed 前，所有 dependsOn 必须已完成。 */
  const assertDependenciesSettled = (record: TaskRecord, targetState: string): void => {
    if (targetState !== 'in_progress' && targetState !== 'completed') return
    const unmet: string[] = []
    for (const dependencyId of record.dependsOn) {
      const row = selectIdAndTitle.get(dependencyId) as { id: string; title: string; state: string } | undefined
      if (row === undefined) unmet.push(dependencyId + '(不存在)')
      else if (row.state !== 'completed') unmet.push(dependencyId + '(' + row.state + ')')
    }
    if (unmet.length > 0) {
      throw new TaskStoreError(
        TASK_ERROR_CODES.TASK_DEPENDENCY_UNMET,
        '前置任务未完成，不能推进到 ' + targetState + ': ' + unmet.join(', '),
      )
    }
  }

  const store: TaskStore = {
    create(input) {
      const title = (input.title ?? '').trim()
      if (title === '') throw new TaskStoreError(TASK_ERROR_CODES.TASK_STORE_FAILED, '任务标题不能为空')
      const dependsOn = normalizeDependsOn(input.dependsOn)
      for (const dependencyId of dependsOn) {
        if (selectIdAndTitle.get(dependencyId) === undefined) {
          throw new TaskStoreError(TASK_ERROR_CODES.TASK_DEPENDENCY_UNMET, '依赖的任务不存在: ' + dependencyId)
        }
      }
      const id = newId()
      const timestamp = nowIso()
      const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0
      insertTask.run(
        id,
        title,
        (input.description ?? '').trim(),
        'pending',
        priority,
        JSON.stringify(dependsOn),
        0,
        timestamp,
        timestamp,
        '',
      )
      const created = store.get(id)
      if (created === undefined) throw new TaskStoreError(TASK_ERROR_CODES.TASK_STORE_FAILED, '任务创建后无法读回: ' + id)
      return created
    },

    get(id) {
      const row = selectTask.get(id) as TaskRow | undefined
      return row === undefined ? undefined : toTaskRecord(row)
    },

    list(filter) {
      const limit =
        filter?.limit !== undefined && Number.isFinite(filter.limit) ? Math.max(1, Math.trunc(filter.limit)) : undefined
      const rows =
        filter?.state !== undefined ? (selectByState.all(filter.state) as TaskRow[]) : (selectAll.all() as TaskRow[])
      const tasks = rows.map(toTaskRecord)
      return limit === undefined ? tasks : tasks.slice(0, limit)
    },

    update(id, patch) {
      const existing = store.get(id)
      if (existing === undefined) throw new TaskStoreError(TASK_ERROR_CODES.TASK_NOT_FOUND, '任务不存在: ' + id)
      if (patch.state !== undefined && !isTaskState(patch.state)) {
        throw new TaskStoreError(TASK_ERROR_CODES.TASK_INVALID_STATE, '非法任务状态: ' + String(patch.state))
      }
      assertDependenciesSettled(existing, patch.state ?? existing.state)

      const next: TaskRecord = {
        ...existing,
        title: patch.title === undefined ? existing.title : patch.title.trim() || existing.title,
        description: patch.description === undefined ? existing.description : patch.description,
        state: patch.state ?? existing.state,
        priority: patch.priority === undefined ? existing.priority : Math.trunc(patch.priority),
        dependsOn: patch.dependsOn === undefined ? existing.dependsOn : normalizeDependsOn(patch.dependsOn),
        attempts: patch.attempts === undefined ? existing.attempts : Math.max(0, Math.trunc(patch.attempts)),
        lastError: patch.lastError === undefined ? existing.lastError : redactMessage(patch.lastError),
        updatedAt: nowIso(),
      }
      updateTask.run(
        next.title,
        next.description,
        next.state,
        next.priority,
        JSON.stringify(next.dependsOn),
        next.attempts,
        next.updatedAt,
        next.lastError,
        id,
      )
      return next
    },

    transition(id, change) {
      const existing = store.get(id)
      if (existing === undefined) throw new TaskStoreError(TASK_ERROR_CODES.TASK_NOT_FOUND, '任务不存在: ' + id)
      const targetState = change.patch.state ?? existing.state
      if (!isTaskState(targetState)) {
        throw new TaskStoreError(TASK_ERROR_CODES.TASK_INVALID_STATE, '非法任务状态: ' + String(targetState))
      }
      assertDependenciesSettled(existing, targetState)

      db.exec('BEGIN IMMEDIATE')
      try {
        const task = store.update(id, change.patch)
        const execution =
          change.execution === undefined
            ? undefined
            : store.recordExecution({
                taskId: id,
                state: change.execution.state,
                message: change.execution.message,
                errorCode: change.execution.errorCode,
                startedAt: change.execution.startedAt,
                finishedAt: change.execution.finishedAt,
              })
        db.exec('COMMIT')
        return { task, execution }
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    dependencyStatus(id) {
      const record = store.get(id)
      if (record === undefined) throw new TaskStoreError(TASK_ERROR_CODES.TASK_NOT_FOUND, '任务不存在: ' + id)
      return record.dependsOn.map((dependencyId) => {
        const row = selectIdAndTitle.get(dependencyId) as { id: string; title: string; state: string } | undefined
        if (row === undefined) return { id: dependencyId, state: 'missing' as const, title: '' }
        return {
          id: dependencyId,
          state: isTaskState(row.state) ? row.state : ('pending' as const),
          title: row.title,
        }
      })
    },

    schemaVersion() {
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
      return Number(row?.user_version ?? 0)
    },

    remove(id) {
      const result = deleteTask.run(id)
      return Number(result.changes) > 0
    },

    recordExecution(input) {
      const existing = store.get(input.taskId)
      if (existing === undefined) throw new TaskStoreError(TASK_ERROR_CODES.TASK_NOT_FOUND, '任务不存在: ' + input.taskId)
      if (!isTaskState(input.state)) {
        throw new TaskStoreError(TASK_ERROR_CODES.TASK_INVALID_STATE, '非法任务状态: ' + String(input.state))
      }
      insertExecution.run(
        input.taskId,
        input.state,
        input.startedAt ?? nowIso(),
        input.finishedAt ?? nowIso(),
        redactMessage(input.message ?? ''),
        input.errorCode ?? '',
      )
      const row = selectLastExecution.get(input.taskId) as ExecutionRow | undefined
      if (row === undefined) throw new TaskStoreError(TASK_ERROR_CODES.TASK_STORE_FAILED, '执行记录写入后无法读回')
      return toExecutionRecord(row)
    },

    listExecutions(taskId, limit = 20) {
      const rows = selectExecutions.all(taskId, Math.max(1, Math.trunc(limit))) as ExecutionRow[]
      return rows.map(toExecutionRecord)
    },

    counts() {
      const initial: Record<TaskState, number> = { pending: 0, in_progress: 0, completed: 0, failed: 0 }
      for (const row of countByState.all() as Array<{ state: string; total: number }>) {
        if (isTaskState(row.state)) initial[row.state] = Number(row.total)
      }
      return initial
    },

    close() {
      db.close()
    },
  }

  return store
}
