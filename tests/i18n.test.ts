import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranslator, loadCatalog, localizeTool, localizeTools, resolveLocale, SUPPORTED_LOCALES } from '../lib/i18n/index.js'
import { createScanProjectTool } from '../lib/tools/scan-project.js'
import { createAnalyzeDependenciesTool } from '../lib/tools/analyze-dependencies.js'
import { createDocTools } from '../lib/tools/doc-tools.js'
import { createTaskTools } from '../lib/tools/task-tools.js'
import { createPluginInfoTools, PLUGIN_TOOL_NAMES } from '../lib/tools/plugin-info.js'
import { createScanCache } from '../lib/services/scan-cache.js'
import { createTaskService } from '../lib/services/task-service.js'
import { createLogBuffer } from '../lib/util/log-buffer.js'
import { createLogger } from '../lib/util/logger.js'

const zh = loadCatalog('zh')
const en = loadCatalog('en')

const logger = createLogger({ sink: () => {}, level: 'error' })
const taskService = createTaskService({ directory: '.projectops' })

function allTools() {
  const defaults = {
    allowedRoots: [] as string[],
    maxDepth: 4,
    maxEntries: 100,
    includeHidden: false,
    extraExcludes: [] as string[],
    maxFiles: 100,
    maxFileBytes: 65536,
  }
  return [
    createScanProjectTool({ defaults, cache: createScanCache({ ttlMs: 0 }), logger }),
    createAnalyzeDependenciesTool({ defaults, logger }),
    ...createDocTools({ defaults, logger }),
    ...createTaskTools({ defaults: { allowedRoots: [], maxAttempts: 3 }, service: taskService, logger }),
    ...createPluginInfoTools({ buffer: createLogBuffer(), registeredTools: [], config: {}, startedAt: 'x' }),
  ]
}

test('i18n：两种语言的键集合必须完全一致（防止漏译/多译）', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length > 40, '目录应覆盖全部工具与参数')
})

test('i18n：10 个工具的描述与每个参数都有 en/zh 文案', () => {
  const tools = allTools()
  assert.equal(tools.length, 10, '工具数量变化时请同步文案')
  const missing: string[] = []
  for (const tool of tools) {
    if (!zh['tool.' + tool.name + '.description']) missing.push('zh description: ' + tool.name)
    if (!en['tool.' + tool.name + '.description']) missing.push('en description: ' + tool.name)
    const schema = tool.parameters as { properties?: Record<string, unknown> }
    for (const param of Object.keys(schema.properties ?? {})) {
      if (!zh['tool.' + tool.name + '.params.' + param]) missing.push('zh param: ' + tool.name + '.' + param)
      if (!en['tool.' + tool.name + '.params.' + param]) missing.push('en param: ' + tool.name + '.' + param)
    }
  }
  assert.deepEqual(missing, [], '缺失文案: ' + missing.join(', '))
  for (const locale of SUPPORTED_LOCALES) assert.ok(loadCatalog(locale))
})

test('i18n：localizeTools 用目录覆盖描述与参数说明，缺键时保留原文', () => {
  const tool = createScanProjectTool({
    defaults: { allowedRoots: [], maxDepth: 4, maxEntries: 100, includeHidden: false, extraExcludes: [] },
    cache: createScanCache({ ttlMs: 0 }),
    logger,
  })
  const enTools = localizeTools([tool], createTranslator('en'))
  assert.ok(enTools[0]!.description.startsWith('Scan a project directory'))
  const enSchema = enTools[0]!.parameters as { properties: Record<string, { description?: string }> }
  assert.ok(String(enSchema.properties.path?.description).startsWith('Project directory'), '参数说明必须被翻译')

  const zhTools = localizeTools([tool], createTranslator('zh'))
  assert.ok(zhTools[0]!.description.startsWith('扫描一个已授权工作区'))

  const unknown = localizeTool({ name: 'unknown_tool', description: '原文', parameters: { a: { type: 'string' } }, output: {}, execute: {} }, createTranslator('en'))
  assert.equal(unknown.description, '原文', '缺键时不能用 key 覆盖原文')
})

test('i18n：locale 解析（显式优先，其次环境变量）', () => {
  assert.equal(resolveLocale('zh'), 'zh')
  assert.equal(resolveLocale('en'), 'en')
  const previous = process.env.DSH_LOCALE
  try {
    process.env.DSH_LOCALE = 'zh-CN'
    assert.equal(resolveLocale('auto'), 'zh')
    process.env.DSH_LOCALE = 'fr-FR'
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase()
    assert.equal(resolveLocale(undefined), intlLocale.startsWith('zh') ? 'zh' : 'en', '无环境变量时应回落到系统区域')
  } finally {
    if (previous === undefined) delete process.env.DSH_LOCALE
    else process.env.DSH_LOCALE = previous
  }
})
