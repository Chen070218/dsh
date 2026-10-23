/** 结构化日志：只记录事件与元数据，绝不写入文件内容或凭据。 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogRecord {
  time: string
  level: LogLevel
  event: string
  message: string
  fields: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

export interface Logger {
  readonly level: LogLevel
  debug(event: string, message?: string, fields?: Record<string, unknown>): void
  info(event: string, message?: string, fields?: Record<string, unknown>): void
  warn(event: string, message?: string, fields?: Record<string, unknown>): void
  error(event: string, message?: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

/** 键名命中即脱敏：宁可少记，也不能把密钥写进日志。 */
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|credential|private[-_]?key|authorization|cookie)/i

export function redactFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    output[key] = SECRET_KEY.test(key) ? '[redacted]' : value
  }
  return output
}

export interface LoggerOptions {
  sink: LogSink
  level?: LogLevel
  fields?: Record<string, unknown>
  clock?: () => Date
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info'
  const clock = options.clock ?? (() => new Date())
  const base = redactFields(options.fields ?? {})

  const write = (recordLevel: LogLevel, event: string, message?: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[recordLevel] < LEVEL_WEIGHT[level]) return
    options.sink({
      time: clock().toISOString(),
      level: recordLevel,
      event,
      message: message ?? '',
      fields: { ...base, ...redactFields(fields ?? {}) },
    })
  }

  return {
    level,
    debug: (event, message, fields) => write('debug', event, message, fields),
    info: (event, message, fields) => write('info', event, message, fields),
    warn: (event, message, fields) => write('warn', event, message, fields),
    error: (event, message, fields) => write('error', event, message, fields),
    child(fields) {
      return createLogger({ sink: options.sink, level, fields: { ...base, ...fields }, clock })
    },
  }
}

export function noopSink(): void {
  // 默认不写任何输出：插件在宿主进程里运行，除非用户显式打开 logToConsole。
}

export function stderrSink(record: LogRecord): void {
  process.stderr.write(JSON.stringify(record) + '\n')
}
