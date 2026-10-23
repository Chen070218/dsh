import test from 'node:test'
import assert from 'node:assert/strict'
import { instrumentTools, summarizeOutput } from '../lib/tools/instrument.js'
import { createLogger } from '../lib/util/logger.js'
import type { LogRecord } from '../lib/util/logger.js'

function recorder() {
  const records: LogRecord[] = []
  return { records, logger: createLogger({ sink: (record) => records.push(record), level: 'debug' }) }
}

test('埋点：只抽取计数字段，不把内容写进日志', () => {
  const summary = summarizeOutput({
    root: '/secret/path',
    preview: '文件内容不该进日志',
    stats: { files: 3, bytes: 1024, modules: 2 },
    findings: [{ message: 'x' }, { message: 'y' }],
    written: false,
  })
  assert.deepEqual(summary, { files: 3, bytes: 1024, modules: 2, written: false, findingsCount: 2 })
})

test('埋点：成功记 info，失败记 warn 并带上错误码', async () => {
  const { records, logger } = recorder()
  const [ok, bad] = instrumentTools(
    [
      { name: 'ok_tool', async execute() { return { stats: { files: 1 } } } },
      {
        name: 'bad_tool',
        async execute() {
          const error = new Error('boom') as Error & { code?: string }
          error.code = 'PATH_OUTSIDE_WORKSPACE'
          throw error
        },
      },
    ],
    logger,
  )
  await ok!.execute({}, {})
  await assert.rejects(() => bad!.execute({}, {}), /boom/)
  assert.equal(records[0]?.level, 'info')
  assert.equal(records[0]?.fields.files, 1)
  assert.equal(records[1]?.level, 'warn')
  assert.equal(records[1]?.fields.errorCode, 'PATH_OUTSIDE_WORKSPACE')
  assert.ok(!JSON.stringify(records).includes('boom'), '错误消息正文不应进日志')
})
