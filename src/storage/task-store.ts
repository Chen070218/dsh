/**
 * 任务存储接口（第四阶段）。
 *
 * 抽象成接口而不是直接暴露 SQLite：将来换存储（内存/远端）时，服务与工具层不用改。
 * 预留字段：dependsOn（任务依赖）、attempts（失败重试次数）、lastError（最近失败原因）。
 */

export const TASK_STATES = ['pending', 'in_progress', 'completed', 'failed'] as const

export type TaskState = (typeof TASK_STATES)[number]

export interface TaskRecord {
  id: string
  title: string
  description: string
  state: TaskState
  priority: number
  /** 前置任务 id 列表；为空表示没有依赖。 */
  dependsOn: string[]
  /** 执行尝试次数（为将来的失败重试预留）。 */
  attempts: number
  createdAt: string
  updatedAt: string
  /** 最近一次失败原因（已脱敏）；没有失败时为空字符串。 */
  lastError: string
}

export interface TaskExecutionRecord {
  id: number
  taskId: string
  state: TaskState
  startedAt: string
  /** 空字符串表示尚未结束。 */
  finishedAt: string
  message: string
  errorCode: string
}

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: number
  dependsOn?: string[]
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  state?: TaskState
  priority?: number
  dependsOn?: string[]
  attempts?: number
  lastError?: string
}

export interface ListTasksFilter {
  state?: TaskState
  limit?: number
}

export interface RecordExecutionInput {
  taskId: string
  state: TaskState
  message?: string
  errorCode?: string
  startedAt?: string
  finishedAt?: string
}

export interface TaskTransition {
  patch: UpdateTaskInput
  /** 与状态变更同事务写入的执行记录。 */
  execution?: {
    state: TaskState
    message?: string
    errorCode?: string
    startedAt?: string
    finishedAt?: string
  }
}

export interface TaskDependencyStatus {
  id: string
  /** missing 表示 dependsOn 里写了一个不存在的任务 id。 */
  state: TaskState | 'missing'
  title: string
}

export interface TaskStore {
  create(input: CreateTaskInput): TaskRecord
  get(id: string): TaskRecord | undefined
  list(filter?: ListTasksFilter): TaskRecord[]
  update(id: string, patch: UpdateTaskInput): TaskRecord
  remove(id: string): boolean
  /** 原子地「改状态 + 写执行记录」：任一步失败则整体回滚。 */
  transition(id: string, transition: TaskTransition): { task: TaskRecord; execution: TaskExecutionRecord | undefined }
  /** 依赖任务的当前状态，用于判断能否推进。 */
  dependencyStatus(id: string): TaskDependencyStatus[]
  /** SQLite user_version，用于迁移对账。 */
  schemaVersion(): number
  recordExecution(input: RecordExecutionInput): TaskExecutionRecord
  listExecutions(taskId: string, limit?: number): TaskExecutionRecord[]
  counts(): Record<TaskState, number>
  close(): void
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value)
}

export const TASK_ERROR_CODES = {
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_INVALID_STATE: 'TASK_INVALID_STATE',
  TASK_STORE_FAILED: 'TASK_STORE_FAILED',
  TASK_DEPENDENCY_UNMET: 'TASK_DEPENDENCY_UNMET',
} as const
