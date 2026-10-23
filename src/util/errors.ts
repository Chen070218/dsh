/** 统一错误模型：每个失败都带稳定的机器可读 code，便于工具层判断与日志记录。 */

export const ErrorCode = {
  INVALID_PATH: 'INVALID_PATH',
  PATH_OUTSIDE_WORKSPACE: 'PATH_OUTSIDE_WORKSPACE',
  NOT_FOUND: 'NOT_FOUND',
  NOT_A_DIRECTORY: 'NOT_A_DIRECTORY',
  NOT_A_FILE: 'NOT_A_FILE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  READ_FAILED: 'READ_FAILED',
  /** 任务已达重试上限，需要人工介入或拆小任务。 */
  TASK_RETRY_EXHAUSTED: 'TASK_RETRY_EXHAUSTED',
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export class ProjectOpsError extends Error {
  readonly code: ErrorCode
  readonly detail: string | undefined

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'ProjectOpsError'
    this.code = code
    this.detail = detail
  }
}

export function isProjectOpsError(value: unknown): value is ProjectOpsError {
  return value instanceof ProjectOpsError
}

/** Node 的 errno 字符串（ENOENT/EACCES/...）不是公开 API，这里只做防御式读取。 */
function readSystemCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

export function mapFsError(error: unknown, target: string): ProjectOpsError {
  if (isProjectOpsError(error)) return error
  const detail = error instanceof Error ? error.message : String(error)
  switch (readSystemCode(error)) {
    case 'ENOENT':
      return new ProjectOpsError(ErrorCode.NOT_FOUND, '路径不存在: ' + target, detail)
    case 'EACCES':
    case 'EPERM':
      return new ProjectOpsError(ErrorCode.PERMISSION_DENIED, '没有访问权限: ' + target, detail)
    case 'ENOTDIR':
      return new ProjectOpsError(ErrorCode.NOT_A_DIRECTORY, '不是目录: ' + target, detail)
    case 'EISDIR':
      return new ProjectOpsError(ErrorCode.NOT_A_FILE, '不是文件: ' + target, detail)
    case 'ELOOP':
      return new ProjectOpsError(ErrorCode.INVALID_PATH, '符号链接层级过深: ' + target, detail)
    default:
      return new ProjectOpsError(ErrorCode.READ_FAILED, '读取失败: ' + target, detail)
  }
}

export function describeError(error: unknown): string {
  if (isProjectOpsError(error)) return error.code + ': ' + error.message
  if (error instanceof Error) return error.name + ': ' + error.message
  return String(error)
}
