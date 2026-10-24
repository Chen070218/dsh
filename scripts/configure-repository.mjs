#!/usr/bin/env node
/**
 * 上传 GitHub 前一键配置仓库地址。
 * 用法：node scripts/configure-repository.mjs <github-url-or-owner/repo>
 *   例：node scripts/configure-repository.mjs https://github.com/alice/dsh-projectops
 *       node scripts/configure-repository.mjs alice/dsh-projectops
 * 会更新 package.json 的 repository/homepage/bugs，替换 README 徽章里的占位符，并跑发布前检查。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
if (!input) {
  console.error('用法: node scripts/configure-repository.mjs <https://github.com/owner/repo | owner/repo>')
  process.exit(2)
}

const match = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input.trim())
if (!match) {
  console.error('无法从输入解析 owner/repo: ' + input)
  process.exit(2)
}
const owner = match[1]
const name = match[2]
const slug = owner + '/' + name
const url = 'https://github.com/' + slug

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.repository = { type: 'git', url: 'git+https://github.com/' + slug + '.git' }
pkg.homepage = url + '#readme'
pkg.bugs = { url: url + '/issues' }
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

for (const file of ['README.md', 'README.en.md']) {
  const full = join(root, file)
  let text = ''
  try {
    text = readFileSync(full, 'utf8')
  } catch {
    continue
  }
  const updated = text.replaceAll('github.com/your-name/dsh-projectops', 'github.com/' + slug)
  if (updated !== text) {
    writeFileSync(full, updated, 'utf8')
    console.log('配置: 已更新 ' + file + ' 的徽章/链接')
  }
}

console.log('配置: repository = ' + pkg.repository.url)
console.log('配置: homepage   = ' + pkg.homepage)
console.log('下一步：')
console.log('  git remote add origin ' + url + '.git   # 若尚未添加')
console.log('  git push -u origin main && git push --tags')
console.log('  node scripts/check-publication.mjs --strict')
try {
  console.log(execFileSync(process.execPath, ['scripts/check-publication.mjs', '--strict'], { cwd: root, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim())
} catch (error) {
  console.log(String(error.stdout ?? '').trim())
}
