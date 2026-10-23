/**
 * 集成测试（加载路径）：用真实的 cordis PluginLoader 按「插件包名」挂载 dsh-projectops。
 *
 * 宿主加载 profile 插件的真实链路是：
 *   bundle -> cordis.patch.yml -> entry(name) -> Loader 按名字解析包目录 -> import -> apply
 * 其中「按名字解析包目录」由 dsh-app-boot 的 packageDirFromParent（createRequire().resolve.paths）完成，
 * 这里 1:1 复刻同一逻辑，指向一个模拟 profile 目录（node_modules 里放指向本仓库的目录联接），
 * 再通过 Loader 的 internal.import 钩子把包名交给它解析。
 *
 * 这样测试覆盖的是「宿主真的能按名字找到并挂载这个包」，而不是直接 import 源码文件。
 * 安全注意：清理时绝不能递归删除含联接的目录（Windows 下可能顺着联接删到本仓库里）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createTempProject } from './support/temp-project.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 复刻 dsh-app-boot 的 packageDirFromParent：用 createRequire 的搜索路径找包目录。 */
function packageDirFromParent(parentDir: string, name: string): string | undefined {
  const require = createRequire(pathToFileURL(join(parentDir, 'package.json')).href)
  for (const searchPath of require.resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** 读包的入口文件（exports["."] 优先，其次 main）。 */
function packageEntryFile(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const exported = manifest.exports?.['.']
  const entry = typeof exported === 'string' ? exported : (exported?.default ?? exported?.import ?? manifest.main)
  return join(packageDir, entry)
}

/** 模拟一个 profile 目录：只放 package.json 和一个指向本仓库的 node_modules 联接。 */
function createProfileSim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-projectops-profile-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile-sim', private: true }, null, 2))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(projectRoot, join(dir, 'node_modules', 'dsh-projectops'), 'junction')
  return dir
}

/**
 * 清理模拟 profile。
 *
 * 安全约束（踩过坑）：node_modules/dsh-projectops 是指向本仓库的目录联接，
 * 绝不能对包含它的目录做递归删除——Windows 下可能顺着联接删到目标目录里去。
 * 因此这里只对「联接本身」做非递归 rmdir；一旦无法确认它是联接，就直接放弃清理，
 * 宁可留下临时目录，也不能冒删除仓库内容的风险。
 */
function removeProfileSim(dir: string): void {
  const link = join(dir, 'node_modules', 'dsh-projectops')
  if (!dir.startsWith(tmpdir())) return
  try {
    if (!lstatSync(link).isSymbolicLink()) return
    rmdirSync(link)
  } catch {
    return
  }
  rmSync(dir, { recursive: true, force: true })
}

/** dsh-tools 的 ToolRuntime 依赖 systemPrompt 服务，这里给最小替身。 */
class StubSystemPrompt extends Service {
  constructor(ctx: any) {
    super(ctx, 'systemPrompt')
  }

  tools() {
    return () => {}
  }

  section() {
    return () => {}
  }
}

interface MountedLoader {
  root: any
  root2?: never
}

async function mountWithLoader(profileDir: string, config: Record<string, unknown>): Promise<any> {
  const root: any = new Context()
  // 注意：cordis 的对象插件要用方法简写形式的 apply；箭头函数形式的 apply 不会被识别。
  root.plugin({ name: 'stub-system-prompt', apply(ctx: any) { ctx.plugin(StubSystemPrompt) } })
  root.plugin({ name: 'dsh-tools-runtime', apply(ctx: any) { ctx.plugin(ToolRuntime, {}) } })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(typeof root.tools, 'object', 'ToolRuntime 服务应已就绪')

  await root.plugin(Loader, { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href })
  root.loader.internal = {
    async import(name: string) {
      if (name.startsWith('.') || name.startsWith('/')) return import(name)
      const packageDir = packageDirFromParent(profileDir, name)
      if (packageDir === undefined) throw new Error('cannot resolve plugin package: ' + name)
      return import(pathToFileURL(packageEntryFile(packageDir)).href)
    },
  }

  await root.loader.create({ name: 'dsh-projectops', config })
  await root.loader.await()
  return root
}

test('加载路径：按包名从模拟 profile 解析到 dsh-projectops 的入口', () => {
  const profileDir = createProfileSim()
  try {
    const packageDir = packageDirFromParent(profileDir, 'dsh-projectops')
    assert.ok(packageDir, 'profile 的 node_modules 里应能解析到 dsh-projectops')
    const entryFile = packageEntryFile(packageDir)
    assert.equal(realpathSync.native(entryFile), realpathSync.native(join(projectRoot, 'lib', 'index.js')))
    assert.ok(existsSync(entryFile), '构建产物 lib/index.js 必须存在')
  } finally {
    removeProfileSim(profileDir)
  }
})

test('加载路径：真实 PluginLoader 按插件名挂载插件并注册两个工具', async () => {
  const profileDir = createProfileSim()
  const project = createTempProject({ 'app/main.py': 'print(1)' })
  try {
    const root = await mountWithLoader(profileDir, {
      allowedRoots: [project.root],
      maxDepth: 4,
      logLevel: 'debug',
      logToConsole: false,
    })

    const definition = root.tools.get('scan_project')
    assert.ok(definition, 'Loader 挂载后应注册 scan_project')
    const names = root.tools.schemas().map((schema: any) => schema.name)
    assert.ok(names.includes('scan_project'))
    assert.ok(names.includes('analyze_dependencies'), '第三阶段的工具也应注册')
    for (const taskTool of ['task_create', 'task_list', 'task_get', 'task_update']) {
      assert.ok(names.includes(taskTool), '第四阶段的任务工具应注册: ' + taskTool)
    }
    for (const metaTool of ['plugin_info', 'plugin_logs']) {
      assert.ok(names.includes(metaTool), '自证类工具应注册: ' + metaTool)
    }
    for (const docTool of ['generate_architecture_report', 'generate_readme_draft']) {
      assert.ok(names.includes(docTool), '第五阶段的文档工具应注册: ' + docTool)
    }

    const result = await root.tools.execute({
      callId: 'loader-1',
      name: 'scan_project',
      arguments: { path: project.root },
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false, JSON.stringify(result).slice(0, 300))
    assert.equal(result.value.root, project.root)
    assert.equal(result.value.detection.primaryLanguage, 'Python')
    assert.ok(String(result.content[0]?.text).includes('项目扫描结果'))
  } finally {
    project.cleanup()
    removeProfileSim(profileDir)
  }
})

test('加载路径：非法配置在挂载阶段就被 schema 拒绝', async () => {
  const profileDir = createProfileSim()
  try {
    const root = await mountWithLoader(profileDir, { maxDepth: -5 })
    assert.equal(root.tools.get('scan_project'), undefined, '配置非法时不应该注册工具')
  } finally {
    removeProfileSim(profileDir)
  }
})
