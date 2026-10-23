/**
 * 任务管理工具（第四阶段）：task_create / task_list / task_get / task_update。
 *
 * 四个工具都很薄：路径校验 -> 取工作区对应的 TaskStore -> 调用存储 -> 返回结构化结果。
 * 放在同一个文件是因为它们共享"解析工作区 + 打开数据库"的样板逻辑；
 * 业务规则仍然集中在 storage/task-store.ts 与 sqlite-task-store.ts。
 */
import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createWorkspaceGuard } from '../security/workspace-guard.js'
import type { TaskService } from '../services/task-service.js'
import { TASK_STATES } from '../storage/task-store.js'
import type { TaskExecutionRecord, TaskRecord, TaskState, TaskStore } from '../storage/task-store.js'
import { isTaskState } from '../storage/task-store.js'
import { ErrorCode, ProjectOpsError } from '../util/errors.js'
import type { Logger } from '../util/logger.js'

export const TASK_TOOL_NAMES = {
  create: 'task_create',
  list: 'task_list',
  get: 'task_get',
  update: 'task_update',
} as const

export interface TaskToolDefaults {
  allowedRoots: readonly string[]
  /** 单个任务允许的最大尝试次数（失败后重新进入 in_progress 的次数上限）。 */
  maxAttempts: number
}

export interface TaskToolDeps {
  defaults: TaskToolDefaults
  service: TaskService
  logger: Logger
}

const STATE_SCHEMA = { type: 'string' as const, enum: [...TASK_STATES] }

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    description: { type: 'string', required: true },
    state: { ...STATE_SCHEMA, required: true },
    priority: { type: 'integer', required: true },
    dependsOn: { type: 'array', required: true, items: { type: 'string' } },
    attempts: { type: 'integer', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    lastError: { type: 'string', required: true },
  },
}

const EXECUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    taskId: { type: 'string', required: true },
    state: { ...STATE_SCHEMA, required: true },
    startedAt: { type: 'string', required: true },
    finishedAt: { type: 'string', required: true },
    message: { type: 'string', required: true },
    errorCode: { type: 'string', required: true },
  },
}

function readSessionCwd(exec: unknown): string | undefined {
  const candidate = exec as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined
  const cwd = candidate?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function collectAuthorizedRoots(configured: readonly string[], sessionCwd: string | undefined): string[] {
  const candidates = [...configured, ...(sessionCwd === undefined ? [] : [sessionCwd])]
  const usable: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim()
    if (normalized === '') continue
    if (usable.some((existing) => existing === normalized)) continue
    if (isDirectory(normalized)) usable.push(normalized)
  }
  if (usable.length > 0) return usable
  if (isDirectory(process.cwd())) return [process.cwd()]
  throw new ProjectOpsError(ErrorCode.INVALID_PATH, '没有可用的授权工作区根目录')
}

interface ResolvedStore {
  store: TaskStore
  root: string
}

function resolveStore(deps: TaskToolDeps, exec: unknown): ResolvedStore {
  const sessionCwd = readSessionCwd(exec)
  const roots = collectAuthorizedRoots(deps.defaults.allowedRoots, sessionCwd)
  const guard = createWorkspaceGuard({ roots })
  const target = guard.resolve('.', { baseDir: sessionCwd ?? guard.roots[0], expect: 'directory' })
  return { store: deps.service.forWorkspace(target.absolutePath), root: target.absolutePath }
}

function renderTask(task: TaskRecord): string {
  const lines: string[] = []
  lines.push('### ' + task.title)
  lines.push('')
  lines.push('- id：' + task.id)
  lines.push('- 状态：' + task.state + (task.attempts > 0 ? '（尝试 ' + task.attempts + ' 次）' : ''))
  lines.push('- 优先级：' + task.priority)
  if (task.dependsOn.length > 0) lines.push('- 依赖：' + task.dependsOn.join(', '))
  if (task.description !== '') lines.push('- 描述：' + task.description)
  if (task.lastError !== '') lines.push('- 最近失败：' + task.lastError)
  lines.push('- 更新时间：' + task.updatedAt)
  return lines.join('\n')
}

