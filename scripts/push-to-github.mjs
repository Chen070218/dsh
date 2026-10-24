#!/usr/bin/env node
/**
 * 一键推送到 GitHub：配置仓库元数据 -> 设置 remote -> 推送 main 与标签。
 *
 * 用法：
 *   node scripts/push-to-github.mjs <owner/repo 或 https://github.com/owner/repo>
 *
 * 认证（二选一，脚本不会打印任何凭据）：
 *   - 已配置 Git 凭据管理器 / SSH key：直接运行即可；
 *   - 使用 PAT：先 set GH_TOKEN=ghp_xxx（或 GIT_TOKEN），脚本会用一次性 URL 推送，不写入 git config。
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2]
if (!input) {
  console.error('用法: node scripts/push-to-github.mjs <owner/repo 或 https://github.com/owner/repo>')
  process.exit(2)
}

const match = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input.trim())
if (!match) {
  console.error('无法解析 owner/repo: ' + input)
  process.exit(2)
}
const slug = match[1] + '/' + match[2]
const httpsUrl = 'https://github.com/' + slug + '.git'
const token = process.env.GH_TOKEN ?? process.env.GIT_TOKEN ?? ''
const tokenUrl = token === '' ? '' : 'https://x-access-token:' + token + '@github.com/' + slug + '.git'

const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: options.stdio ?? 'pipe' })

console.log('==> 配置仓库元数据')
execFileSync(process.execPath, ['scripts/configure-repository.mjs', 'https://github.com/' + slug], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' })

console.log('==> 提交元数据变更')
try {
  git(['add', '-A'])
  git(['commit', '-m', 'chore: configure repository metadata for GitHub'])
} catch {
  console.log('    （没有需要提交的变更）')
}

console.log('==> 设置 remote origin')
let hasRemote = true
try {
  git(['remote', 'get-url', 'origin'])
} catch {
  hasRemote = false
}
if (hasRemote) git(['remote', 'set-url', 'origin', httpsUrl])
else git(['remote', 'add', 'origin', httpsUrl])

console.log('==> 推送 main 与标签')
try {
  if (tokenUrl !== '') git(['push', tokenUrl, 'main', '--tags'], { stdio: 'inherit' })
  else git(['push', '-u', 'origin', 'main', '--tags'], { stdio: 'inherit' })
  console.log('完成：https://github.com/' + slug)
  console.log('如果用了 PAT，请记得把 remote 指回无凭据地址：git remote set-url origin ' + httpsUrl)
} catch {
  console.error('推送失败。常见原因：')
  console.error('  1) 仓库还不存在 —— 先在 GitHub 上创建一个空仓库（不要勾 README / .gitignore）')
  console.error('  2) 没有认证 —— 配置 Git 凭据管理器，或设置 GH_TOKEN=<PAT> 后重试')
  console.error('  3) SSH key 未注册 —— 把 ~/.ssh/id_ed25519.pub 内容加到 GitHub Settings → SSH keys')
  process.exit(1)
}
