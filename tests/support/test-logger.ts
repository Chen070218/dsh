import { createLogger } from '../../lib/util/logger.js'
import type { LogRecord, Logger } from '../../lib/util/logger.js'

/** 收集日志用于断言，同时保持静默（不写 stdout/stderr）。 */
export function createCapturingLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): {
  logger: Logger
  records: LogRecord[]
} {
  const records: LogRecord[] = []
  const logger = createLogger({ sink: (record) => records.push(record), level })
  return { logger, records }
}
