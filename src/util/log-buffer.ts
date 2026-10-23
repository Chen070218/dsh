/** 日志环形缓冲：默认不写 stderr，但最近 200 条可被 plugin_logs 查询（写入前已脱敏）。 */
import type { LogRecord, LogSink, Logger } from './logger.js'
import { createLogger } from './logger.js'

export interface LogBuffer {
  sink: LogSink
  recent(limit?: number): LogRecord[]
  readonly size: number
}

export function createLogBuffer(capacity = 200): LogBuffer {
  const records: LogRecord[] = []
  return {
    get size() {
      return records.length
    },
    sink(record) {
      records.push(record)
      if (records.length > capacity) records.splice(0, records.length - capacity)
    },
    recent(limit = 50) {
      const count = Math.max(1, Math.trunc(limit))
      return records.slice(Math.max(0, records.length - count))
    },
  }
}

export function fanoutSink(sinks: readonly LogSink[]): LogSink {
  return (record) => {
    for (const sink of sinks) {
      try {
        sink(record)
      } catch {
        // 日志失败不能影响主流程
      }
    }
  }
}

export function createBufferedLogger(options: {
  buffer: LogBuffer
  extraSinks?: readonly LogSink[]
  level?: Logger['level']
  fields?: Record<string, unknown>
}): Logger {
  return createLogger({
    sink: fanoutSink([options.buffer.sink, ...(options.extraSinks ?? [])]),
    level: options.level,
    fields: options.fields,
  })
}
