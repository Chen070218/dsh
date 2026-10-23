import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../lib/util/logger.js'
import type { LogRecord } from '../lib/util/logger.js'

test('日志：按级别过滤', () => {
  const records: LogRecord[] = []
  const logger = createLogger({ sink: (record) => records.push(record), level: 'warn' })
  logger.debug('d')
  logger.info('i')
  logger.warn('w', '警告', { files: 3 })
  logger.error('e')
  assert.deepEqual(records.map((record) => record.level), ['warn', 'error'])
  assert.equal(records[0]?.fields.files, 3)
})

test('日志：敏感字段自动脱敏', () => {
  const records: LogRecord[] = []
  const logger = createLogger({ sink: (record) => records.push(record), level: 'debug' })
  logger.info('auth', '尝试登录', { apiKey: 'sk-real-key', token: 'abc', user: 'alice' })
  const fields = records[0]?.fields ?? {}
  assert.equal(fields.apiKey, '[redacted]')
  assert.equal(fields.token, '[redacted]')
  assert.equal(fields.user, 'alice')
  assert.ok(!JSON.stringify(records).includes('sk-real-key'))
})

test('日志：child 继承基础字段但不覆盖父级', () => {
  const records: LogRecord[] = []
  const logger = createLogger({ sink: (record) => records.push(record), level: 'debug', fields: { plugin: 'x' } })
  logger.child({ tool: 'scan_project' }).info('run')
  assert.equal(records[0]?.fields.plugin, 'x')
  assert.equal(records[0]?.fields.tool, 'scan_project')
})
