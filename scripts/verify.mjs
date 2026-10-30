#!/usr/bin/env node
/**
 * 一键自检：构建 -> 全量测试 -> CI 子集 -> 三个 demo。
 * 用法：node scripts/verify.mjs
 * 退出码非 0 表示有环节失败（适合本地预提交或接入 CI）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasTypeScript = existsSync(join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'))
const steps = [
  { name: 'build', args: ['scripts/build.mjs'] },
  ...(hasTypeScript ? [{ name: 'typecheck (tsc --noEmit)', args: ['node_modules/typescript/lib/tsc.js', '--noEmit', '-p', 'tsconfig.json'] }] : []),
  { name: 'test (full)', args: ['--test', '--import', './tests/support/runtime-hooks.mjs', 'tests/**/*.test.ts'] },
  {
    name: 'test (ci subset)',
    args: ['--test', '--import', './tests/support/runtime-hooks.mjs',
      'tests/services.*.test.ts', 'tests/security.*.test.ts', 'tests/util.*.test.ts',
      'tests/storage.*.test.ts', 'tests/adapters.*.test.ts', 'tests/tools.*.test.ts',
      'tests/i18n.test.ts', 'tests/client.views.test.ts'],
  },
  { name: 'pack contents', args: ['scripts/check-pack.mjs'] },
  { name: 'demo: scan', args: ['scripts/demo-scan.mjs'] },
  { name: 'demo: analyze', args: ['scripts/demo-analyze.mjs'] },
  { name: 'demo: report', args: ['scripts/demo-report.mjs'] },
]

const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
})

let failed = 0
for (const step of steps) {
  const result = await run(step.args)
  const tail = (result.stdout || result.stderr).trim().split('\n')
  const summary = tail.filter((line) => /^ℹ (tests|pass|fail)|^build:|^written:|^language |^size |^root /.test(line)).join(' | ')
  const ok = result.code === 0
  if (!ok) failed += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + step.name + (summary === '' ? '' : '  ->  ' + summary))
  if (!ok) console.log((result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n'))
}
console.log('')
console.log(failed === 0 ? '全部通过（' + steps.length + ' 个环节）' : failed + ' 个环节失败')
process.exitCode = failed === 0 ? 0 : 1