function renderExecutions(executions: TaskExecutionRecord[]): string {
  if (executions.length === 0) return '_没有执行记录_'
  const lines: string[] = ['#### 执行记录', '']
  for (const execution of executions) {
    lines.push(
      '- [' +
        execution.state +
        '] ' +
        execution.startedAt +
        (execution.errorCode === '' ? '' : ' · ' + execution.errorCode) +
        (execution.message === '' ? '' : ' · ' + execution.message),
    )
  }
  return lines.join('\n')
}

export function createTaskTools(deps: TaskToolDeps) {
  const logger = deps.logger.child({ scope: 'tasks' })

  const createTask = defineTool({
    name: TASK_TOOL_NAMES.create,
    description:
      '在工作区的任务库中创建一个开发任务（SQLite 持久化）。只写任务库，不修改项目源码；数据库固定放在工作区的 .projectops/ 目录下。',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题（必填，非空）' },
      description: { type: 'string', description: '任务详情' },
      priority: { type: 'integer', description: '优先级，数字越大越靠前（默认 0）' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: '前置任务 id 列表（为工作流预留）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          task: { ...TASK_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTask(value.task) }],
    },
    async execute(args, exec) {
      const resolved = resolveStore(deps, exec)
      const task = resolved.store.create({
        title: args.title,
        description: args.description,
        priority: args.priority,
        dependsOn: args.dependsOn,
      })
      logger.info('task/create', '任务已创建', { id: task.id, state: task.state })
      return { root: resolved.root, task }
    },
  })

  const listTasks = defineTool({
    name: TASK_TOOL_NAMES.list,
    description: '列出工作区任务库中的任务，可按状态过滤。只读。',
    parameters: {
      state: { ...STATE_SCHEMA, description: '只看某个状态：pending / in_progress / completed / failed' },
      limit: { type: 'integer', description: '最多返回多少条（默认 50）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          counts: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              pending: { type: 'integer', required: true },
              in_progress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
              failed: { type: 'integer', required: true },
            },
          },
          tasks: { type: 'array', required: true, items: TASK_SCHEMA },
        },
      },
      render: (_args, value) => {
        const header =
          '## 任务列表\n\n总计：待处理 ' +
          value.counts.pending +
          ' · 进行中 ' +
          value.counts.in_progress +
          ' · 已完成 ' +
          value.counts.completed +
          ' · 失败 ' +
          value.counts.failed
        if (value.tasks.length === 0) return [{ type: 'text', text: header + '\n\n_没有匹配的任务_' }]
        const rows = value.tasks.map(
          (task: { id: string; state: string; title: string; priority: number }) =>
            '- [' + task.state + '] ' + task.title + '（' + task.id + '，优先级 ' + task.priority + '）',
        )
        return [{ type: 'text', text: header + '\n\n' + rows.join('\n') }]
      },
    },
    async execute(args, exec) {
      const resolved = resolveStore(deps, exec)
      const state = args.state as TaskState | undefined
      if (state !== undefined && !isTaskState(state)) {
        throw new ProjectOpsError(ErrorCode.INVALID_PATH, '非法任务状态: ' + String(state))
      }
      const tasks = resolved.store.list({ state, limit: args.limit ?? 50 })
      return { root: resolved.root, counts: resolved.store.counts(), tasks }
    },
  })

  const getTask = defineTool({
    name: TASK_TOOL_NAMES.get,
    description: '读取单个任务的详情与最近的执行记录。只读。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id（task_ 开头）' },
      executionLimit: { type: 'integer', description: '最多返回多少条执行记录（默认 10）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          task: { ...TASK_SCHEMA, required: true },
          executions: { type: 'array', required: true, items: EXECUTION_SCHEMA },
          dependencies: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                state: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocked = value.dependencies.filter(
          (dependency: { id: string; state: string; title: string }) => dependency.state !== 'completed',
        )
        const blockedText =
          blocked.length === 0
            ? ''
            : '\n\n#### 阻塞项\n' +
              blocked
                .map(
                  (dependency: { id: string; state: string; title: string }) =>
                    '- ' + dependency.id + '（' + dependency.state + '）' + (dependency.title === '' ? '' : ' ' + dependency.title),
                )
                .join('\n')
        return [{ type: 'text', text: renderTask(value.task) + blockedText + '\n\n' + renderExecutions(value.executions) }]
      },
    },
    async execute(args, exec) {
      const resolved = resolveStore(deps, exec)
      const task = resolved.store.get(args.id)
      if (task === undefined) throw new ProjectOpsError(ErrorCode.NOT_FOUND, '任务不存在: ' + args.id)
      const executions = resolved.store.listExecutions(args.id, args.executionLimit ?? 10)
      const dependencies = resolved.store.dependencyStatus(args.id)
      return { root: resolved.root, task, executions, dependencies }
    },
  })

  const updateTask = defineTool({
    name: TASK_TOOL_NAMES.update,
    description:
      '更新任务状态或字段，并自动写入一条执行记录。进入 in_progress 时尝试次数 +1；失败时用 message 记录原因（写入前自动脱敏）。只写任务库。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id' },
      state: { ...STATE_SCHEMA, description: '新状态' },
      title: { type: 'string', description: '新标题' },
      description: { type: 'string', description: '新描述' },
      priority: { type: 'integer', description: '新优先级' },
      message: { type: 'string', description: '执行记录里的一句话说明（会自动脱敏）' },
      errorCode: { type: 'string', description: '失败时的错误码，例如 PERMISSION_DENIED' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          task: { ...TASK_SCHEMA, required: true },
          execution: { ...EXECUTION_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: renderTask(value.task) + '\n\n' + renderExecutions([value.execution]) },
      ],
    },
    async execute(args, exec) {
      const resolved = resolveStore(deps, exec)
      const existing = resolved.store.get(args.id)
      if (existing === undefined) throw new ProjectOpsError(ErrorCode.NOT_FOUND, '任务不存在: ' + args.id)

      const nextState = (args.state as TaskState | undefined) ?? existing.state
      // 重试策略：失败过的任务重新进入 in_progress 时，attempts 已达上限则拒绝，避免无限重试。
      if (nextState === 'in_progress' && existing.state === 'failed' && existing.attempts >= deps.defaults.maxAttempts) {
        throw new ProjectOpsError(
          ErrorCode.TASK_RETRY_EXHAUSTED,
          '任务已达重试上限（' + existing.attempts + '/' + deps.defaults.maxAttempts + '），请先分析失败原因或拆小任务',
        )
      }
      const attempts = nextState === 'in_progress' ? existing.attempts + 1 : existing.attempts
      const exhausted = nextState === 'failed' && attempts >= deps.defaults.maxAttempts
      const lastError =
        nextState === 'failed'
          ? (exhausted ? '[已达重试上限] ' : '') + (args.message ?? existing.lastError)
          : existing.lastError

      // 状态变更与执行记录在同一事务里，避免"改了状态但没留下执行记录"。
      const changed = resolved.store.transition(args.id, {
        patch: {
          state: nextState,
          title: args.title,
          description: args.description,
          priority: args.priority,
          attempts,
          lastError,
        },
        execution: {
          state: nextState,
          message: args.message ?? '',
          errorCode: args.errorCode ?? '',
        },
      })
      const task = changed.task
      const execution = changed.execution as NonNullable<typeof changed.execution>
      logger.info('task/update', '任务状态已更新', { id: task.id, state: task.state, attempts: task.attempts })
      return { root: resolved.root, task, execution }
    },
  })

  return [createTask, listTasks, getTask, updateTask]
}
