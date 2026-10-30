#!/usr/bin/env node
/**
 * npm 发布前预检：把"发出去会出问题"的情形提前拦住。
 * 检查：构建产物 → 类型 → 无需宿主的测试 → 打包内容 → 公开性检查 → npm 名称/版本是否已被占用。
 * 用法：node scripts/preflight-publish.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const run = (args, label) => {
  process.stdout.write('· ' + label + ' … ')
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' } })
    console.log('ok')
  } catch (error) {
    console.log('FAIL')
    problems.push(label + ' 失败：' + String(error.stdout ?? error.message).split('\n').slice(-3).join(' '))
  }
}

run(['scripts/build.mjs'], '构建')
if (existsSync(join(root, 'node_modules/typescript/lib/tsc.js'))) run(['node_modules/typescript/lib/tsc.js', '--noEmit', '-p', 'tsconfig.json'], '类型检查')
run(['--test', '--import', './tests/support/runtime-hooks.mjs', 'tests/services.*.test.ts', 'tests/security.*.test.ts', 'tests/util.*.test.ts', 'tests/storage.*.test.ts', 'tests/adapters.*.test.ts', 'tests/tools.*.test.ts', 'tests/i18n.test.ts', 'tests/client.views.test.ts'], '测试（无需宿主）')
run(['scripts/check-pack.mjs'], '打包内容')
run(['scripts/check-publication.mjs', '--strict'], '公开性检查')

// npm 名称 / 版本占用
const registry = 'https://registry.npmjs.org/' + pkg.name
const response = await fetch(registry, { headers: { 'user-agent': 'dsh-projectops' } })
if (response.status === 404) {
  console.log('· npm 名称 ' + pkg.name + ' 可用（尚未发布）')
} else if (response.ok) {
  const meta = await response.json()
  const versions = Object.keys(meta.versions ?? {})
  if (versions.includes(pkg.version)) problems.push('npm 上已存在 ' + pkg.name + '@' + pkg.version + '，请先升版本号')
  else console.log('· npm 名称已属于他人或已发布过，最新版本 ' + (meta['dist-tags']?.latest ?? '?') + '（本次 ' + pkg.version + ' 未被占用）')
} else {
  problems.push('npm registry 查询失败：HTTP ' + response.status)
}

console.log('')
if (problems.length === 0) {
  console.log('预检通过：' + pkg.name + '@' + pkg.version + ' 可以发布')
  console.log('发布方式二选一：')
  console.log('  1) GitHub Actions：仓库 Secrets 配 NPM_TOKEN，然后 Actions → Release → Run workflow')
  console.log('  2) 本地：NPM_TOKEN=xxx npm publish --access public')
} else {
  for (const problem of problems) console.error('预检失败：' + problem)
  process.exitCode = 1
}
