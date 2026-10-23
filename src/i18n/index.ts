/**
 * 极简 i18n：目录文件是唯一真源（locale/zh.json、locale/en.json），运行时按配置读取。
 *
 * 为什么不做全量文案抽象：报告正文本身是数据驱动的中文模板，逐句翻译的收益远低于维护成本；
 * 这里覆盖「模型看到的面」——10 个工具的描述与参数说明，并用测试强制两种语言键集合一致。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SUPPORTED_LOCALES = ['zh', 'en'] as const

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]

export type Catalog = Record<string, string>

const cache = new Map<LocaleCode, Catalog>()

function catalogUrl(locale: LocaleCode): URL {
  return new URL('../../locale/' + locale + '.json', import.meta.url)
}

export function loadCatalog(locale: LocaleCode): Catalog {
  const cached = cache.get(locale)
  if (cached !== undefined) return cached
  try {
    const parsed = JSON.parse(readFileSync(fileURLToPath(catalogUrl(locale)), 'utf8'))
    const catalog: Catalog = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') catalog[key] = value
    }
    cache.set(locale, catalog)
    return catalog
  } catch {
    const empty: Catalog = {}
    cache.set(locale, empty)
    return empty
  }
}

/**
 * auto 的判定顺序：显式配置 -> DSH_LOCALE/LC_ALL/LANG -> Intl（宿主的系统区域）-> 英文。
 *
 * 为什么需要 Intl：DSH 桌面进程里通常没有 LANG/LC_ALL，只看环境变量会让中文系统退回英文，
 * 等于把中文用户的工具说明全变成英文（这是实测发现的问题：日志里出现 locale: "en"）。
 */
export function resolveLocale(requested: string | undefined): LocaleCode {
  if (requested === 'zh' || requested === 'en') return requested
  const envHint = (process.env.DSH_LOCALE ?? process.env.LC_ALL ?? process.env.LANG ?? '').toLowerCase()
  if (envHint.includes('zh')) return 'zh'
  if (envHint.includes('en')) return 'en'
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions().locale
    if (typeof intl === 'string' && intl.toLowerCase().startsWith('zh')) return 'zh'
  } catch {
    // 忽略：拿不到系统区域就退回英文
  }
  return 'en'
}

export interface Translator {
  readonly locale: LocaleCode
  (key: string, fallback?: string): string
}

export function createTranslator(locale: LocaleCode): Translator {
  const catalog = loadCatalog(locale)
  const fallbackCatalog = loadCatalog(locale === 'zh' ? 'en' : 'zh')
  const translate = (key: string, fallback?: string): string => catalog[key] ?? fallbackCatalog[key] ?? fallback ?? key
  return Object.assign(translate, { locale })
}

export interface LocalizableTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: unknown
  execute: unknown
}

/**
 * 用目录覆盖工具描述与参数说明。
 *
 * 注意：defineTool 返回的 parameters 已经是**编译后的 JSON Schema**（{ type: 'object', properties }），
 * 因此要按 properties 的属性名覆盖 description —— 直接遍历 parameters 只会改到 type/properties 这两个键，
 * 参数说明根本不会被翻译（这个 bug 是被文案完整性测试抓出来的）。
 * 目录缺键时保留原文，绝不把 description 变成 key。
 */
export function localizeTool<T extends LocalizableTool>(tool: T, t: Translator): T {
  const description = t('tool.' + tool.name + '.description', tool.description)
  const schema = tool.parameters as { properties?: Record<string, { description?: string } | unknown> } & Record<string, unknown>
  const properties: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    const hint = t('tool.' + tool.name + '.params.' + name, '')
    properties[name] = hint === '' || typeof spec !== 'object' || spec === null ? spec : { ...(spec as Record<string, unknown>), description: hint }
  }
  return { ...tool, description, parameters: { ...schema, properties } }
}

export function localizeTools<T extends LocalizableTool>(tools: readonly T[], t: Translator): T[] {
  return tools.map((tool) => localizeTool(tool, t))
}
