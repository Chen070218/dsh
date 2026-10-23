#!/usr/bin/env node
/**
 * 覆盖率门槛：跑无宿主依赖的测试子集，解析 Node --experimental-test-coverage 的 "all files" 行，
 * 低于阈值（默认 80%）则退出码 1。用法：node scripts/check-coverage.mjs [阈值]
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const min = Number(process.argv[2] ?? 80)
if (!Number.isFinite(min)) {
  console.error('check-coverage: 阈值必须是数字')
  process.exit(2)
}

const globs = [
  'tests/services.*.test.ts',
  'tests/security.*.test.ts',
  'tests/util.*.test.ts',
  'tests/storage.*.test.ts',
  'tests/adapters.*.test.ts',
  'tests/tools.*.test.ts',
]

const child = spawn(process.execPath, ['--test', '--experimental-test-coverage', '--import', './tests/support/runtime-hooks.mjs', ...globs], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk) => { output += String(chunk) })
child.stderr.on('data', (chunk) => { output += String(chunk) })
child.on('close', (code) => {
  const row = output.split('\n').find((line) => /^ℹ all files\s*\|/.test(line))
  if (code !== 0 || row === undefined) {
    console.error('check-coverage: 测试失败或没有覆盖率输出')
    console.error(output.split('\n').slice(-8).join('\n'))
    process.exit(1)
  }
  const columns = row.split('|').map((part) => part.trim())
  const statements = Number(columns[1])
  const branches = Number(columns[2])
  const functions = Number(columns[3])
  console.log('coverage: statements ' + statements + '% / branches ' + branches + '% / functions ' + functions + '%（门槛 ' + min + '% statements）')
  process.exit(statements >= min ? 0 : 1)
})
