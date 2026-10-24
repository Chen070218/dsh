#!/usr/bin/env node
/**
 * 发布前检查：确保仓库可以安全公开到 GitHub。
 * 检查项：本机绝对路径、内部用户名、占位符、疑似密钥、被误跟踪的构建产物。
 * 用法：node scripts/check-publication.mjs [--strict]
 *   --strict：占位符也算阻塞（用于真正发布前）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '')
  .filter((file) => !/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(file))

const blocking = []
const warnings = []
// 只认像真凭据的形态（长度更长），并要求不在 tests/ 下（测试会用假密钥做脱敏断言）
const secrets = /sk-[A-Za-z0-9]{20,}|(?:api[_-]?key|password|secret)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/

for (const file of files) {
  let text = ''
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const at = file + ':' + (index + 1)
    if (/[A-Za-z]:\\\\/.test(line) || /\/c\/Users\//.test(line)) blocking.push(at + ' 含本机绝对路径')
    if (!file.startsWith('tests/') && secrets.test(line)) blocking.push(at + ' 疑似密钥/凭据')
    // 检测脚本自身必须包含占位符字面量才能检测它，这里跳过
    const isDetector = file === 'scripts/check-publication.mjs' || file === 'scripts/configure-repository.mjs'
    if (!isDetector && line.includes('your-name')) (strict ? blocking : warnings).push(at + ' 含占位符 your-name')
  })
}

if (files.some((file) => file.startsWith('lib/'))) blocking.push('lib/ 不应被跟踪（构建产物）')
if (files.some((file) => file.includes('node_modules/'))) blocking.push('node_modules/ 不应被跟踪')
if (files.some((file) => file.startsWith('.projectops/'))) blocking.push('.projectops/（本地状态/任务库）不应被跟踪')

for (const item of blocking) console.error('publication: BLOCK ' + item)
for (const item of warnings) console.warn('publication: WARN  ' + item)
console.log('publication: ' + files.length + ' 个受跟踪文件，' + blocking.length + ' 阻塞 / ' + warnings.length + ' 提醒')
process.exitCode = blocking.length === 0 ? 0 : 1
