import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPluginInfoTools, PLUGIN_TOOL_NAMES } from '../lib/tools/plugin-info.js'
import { createBufferedLogger, createLogBuffer } from '../lib/util/log-buffer.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../lib/version.js'

function buildTools(overrides: { tools?: string[]; config?: Record<string, unknown> } = {}) {
  const buffer = createLogBuffer(5)
  const tools = createPluginInfoTools({
    buffer,
    registeredTools: overrides.tools ?? ['scan_project', 'analyze_dependencies'],
    config: overrides.config ?? { maxDepth: 6, allowedRoots: [] },
    startedAt: '2026-01-01T00:00:00.000Z',
  })
  return { buffer, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

test('版本自证：源码常量与 package.json 必须一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_VERSION, pkg.version, 'PLUGIN_VERSION 与 package.json 版本不一致，升级时忘同步')
  assert.equal(PLUGIN_NAME, pkg.name)
})

test('plugin_info：返回版本、构建时间、配置与已注册工具', async () => {
  const { byName } = buildTools({ tools: ['scan_project', 'plugin_info'] })
  const info = byName.get(PLUGIN_TOOL_NAMES.info)!
  const value = await info.execute({}, { signal: new AbortController().signal })

  assert.equal(value.name, 'dsh-projectops')
  assert.equal(value.version, PLUGIN_VERSION)
  assert.ok(value.buildTime === 'unknown' || value.buildTime.includes('T'), '构建时间应是 ISO 或 unknown')
  assert.deepEqual(value.tools, ['scan_project', 'plugin_info'])
  assert.equal(value.registeredAt, '2026-01-01T00:00:00.000Z')
  assert.equal(value.config.maxDepth, 6)
  assert.equal(typeof value.staleBuild, 'boolean')
})

test('plugin_info 渲染：包含版本与配置摘要', async () => {
  const { byName } = buildTools()
  const info = byName.get(PLUGIN_TOOL_NAMES.info)!
  const value = await info.execute({}, { signal: new AbortController().signal })
  const rendered = info.output.render({}, value)
  const text = rendered[0]?.text ?? ''
  assert.ok(text.includes('插件状态'))
  assert.ok(text.includes(PLUGIN_VERSION))
  assert.ok(text.includes('maxDepth = 6'))
})

test('日志环形缓冲：超出容量后保留最新记录', () => {
  const buffer = createLogBuffer(3)
  const logger = createBufferedLogger({ buffer, level: 'debug' })
  for (const event of ['e1', 'e2', 'e3', 'e4', 'e5']) logger.info(event)
  assert.equal(buffer.size, 3)
  assert.deepEqual(buffer.recent(10).map((record) => record.event), ['e3', 'e4', 'e5'])
  assert.deepEqual(buffer.recent(1).map((record) => record.event), ['e5'])
})

test('plugin_logs：返回缓冲日志并支持级别过滤', async () => {
  const buffer = createLogBuffer(10)
  const logger = createBufferedLogger({ buffer, level: 'debug' })
  logger.info('a', '普通')
  logger.error('b', '出错', { apiKey: 'sk-secret' })
  const { byName } = buildTools()
  const logsTool = createPluginInfoTools({
    buffer,
    registeredTools: [],
    config: {},
    startedAt: 'x',
  }).find((tool) => tool.name === PLUGIN_TOOL_NAMES.logs)!

  const all = await logsTool.execute({ limit: 10 }, { signal: new AbortController().signal })
  assert.equal(all.records.length, 2)
  assert.ok(!JSON.stringify(all).includes('sk-secret'), '日志里的密钥必须已脱敏')

  const errors = await logsTool.execute({ level: 'error' }, { signal: new AbortController().signal })
  assert.equal(errors.records.length, 1)
  assert.equal(errors.records[0]?.event, 'b')
  void byName
})
