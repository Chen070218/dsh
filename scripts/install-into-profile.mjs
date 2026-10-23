#!/usr/bin/env node
/**
 * 把 dsh-projectops 挂进一个 DSH profile。
 *
 * 安全约定：
 * - 默认是 dry-run，只打印计划，不写任何文件；
 * - 真正写入必须显式加 --apply，并且会先把 package.json / cordis.patch.yml 备份到
 *   <profile>/.projectops-backup-<时间戳>/；
 * - --rollback 可以从最近一次备份恢复，并移除 node_modules 里的联接。
 *
 * 脚本只做三件事：登记依赖、加入 dsh.profile.bundles、把 bundle patch 追加到 cordis.patch.yml，
 * 再在 profile 的 node_modules 里建一个指向本仓库的目录联接（junction），不需要联网。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-projectops'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const rollback = args.includes('--rollback')
const profileArg = args.find((arg) => arg.startsWith('--profile='))
const profileName = profileArg
  ? profileArg.slice('--profile='.length)
  : guessProfileName()

/** 没显式指定 profile 时：优先 desktop，否则取 ~/.dsh/profiles 下第一个目录。 */
function guessProfileName() {
  try {
    const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    if (entries.some((entry) => entry.name === 'desktop')) return 'desktop'
    return entries[0]?.name ?? 'desktop'
  } catch {
    return 'desktop'
  }
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profileName)
const packagePath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const nodeModulesPath = join(profileDir, 'node_modules', PACKAGE_NAME)

function fail(message) {
  console.error('install: ' + message)
  process.exit(1)
}

function latestBackupDir() {
  const entries = readdirSync(profileDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.projectops-backup-'))
    .map((entry) => entry.name)
    .sort()
  const latest = entries.at(-1)
  return latest === undefined ? undefined : join(profileDir, latest)
}

if (!existsSync(packagePath) || !existsSync(patchPath)) {
  fail('找不到 profile 配置：' + profileDir)
}

if (rollback) {
  const backupDir = latestBackupDir()
  if (backupDir === undefined) fail('没有可用的备份目录')
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const source = join(backupDir, name)
    if (existsSync(source)) copyFileSync(source, join(profileDir, name))
  }
  // 只移除我们自己创建的目录联接，绝不对真实目录做递归删除。
  if (isLink(nodeModulesPath)) rmdirSync(nodeModulesPath)
  else if (existsSync(nodeModulesPath)) console.log('install: 跳过非联接目录: ' + nodeModulesPath)
  console.log('install: 已从 ' + backupDir + ' 恢复；请重启 DSH 使改动生效')
  process.exit(0)
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

// 加载来源说明（实测）：宿主按 dsh.profile.bundles 读每个 bundle 自己的 cordis.patch.yml（dsh.bundle.patch）。
// 因此**不需要**往 profile 的 cordis.patch.yml 里追加块——少改一个文件，就少一个被 DSH sanitize 的机会。
const spec = 'file:' + projectRoot.replace(/\\/g, '/')
const bundlePresent = manifest.dsh.profile.bundles.includes(PACKAGE_NAME)
const pluginPatch = [
  '# dsh-projectops（由 scripts/install-into-profile.mjs 追加）',
  '- insert:',
  '    - id: projectops',
  '      name: ' + PACKAGE_NAME,
  '      config:',
  '        allowedRoots: []',
  '        maxDepth: 6',
  '        maxEntries: 5000',
  '        includeHidden: false',
  '        extraExcludes: []',
  '        cacheTtlMs: 30000',
  '        maxFiles: 2000',
  '        maxFileBytes: 262144',
  '        tasksDirectory: .projectops',
  '        logLevel: warn',
  '        logToConsole: false',
  '',
].join('\n')
const patchText = readFileSync(patchPath, 'utf8')
const patchPresent = patchText.includes("name: " + PACKAGE_NAME)

console.log('install: profile      = ' + profileDir)
console.log('install: dependency   = ' + PACKAGE_NAME + ' -> ' + spec + (manifest.dependencies[PACKAGE_NAME] ? ' (已存在)' : ''))
console.log('install: bundle 条目  = ' + (bundlePresent ? '已存在' : '将追加到 dsh.profile.bundles'))
console.log('install: cordis patch = 不需要（宿主按 bundle 读取包内 patch）')
console.log('install: node_modules 联接 = ' + (existsSync(nodeModulesPath) ? '已存在' : '将创建 ' + nodeModulesPath))

if (!apply) {
  console.log('install: 这是 dry-run。确认无误后加 --apply 真正写入（会先备份）。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(profileDir, '.projectops-backup-' + stamp)
mkdirSync(backupDir, { recursive: true })
copyFileSync(packagePath, join(backupDir, 'package.json'))
copyFileSync(patchPath, join(backupDir, 'cordis.patch.yml'))

manifest.dependencies[PACKAGE_NAME] = spec
if (!bundlePresent) manifest.dsh.profile.bundles.push(PACKAGE_NAME)
writeFileSync(packagePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
// 不再写 profile patch：bundle 机制已经足够（见上）

if (!existsSync(nodeModulesPath)) {
  mkdirSync(dirname(nodeModulesPath), { recursive: true })
  // Windows 用 junction（不需要管理员权限），macOS/Linux 用普通目录符号链接
  symlinkSync(projectRoot, nodeModulesPath, process.platform === 'win32' ? 'junction' : 'dir')
}

console.log('install: 已完成，备份在 ' + backupDir)
console.log('install: 请完全退出并重新启动 DSH，新会话里才会出现 scan_project 工具')
console.log('install: 回滚命令：node scripts/install-into-profile.mjs --rollback')
