// 测试用 ESM 解析钩子。
//
// 插件源码里以 bare specifier 形式导入 @deepseek-ai/* （和宿主里运行时的行为一致）。
// 测试进程不在 DSH 宿主内部，所以要显式把这些导入指向本机已安装的 DSH 运行时包，
// 这样测试跑的就是宿主真正使用的那份 cordis / dsh-tools，而不是替身实现。
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function candidateRuntimeDirs() {
  const candidates = []
  if (process.env.DSH_RUNTIME_DIR) candidates.push(resolve(process.env.DSH_RUNTIME_DIR))
  const exeDir = dirname(process.execPath)
  candidates.push(join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules'))
  candidates.push(join(exeDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
  if (process.env.PROGRAMFILES) {
    candidates.push(join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules'))
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(
      join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules'),
    )
  }
  return candidates
}

function findRuntimeNodeModules() {
  for (const candidate of candidateRuntimeDirs()) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools', 'package.json'))) return candidate
  }
  return undefined
}

const FORCE_MOCK = process.env.DSH_FORCE_MOCK === '1'
// DSH_FORCE_MOCK=1 强制使用契约替身，用来在装有 DSH 的机器上复现 CI 环境
const RUNTIME_NODE_MODULES_RAW = FORCE_MOCK ? undefined : findRuntimeNodeModules()
export const RUNTIME_NODE_MODULES = RUNTIME_NODE_MODULES_RAW

// 无 DSH 时把 @deepseek-ai/dsh-tools 指向本地契约替身：工具层测试仍可运行。
if (RUNTIME_NODE_MODULES === undefined) {
  const { registerHooks: hook } = await import('node:module')
  hook({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/dsh-tools') {
        return { url: new URL('./mock-dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
      }
      if (specifier === '@deepseek-ai/schemastery') {
        return { url: new URL('./mock-schemastery.mjs', import.meta.url).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

function resolvePackageEntry(specifier) {
  if (RUNTIME_NODE_MODULES === undefined) return undefined
  const parts = specifier.split('/')
  if (parts.length < 2) return undefined
  const scope = parts[0]
  const name = parts[1]
  const packageDir = join(RUNTIME_NODE_MODULES, scope, name)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const subpath = parts.length > 2 ? './' + parts.slice(2).join('/') : '.'
  let entry
  const exported = manifest.exports ? manifest.exports[subpath] : undefined
  if (typeof exported === 'string') entry = exported
  else if (exported && typeof exported === 'object') entry = exported.import ?? exported.default ?? exported.require
  if (entry === undefined && subpath === '.') entry = manifest.module ?? manifest.main
  if (typeof entry !== 'string') return undefined
  return pathToFileURL(join(packageDir, entry)).href
}

const MOCK_TOOLS_URL = new URL('./mock-dsh-tools.mjs', import.meta.url).href

if (RUNTIME_NODE_MODULES === undefined) {
  process.emitWarning('未找到 DSH 运行时：工具层测试将使用 tests/support/mock-dsh-tools.mjs 契约替身（设置 DSH_RUNTIME_DIR 可改用真实运行时）')
}

if (RUNTIME_NODE_MODULES !== undefined) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/')) {
        const url = resolvePackageEntry(specifier)
        if (url !== undefined) return { url, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}
