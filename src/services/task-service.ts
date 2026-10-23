/**
 * 任务服务：按工作区懒加载 TaskStore，并保证数据库文件只落在授权工作区内。
 *
 * 为什么要按工作区缓存：一个会话可能操作多个授权目录，任务库应各自独立（互不污染）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteTaskStore } from '../storage/sqlite-task-store.js'
import type { TaskStore } from '../storage/task-store.js'
import type { Logger } from '../util/logger.js'

export interface TaskServiceOptions {
  /** 工作区内的相对目录名，默认 .projectops。 */
  directory?: string
  logger?: Logger
}

export interface TaskService {
  forWorkspace(root: string): TaskStore
  closeAll(): void
  readonly size: number
}

export function createTaskService(options: TaskServiceOptions = {}): TaskService {
  const directory = options.directory ?? '.projectops'
  const stores = new Map<string, TaskStore>()

  return {
    get size() {
      return stores.size
    },
    forWorkspace(root) {
      const cached = stores.get(root)
      if (cached !== undefined) return cached
      const targetDir = join(root, directory)
      mkdirSync(targetDir, { recursive: true })
      const store = createSqliteTaskStore({ filename: join(targetDir, 'tasks.db') })
      stores.set(root, store)
      options.logger?.info('tasks/open', '任务数据库已打开', { root, directory })
      return store
    },
    closeAll() {
      for (const store of stores.values()) {
        try {
          store.close()
        } catch {
          // 关闭失败不应影响插件卸载
        }
      }
      stores.clear()
    },
  }
}
